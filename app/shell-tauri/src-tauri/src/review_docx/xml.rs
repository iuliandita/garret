use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use std::collections::BTreeMap;

pub(super) const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
pub(super) const XML: &str = "http://www.w3.org/XML/1998/namespace";
pub(super) const REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
pub(super) const CT: &str = "http://schemas.openxmlformats.org/package/2006/content-types";

#[derive(Debug, Clone)]
pub(super) struct Element {
    pub ns: String,
    pub name: String,
    pub attrs: BTreeMap<(String, String), String>,
    pub children: Vec<Element>,
    pub text: String,
}
impl Element {
    pub fn is(&self, ns: &str, name: &str) -> bool {
        self.ns == ns && self.name == name
    }
    pub fn attr(&self, ns: &str, name: &str) -> Option<&str> {
        self.attrs
            .get(&(ns.into(), name.into()))
            .map(String::as_str)
    }
    pub fn required(&self, ns: &str, name: &str) -> Result<&str, String> {
        self.attr(ns, name)
            .ok_or_else(|| format!("{}: missing {name}", self.name))
    }
    pub fn only_attrs(&self, allowed: &[(&str, &str)]) -> Result<(), String> {
        if self
            .attrs
            .keys()
            .any(|(ns, name)| !allowed.iter().any(|(a, b)| ns == a && name == b))
        {
            return Err(format!("{}: unsupported attribute", self.name));
        }
        Ok(())
    }
    pub fn structural(&self) -> Result<(), String> {
        if !self.text.trim().is_empty() {
            return Err(format!("{}: unexpected text", self.name));
        }
        Ok(())
    }
    pub fn leaf(&self) -> Result<(), String> {
        if !self.children.is_empty() || !self.text.is_empty() {
            return Err(format!("{}: expected empty element", self.name));
        }
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct Budget {
    pub elements: usize,
    pub bytes: usize,
    pub revisions: usize,
    pub comments: usize,
}

pub(super) fn valid_chars(text: &str) -> bool {
    text.chars().all(|ch| {
        matches!(ch, '\t' | '\n' | '\r')
            || ('\u{20}'..='\u{d7ff}').contains(&ch)
            || ('\u{e000}'..='\u{fffd}').contains(&ch)
            || ch >= '\u{10000}'
    })
}
pub(super) fn escape(text: &str) -> Result<String, String> {
    if !valid_chars(text) {
        return Err("XML-illegal character".into());
    }
    Ok(text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('\r', "&#13;"))
}
fn namespace(ns: ResolveResult<'_>) -> Result<String, String> {
    match ns {
        ResolveResult::Unbound => Ok(String::new()),
        ResolveResult::Bound(value) => std::str::from_utf8(value.as_ref())
            .map(str::to_string)
            .map_err(|_| "invalid namespace UTF-8".into()),
        ResolveResult::Unknown(_) => Err("undeclared XML namespace".into()),
    }
}
fn append(
    stack: &mut [Element],
    root: &mut Option<Element>,
    element: Element,
) -> Result<(), String> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(element);
    } else if root.replace(element).is_some() {
        return Err("multiple XML roots".into());
    }
    Ok(())
}
pub(super) fn parse(bytes: &[u8], budget: &mut Budget) -> Result<Element, String> {
    if bytes.len() > super::zip::MAX_XML {
        return Err("XML part exceeds limit".into());
    }
    budget.bytes += bytes.len();
    if budget.bytes > 64 * 1024 * 1024 {
        return Err("package XML exceeds limit".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "XML is not UTF-8")?;
    if !valid_chars(text) {
        return Err("XML-illegal character".into());
    }
    let mut reader = NsReader::from_str(text);
    reader.config_mut().check_end_names = true;
    let mut stack: Vec<Element> = Vec::new();
    let mut root = None;
    let mut declared = false;
    loop {
        let event = reader
            .read_event()
            .map_err(|e| format!("malformed XML: {e}"))?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                budget.elements += 1;
                if budget.elements > 250_000 || stack.len() >= 256 {
                    return Err("XML complexity limit".into());
                }
                let (ns, local) = reader.resolver().resolve_element(e.name());
                let ns = namespace(ns)?;
                let name = std::str::from_utf8(local.as_ref())
                    .map_err(|_| "invalid XML name")?
                    .to_string();
                if ns == W && matches!(name.as_str(), "ins" | "del" | "rPrChange") {
                    budget.revisions += 1;
                    if budget.revisions > 4096 {
                        return Err("too many package revisions".into());
                    }
                }
                if ns == W && name == "comment" {
                    budget.comments += 1;
                    if budget.comments > 2000 {
                        return Err("too many package comments".into());
                    }
                }
                let mut attrs = BTreeMap::new();
                for a in e.attributes() {
                    let a = a.map_err(|e| format!("invalid XML attribute: {e}"))?;
                    if a.key.as_ref() == b"xmlns" || a.key.as_ref().starts_with(b"xmlns:") {
                        continue;
                    }
                    let (ns, local) = reader.resolver().resolve_attribute(a.key);
                    let key = (
                        namespace(ns)?,
                        std::str::from_utf8(local.as_ref())
                            .map_err(|_| "invalid attribute name")?
                            .to_string(),
                    );
                    let value = a
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            reader.decoder(),
                        )
                        .map_err(|e| format!("invalid XML attribute value: {e}"))?
                        .into_owned();
                    if !valid_chars(&value) || attrs.insert(key, value).is_some() {
                        return Err("invalid or duplicate expanded XML attribute".into());
                    }
                }
                let element = Element {
                    ns,
                    name,
                    attrs,
                    children: Vec::new(),
                    text: String::new(),
                };
                if matches!(event, Event::Empty(_)) {
                    append(&mut stack, &mut root, element)?;
                } else {
                    stack.push(element);
                }
            }
            Event::End(_) => {
                let element = stack.pop().ok_or("unexpected XML close")?;
                append(&mut stack, &mut root, element)?;
            }
            Event::Text(value) => {
                let value = value.xml10_content().map_err(|_| "invalid XML text")?;
                if let Some(parent) = stack.last_mut() {
                    parent.text.push_str(&value);
                } else if !value.trim().is_empty() {
                    return Err("text outside XML root".into());
                }
            }
            Event::GeneralRef(value) => {
                let raw = value.decode().map_err(|_| "invalid XML reference")?;
                let decoded = quick_xml::escape::unescape(&format!("&{raw};"))
                    .map_err(|_| "unsupported XML entity")?
                    .into_owned();
                if !valid_chars(&decoded) {
                    return Err("XML-illegal reference".into());
                }
                stack
                    .last_mut()
                    .ok_or("reference outside XML root")?
                    .text
                    .push_str(&decoded);
            }
            Event::Decl(decl) => {
                if declared
                    || root.is_some()
                    || !stack.is_empty()
                    || decl
                        .version()
                        .map_err(|_| "invalid XML declaration")?
                        .as_ref()
                        != b"1.0"
                {
                    return Err("unsupported XML declaration".into());
                }
                if decl
                    .encoding()
                    .transpose()
                    .map_err(|_| "invalid XML encoding")?
                    .is_some_and(|encoding| !encoding.eq_ignore_ascii_case(b"UTF-8"))
                {
                    return Err("XML must declare UTF-8".into());
                }
                declared = true;
            }
            Event::Comment(_) => {}
            Event::Eof => break,
            _ => {
                return Err(
                    "DTD, processing instructions and CDATA are not supported in review XML".into(),
                )
            }
        }
    }
    if !stack.is_empty() {
        return Err("unclosed XML elements".into());
    }
    root.ok_or("missing XML root".into())
}
