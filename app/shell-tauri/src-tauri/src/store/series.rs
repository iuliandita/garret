use super::{Result, Store, StoreError};
use serde::{Deserialize, Serialize};

pub const KEY: &str = "library_membership";
const VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Membership {
    pub version: u8,
    pub series: Option<Group>,
    pub universe: Option<Group>,
}

impl Default for Membership {
    fn default() -> Self {
        Self {
            version: VERSION,
            series: None,
            universe: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GroupEdit {
    None,
    Existing { id: String, name: String },
    New { name: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MembershipEdit {
    pub series: GroupEdit,
    pub universe: GroupEdit,
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn checked_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 120 || trimmed.chars().any(char::is_control)
    {
        return Err(StoreError::InvalidPlanning(
            "a series or universe name must contain 1–120 printable characters".into(),
        ));
    }
    Ok(trimmed.to_string())
}

fn validate(group: &Option<Group>) -> Result<()> {
    if let Some(group) = group {
        if !valid_id(&group.id)
            || checked_name(&group.name).is_err()
            || group.name != group.name.trim()
        {
            return Err(StoreError::Corrupt(
                "library membership has an invalid group".into(),
            ));
        }
    }
    Ok(())
}

fn resolve(edit: GroupEdit) -> Result<Option<Group>> {
    match edit {
        GroupEdit::None => Ok(None),
        GroupEdit::Existing { id, name } => {
            if !valid_id(&id) {
                return Err(StoreError::InvalidPlanning("group ID is invalid".into()));
            }
            Ok(Some(Group {
                id,
                name: checked_name(&name)?,
            }))
        }
        GroupEdit::New { name } => Ok(Some(Group {
            id: uuid::Uuid::now_v7().simple().to_string(),
            name: checked_name(&name)?,
        })),
    }
}

impl Store {
    pub fn membership(&self) -> Result<Membership> {
        let Some(raw) = self.get_meta(KEY)? else {
            return Ok(Membership::default());
        };
        if raw.len() > 2048 {
            return Err(StoreError::Corrupt(
                "library membership is too large".into(),
            ));
        }
        let value: Membership = serde_json::from_str(&raw)
            .map_err(|_| StoreError::Corrupt("library membership is malformed".into()))?;
        if value.version != VERSION {
            return Err(StoreError::Corrupt(format!(
                "library membership version {} is unsupported",
                value.version
            )));
        }
        validate(&value.series)?;
        validate(&value.universe)?;
        Ok(value)
    }

    pub fn membership_set(&self, edit: MembershipEdit) -> Result<Membership> {
        self.membership()?;
        let value = Membership {
            version: VERSION,
            series: resolve(edit.series)?,
            universe: resolve(edit.universe)?,
        };
        let raw = serde_json::to_string(&value).map_err(|_| {
            StoreError::Corrupt("library membership could not be serialized".into())
        })?;
        self.set_meta(KEY, &raw)?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn absent_and_malformed_memberships_are_distinct_and_bad_data_is_not_overwritten() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        assert_eq!(store.membership().unwrap(), Membership::default());
        store
            .set_meta(KEY, r#"{"version":2,"series":null,"universe":null}"#)
            .unwrap();
        assert!(store
            .membership_set(MembershipEdit {
                series: GroupEdit::None,
                universe: GroupEdit::None
            })
            .is_err());
        assert!(store
            .get_meta(KEY)
            .unwrap()
            .unwrap()
            .contains("\"version\":2"));
    }

    #[test]
    fn existing_id_is_reused_and_new_name_mints_even_when_identical() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let first = store
            .membership_set(MembershipEdit {
                series: GroupEdit::New { name: "A".into() },
                universe: GroupEdit::None,
            })
            .unwrap();
        let first_id = first.series.unwrap().id;
        let retained = store
            .membership_set(MembershipEdit {
                series: GroupEdit::Existing {
                    id: first_id.clone(),
                    name: "A".into(),
                },
                universe: GroupEdit::None,
            })
            .unwrap();
        assert_eq!(retained.series.unwrap().id, first_id);
        let new = store
            .membership_set(MembershipEdit {
                series: GroupEdit::New { name: "A".into() },
                universe: GroupEdit::None,
            })
            .unwrap();
        assert_ne!(new.series.unwrap().id, first_id);
    }
}
