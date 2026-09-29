// app/shell-tauri/src-tauri/src/store/dict.rs
// A project's own spelling wordlist, so an invented name reaches every
// document in THIS manuscript and none outside it. See commands/spell.rs for
// why enchant's machine-global personal wordlist cannot do this, and for how a
// project's list is rendered out to the checker.
//
// LIVES IN THE PROJECT, deliberately, the way prose and comments do: the point
// is that the list travels with the file rather than sitting beside the
// machine. A `meta` row would have worked for a scalar, the way the daily
// target and its baseline do, but this is a set of unbounded size, and a set
// belongs in a table with one row per member -- a `meta` row holding a
// growing joined string would need its own escaping and its own parser for
// something SQLite already gives a PRIMARY KEY for free.
use super::{now_ms, Result, Store, StoreError};
use serde::Serialize;

/// v5 adds the project's own spelling wordlist. ADDITIVE ONLY -- one table,
/// nothing in v1 through v4 changes shape, so a project carries its prose, its
/// history, its revision states and its comments forward untouched.
///
/// UNIQUE on `word`, case-sensitively: enchant's own `.dic` file is a set of
/// exact strings, one per line, and a project's list should refuse the same
/// duplicate enchant would silently absorb, so `dict_add` can report it rather
/// than the writer wondering why nothing changed.
///
/// NO CHECK CONSTRAINT on the word's shape, for the reason SCHEMA_V3 and
/// SCHEMA_V4 both record: `dict_add` is the only writer, it refuses an empty
/// word before any row moves, and SQLite cannot alter a CHECK -- a constraint
/// here would make the next rule change a whole-table rebuild.
pub const SCHEMA_V5: &str = "
CREATE TABLE dict_word (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  word       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
";

/// One word on the project's list, as the page reads it. snake_case by the
/// recorded rule: command ARGUMENTS are camelCase, returned struct fields are
/// not.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DictWord {
    pub id: i64,
    pub word: String,
    pub created_at: i64,
}

impl Store {
    /// Every word on this project's list, alphabetically -- the order the panel
    /// shows it in, so the panel does no sorting of its own and cannot disagree
    /// with what the file says.
    pub fn dict_words(&self) -> Result<Vec<DictWord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, word, created_at FROM dict_word ORDER BY word ASC")?;
        let rows = stmt.query_map([], |r| {
            Ok(DictWord {
                id: r.get(0)?,
                word: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Add one word to this project's list.
    ///
    /// REFUSES AN EMPTY WORD, trimmed first: a blank entry would sit in the
    /// panel and in every `.dic` file this project ever renders, saying
    /// nothing.
    ///
    /// REFUSES A DUPLICATE, named rather than left to a raw constraint error: a
    /// writer who adds a name already on the list should hear "already there",
    /// not a SQLite error string.
    pub fn dict_add(&self, word: &str) -> Result<DictWord> {
        let word = word.trim();
        if word.is_empty() {
            return Err(StoreError::EmptyWord);
        }
        if self.dict_contains(word)? {
            return Err(StoreError::DuplicateWord {
                word: word.to_string(),
            });
        }
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO dict_word (word, created_at) VALUES (?1, ?2)",
            rusqlite::params![word, now],
        )?;
        Ok(DictWord {
            id: self.conn.last_insert_rowid(),
            word: word.to_string(),
            created_at: now,
        })
    }

    /// Take one word off this project's list.
    ///
    /// NAMED BY THE WORD, not an id: the panel lists words, not row ids, and a
    /// remove that raced an add elsewhere would still name the right word to
    /// take back out.
    pub fn dict_remove(&self, word: &str) -> Result<()> {
        let changed = self
            .conn
            .execute("DELETE FROM dict_word WHERE word = ?1", [word])?;
        if changed == 0 {
            return Err(StoreError::UnknownWord {
                word: word.to_string(),
            });
        }
        Ok(())
    }

    fn dict_contains(&self, word: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM dict_word WHERE word = ?1",
                [word],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        (dir, store)
    }

    #[test]
    fn a_word_can_be_added_listed_and_removed() {
        let (_dir, store) = store();
        assert!(store.dict_words().unwrap().is_empty());
        let added = store.dict_add("Zorbulax").unwrap();
        assert_eq!(added.word, "Zorbulax");
        assert_eq!(
            store
                .dict_words()
                .unwrap()
                .iter()
                .map(|w| &w.word)
                .collect::<Vec<_>>(),
            vec!["Zorbulax"],
        );
        store.dict_remove("Zorbulax").unwrap();
        assert!(store.dict_words().unwrap().is_empty());
    }

    #[test]
    fn the_list_survives_a_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.db");
        {
            let store = Store::open(&path).unwrap();
            store.dict_add("Kethrani").unwrap();
        }
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened
                .dict_words()
                .unwrap()
                .iter()
                .map(|w| &w.word)
                .collect::<Vec<_>>(),
            vec!["Kethrani"],
        );
    }

    #[test]
    fn words_come_back_alphabetically() {
        let (_dir, store) = store();
        for word in ["Zorbulax", "Amberline", "Mireth"] {
            store.dict_add(word).unwrap();
        }
        assert_eq!(
            store
                .dict_words()
                .unwrap()
                .iter()
                .map(|w| w.word.as_str())
                .collect::<Vec<_>>(),
            vec!["Amberline", "Mireth", "Zorbulax"],
        );
    }

    #[test]
    fn an_empty_or_blank_word_is_refused() {
        let (_dir, store) = store();
        for input in ["", "   "] {
            match store.dict_add(input) {
                Err(StoreError::EmptyWord) => {}
                other => panic!("expected EmptyWord, got {other:?}"),
            }
        }
        assert!(store.dict_words().unwrap().is_empty());
    }

    #[test]
    fn a_word_is_trimmed_before_it_is_stored() {
        let (_dir, store) = store();
        let added = store.dict_add("  Kethrani  ").unwrap();
        assert_eq!(added.word, "Kethrani");
    }

    #[test]
    fn a_duplicate_word_is_refused_and_named() {
        let (_dir, store) = store();
        store.dict_add("Zorbulax").unwrap();
        match store.dict_add("Zorbulax") {
            Err(StoreError::DuplicateWord { word }) => assert_eq!(word, "Zorbulax"),
            other => panic!("expected DuplicateWord, got {other:?}"),
        }
        assert_eq!(store.dict_words().unwrap().len(), 1);
    }

    #[test]
    fn removing_a_word_not_on_the_list_is_refused_and_named() {
        let (_dir, store) = store();
        match store.dict_remove("Nobody") {
            Err(StoreError::UnknownWord { word }) => assert_eq!(word, "Nobody"),
            other => panic!("expected UnknownWord, got {other:?}"),
        }
    }

    #[test]
    fn a_word_in_project_a_is_absent_from_project_b() {
        let dir = tempdir().unwrap();
        let a = Store::open(&dir.path().join("a.db")).unwrap();
        let b = Store::open(&dir.path().join("b.db")).unwrap();
        a.dict_add("Zorbulax").unwrap();
        assert_eq!(a.dict_words().unwrap().len(), 1);
        assert!(b.dict_words().unwrap().is_empty());
    }
}
