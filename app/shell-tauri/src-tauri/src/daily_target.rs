use serde::{Deserialize, Serialize};

/// How many words a day the writer is aiming for. A property of the writer's
/// practice rather than of a manuscript, which is why it lives in this file and
/// not in the project's own `meta` table beside the day's baseline: "I write 500
/// words a day" survives starting a new book.
///
/// Stored as `off` or a canonical decimal string from 1 through 1,000,000.
/// The existing presets retain their variants and wire spellings.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum DailyTarget {
    #[default]
    Off,
    W250,
    W500,
    W1000,
    W2000,
    Custom(u32),
}

impl DailyTarget {
    /// The spelling the settings file and the page both use.
    pub fn as_str(self) -> std::borrow::Cow<'static, str> {
        use std::borrow::Cow::{Borrowed, Owned};
        match self {
            DailyTarget::Off => Borrowed("off"),
            DailyTarget::W250 => Borrowed("250"),
            DailyTarget::W500 => Borrowed("500"),
            DailyTarget::W1000 => Borrowed("1000"),
            DailyTarget::W2000 => Borrowed("2000"),
            DailyTarget::Custom(words) => Owned(words.to_string()),
        }
    }

    /// Refuse noncanonical spellings so one preference has one encoding.
    pub fn parse(s: &str) -> Option<DailyTarget> {
        match s {
            "off" => Some(DailyTarget::Off),
            "250" => Some(DailyTarget::W250),
            "500" => Some(DailyTarget::W500),
            "1000" => Some(DailyTarget::W1000),
            "2000" => Some(DailyTarget::W2000),
            _ => {
                if s.starts_with('0') || !s.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                let words = s.parse::<u32>().ok()?;
                (1..=1_000_000)
                    .contains(&words)
                    .then_some(DailyTarget::Custom(words))
            }
        }
    }
}

impl Serialize for DailyTarget {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str().as_ref())
    }
}

impl<'de> Deserialize<'de> for DailyTarget {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).ok_or_else(|| serde::de::Error::custom("invalid daily target"))
    }
}
