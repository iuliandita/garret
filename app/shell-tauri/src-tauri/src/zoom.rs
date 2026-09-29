//! Interface zoom: one of five words in `settings.json`, applied by the host
//! as WebKit page zoom. A fact about the MACHINE, never about a book: a
//! manuscript opened on a laptop must not arrive at 175%.
//!
//! Words rather than a float, `DailyTarget`'s shape: a 1.37 in the file is a
//! value the next launch might not understand, and a 3% zoom is not a
//! preference anyone holds. Lenient on read like every other field, and for
//! the same reason -- `read_settings` maps a failed parse to defaults for the
//! WHOLE file, so one bad value would discard `last_project` too.

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Zoom {
    #[default]
    #[serde(rename = "100")]
    Z100,
    #[serde(rename = "125")]
    Z125,
    #[serde(rename = "150")]
    Z150,
    #[serde(rename = "175")]
    Z175,
    #[serde(rename = "200")]
    Z200,
}

impl Zoom {
    pub const ALL: [Zoom; 5] = [Zoom::Z100, Zoom::Z125, Zoom::Z150, Zoom::Z175, Zoom::Z200];

    pub fn as_str(self) -> &'static str {
        match self {
            Zoom::Z100 => "100",
            Zoom::Z125 => "125",
            Zoom::Z150 => "150",
            Zoom::Z175 => "175",
            Zoom::Z200 => "200",
        }
    }

    pub fn parse(s: &str) -> Option<Zoom> {
        Zoom::ALL.into_iter().find(|z| z.as_str() == s)
    }

    /// What `WebviewWindow::set_zoom` takes.
    pub fn factor(self) -> f64 {
        match self {
            Zoom::Z100 => 1.0,
            Zoom::Z125 => 1.25,
            Zoom::Z150 => 1.5,
            Zoom::Z175 => 1.75,
            Zoom::Z200 => 2.0,
        }
    }
}

pub fn lenient_zoom<'de, D>(d: D) -> Result<Zoom, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(raw.as_str().and_then(Zoom::parse).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::Zoom;

    #[test]
    fn every_word_round_trips_and_the_default_is_one_hundred() {
        for z in Zoom::ALL {
            assert_eq!(Zoom::parse(z.as_str()), Some(z));
        }
        assert_eq!(Zoom::default(), Zoom::Z100);
        assert_eq!(Zoom::default().factor(), 1.0);
    }

    #[test]
    fn a_word_this_build_does_not_know_is_refused_not_rounded() {
        assert_eq!(Zoom::parse("110"), None);
        assert_eq!(Zoom::parse("1.5"), None);
        assert_eq!(Zoom::parse(""), None);
    }

    #[test]
    fn factors_are_the_words_over_one_hundred() {
        assert_eq!(Zoom::Z125.factor(), 1.25);
        assert_eq!(Zoom::Z200.factor(), 2.0);
    }

    #[test]
    fn a_bad_value_in_the_file_reads_as_the_default() {
        #[derive(serde::Deserialize)]
        struct Holder {
            #[serde(default, deserialize_with = "super::lenient_zoom")]
            zoom: Zoom,
        }
        for raw in [r#"{"zoom": 7}"#, r#"{"zoom": "big"}"#, r#"{"zoom": null}"#, r#"{}"#] {
            let h: Holder = serde_json::from_str(raw).unwrap();
            assert_eq!(h.zoom, Zoom::Z100, "{raw}");
        }
        let h: Holder = serde_json::from_str(r#"{"zoom": "150"}"#).unwrap();
        assert_eq!(h.zoom, Zoom::Z150);
    }
}
