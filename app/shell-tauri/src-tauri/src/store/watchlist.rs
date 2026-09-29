use super::Store;
use serde::{Deserialize, Serialize};

const KEY: &str = "craft.watchlist";
const VERSION: u32 = 1;
const MAX_TERMS: usize = 200;
const MAX_SCALARS: usize = 200;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Term {
    pub text: String,
    pub mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Document {
    version: u32,
    terms: Vec<Term>,
}

fn checked(terms: &[Term]) -> Result<(), String> {
    if terms.len() > MAX_TERMS {
        return Err("watchlist has too many terms".into());
    }
    for term in terms {
        if term.text.trim().is_empty()
            || term.text.chars().count() > MAX_SCALARS
            || !matches!(term.mode.as_str(), "literal" | "folded")
        {
            return Err("watchlist term is empty, too long, or has an unknown mode".into());
        }
    }
    Ok(())
}

impl Store {
    pub fn craft_watchlist(&self) -> Result<Vec<Term>, String> {
        let Some(raw) = self.get_meta(KEY).map_err(|e| e.to_string())? else {
            return Ok(Vec::new());
        };
        let doc: Document = serde_json::from_str(&raw)
            .map_err(|_| "watchlist metadata is malformed; original bytes were preserved")?;
        if doc.version != VERSION {
            return Err("watchlist version is unsupported; original bytes were preserved".into());
        }
        checked(&doc.terms)?;
        Ok(doc.terms)
    }

    pub fn craft_watchlist_set(&self, terms: &[Term]) -> Result<(), String> {
        self.craft_watchlist()?;
        checked(terms)?;
        let raw = serde_json::to_string(&Document {
            version: VERSION,
            terms: terms.to_vec(),
        })
        .map_err(|e| e.to_string())?;
        self.set_meta(KEY, &raw).map_err(|e| e.to_string())
    }
}
