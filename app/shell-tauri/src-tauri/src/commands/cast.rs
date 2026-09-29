// app/shell-tauri/src-tauri/src/commands/cast.rs
// The characters, places and points of interest, as the page reaches them.
//
// THIN, DELIBERATELY, exactly as `commands/synopsis.rs` is. A
// `#[tauri::command]` cannot be unit-tested, so everything worth a test lives in
// a free function the tests can reach -- here `Store::cast_list`,
// `Store::cast_create`, `Store::cast_set` and `Store::cast_remove`, whose
// refusals, trimming and field normalisation are all covered in
// `store/cast.rs`. Nothing decides anything here.
//
// `cast_set_wire_error` IS THE ONE EXCEPTION, and it decides something
// narrow: which of `cast_set`'s refusals get an ERROR IDENTITY on the wire
// rather than English prose. Host-string handling
// left "every Tauri command error" on the roadmap, needing "a decision about
// error IDENTITY (a kind plus arguments) before it needs a catalog" -- this is
// that decision, taken for the three alias refusals only, because the page
// promises a specific sentence for each rather than the generic "could not
// save". A Tauri command answers `Err(String)`, so the identity travels as
// JSON text (`{"code": ..., "alias": ...}`) rather than a second command
// return type; the page parses it and falls back to the plain sentence for
// everything else, `cast_set`'s five OTHER refusals included.
use crate::{locked, open_project, store, StoreState};
use serde::Serialize;
use tauri::State;

/// One of `cast_set`'s three alias refusals, on the wire. `code` is the
/// contract; `alias` is what the sentence built from it needs to quote.
#[derive(Serialize)]
struct AliasRefusal<'a> {
    code: &'static str,
    alias: &'a str,
}

/// `cast_set`'s error, as the page will see it: JSON naming the refusal for
/// the three alias cases, `StoreError`'s own `Display` sentence otherwise.
///
/// SEPARATE FROM THE COMMAND, `store/cast.rs`'s own reason for `normalise`
/// and `normalise_aliases`: a `#[tauri::command]` cannot be unit-tested, and
/// the wire shape is exactly the kind of thing a rename should have to fail a
/// test to change.
pub(crate) fn cast_set_wire_error(e: &store::StoreError) -> String {
    let refusal = match e {
        store::StoreError::AliasTooShort { alias } => Some(AliasRefusal {
            code: "alias_too_short",
            alias,
        }),
        store::StoreError::AliasIsName { alias } => Some(AliasRefusal {
            code: "alias_is_name",
            alias,
        }),
        store::StoreError::AliasRepeated { alias } => Some(AliasRefusal {
            code: "alias_repeated",
            alias,
        }),
        _ => None,
    };
    match refusal {
        // `AliasRefusal` is two string fields with no way to fail encoding.
        Some(r) => serde_json::to_string(&r).expect("AliasRefusal always serializes"),
        None => e.to_string(),
    }
}

/// Everyone and everywhere, with their detail, in the file's order. The page
/// groups it by kind for display; this is not that order and does not try to be.
#[command_boundary::command]
pub(crate) fn cast_list(
    state: State<'_, StoreState>,
) -> std::result::Result<Vec<store::cast::CastMember>, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .cast_list()
        .map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn cast_deleted(
    state: State<'_, StoreState>,
) -> std::result::Result<Vec<store::cast::CastMember>, String> {
    let guard = locked(&state);
    open_project(&guard)?.store.cast_deleted().map_err(|e| e.to_string())
}

#[command_boundary::command]
pub(crate) fn cast_restore(
    state: State<'_, StoreState>,
    id: String,
) -> std::result::Result<store::cast::CastMember, String> {
    let guard = locked(&state);
    open_project(&guard)?.store.cast_restore(&id).map_err(|e| e.to_string())
}

/// Add somebody, somewhere or something, by kind and name alone. The detail
/// follows through `cast_set`.
#[command_boundary::command]
pub(crate) fn cast_create(
    state: State<'_, StoreState>,
    kind: String,
    name: String,
) -> std::result::Result<store::cast::CastMember, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .cast_create(&kind, &name)
        .map_err(|e| e.to_string())
}

/// Write the whole member in one act: its kind, its name, its summary, its
/// entire field list AND its entire alias list. Both lists REPLACE what was
/// there, so a shorter one is how an entry is deleted and there is no second
/// command for it.
#[command_boundary::command]
pub(crate) fn cast_set(
    state: State<'_, StoreState>,
    id: String,
    kind: String,
    name: String,
    summary: String,
    fields: Vec<store::cast::CastField>,
    aliases: Vec<String>,
) -> std::result::Result<store::cast::CastMember, String> {
    let guard = locked(&state);
    open_project(&guard)?
        .store
        .cast_set(&id, &kind, &name, &summary, &fields, &aliases)
        .map_err(|e| cast_set_wire_error(&e))
}

/// Hide a cast member, retaining its fields, appearances, and original picture.
#[command_boundary::command]
pub(crate) fn cast_remove(
    state: State<'_, StoreState>,
    id: String,
) -> std::result::Result<(), String> {
    let guard = locked(&state);
    open_project(&guard)?.store.cast_remove(&id).map_err(|e| e.to_string())
}

/// What to show for one member's picture: a state word and, when there is one,
/// a data URI of the THUMBNAIL.
///
/// PER MEMBER AND NOT PER LIST. The panel shows a form for the ONE entry the
/// writer selected, so this is called once per selection and the page holds at
/// most one thumbnail. A list-shaped answer would put every picture in the book
/// into the web process at once, which is the memory rule this slice exists to
/// keep -- see `crate::pictures`.
#[command_boundary::command]
pub(crate) fn cast_picture_view(
    state: State<'_, StoreState>,
    id: String,
) -> std::result::Result<crate::pictures::PictureView, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    let dir = crate::pictures::dir_for(&project.path);
    let member = project
        .store
        .cast_list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("no cast member {id}"))?;
    Ok(crate::pictures::view(&dir, member.picture_path.as_deref()))
}

/// One member's picture at `pictures::FULL_MAX`, for the viewer.
///
/// SLICE 038 RECORDED THAT THERE WAS NO WAY TO SEE A PICTURE FULL SIZE, and this
/// is that gap closed -- once, for a cast photograph and a cover alike, through
/// one host function and one page unit. Two viewers would have been two answers
/// to how big "full size" is and two places the memory bound could be forgotten.
///
/// ON DEMAND AND NEVER WITH THE PANEL, for `cast_picture_view`'s reason one size
/// up: the thumbnail is kilobytes and this is megabytes, so sending it with the
/// panel would charge every writer who merely opened it for a look nobody took.
#[command_boundary::command]
pub(crate) fn cast_picture_full(
    state: State<'_, StoreState>,
    id: String,
) -> std::result::Result<crate::pictures::PictureView, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    let dir = crate::pictures::dir_for(&project.path);
    let member = project
        .store
        .cast_list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("no cast member {id}"))?;
    Ok(crate::pictures::full(&dir, member.picture_path.as_deref()))
}

/// Take the picture off a member, and delete the files it named.
///
/// ITS OWN COMMAND rather than an argument to `cast_set`, for the reason
/// `store::cast_set_picture` exists at all: the panel's Save must not be able to
/// carry a picture, correctly or otherwise.
#[command_boundary::command]
pub(crate) fn cast_picture_clear(
    state: State<'_, StoreState>,
    id: String,
) -> std::result::Result<store::cast::CastMember, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    let dir = crate::pictures::dir_for(&project.path);
    let (previous, member) = project
        .store
        .cast_set_picture(&id, None)
        .map_err(|e| e.to_string())?;
    if let Some(name) = previous {
        crate::pictures::remove(&dir, &name);
    }
    Ok(member)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::StoreError;

    /// The wire contract itself: a rename of any of these three exact
    /// strings breaks the page's classification silently unless this test
    /// catches it first -- `cast-panel.ts`'s `ALIAS_REFUSAL_KEYS` restates
    /// them on the other side.
    #[test]
    fn each_alias_refusal_carries_its_own_code_and_the_offending_alias() {
        assert_eq!(
            cast_set_wire_error(&StoreError::AliasTooShort { alias: "Il".into() }),
            r#"{"code":"alias_too_short","alias":"Il"}"#
        );
        assert_eq!(
            cast_set_wire_error(&StoreError::AliasIsName {
                alias: "Ilse".into()
            }),
            r#"{"code":"alias_is_name","alias":"Ilse"}"#
        );
        assert_eq!(
            cast_set_wire_error(&StoreError::AliasRepeated {
                alias: "Ils".into()
            }),
            r#"{"code":"alias_repeated","alias":"Ils"}"#
        );
    }

    /// A QUOTE OR A BACKSLASH IN THE ALIAS is exactly what a hand-rolled
    /// string would mishandle -- `serde_json` escapes it, and the page's own
    /// `JSON.parse` is what undoes the escaping, so the alias a writer typed
    /// survives the round trip byte for byte.
    #[test]
    fn an_alias_holding_a_quote_survives_the_round_trip() {
        let wire = cast_set_wire_error(&StoreError::AliasRepeated {
            alias: "he said \"hi\"".into(),
        });
        let back: serde_json::Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(back["code"], "alias_repeated");
        assert_eq!(back["alias"], "he said \"hi\"");
    }

    /// EVERY OTHER REFUSAL KEEPS ITS ENGLISH SENTENCE, unchanged: the JSON
    /// shape is for the three alias cases only, and a refusal outside them
    /// must still read as prose to the generic "could not save" notice.
    #[test]
    fn a_non_alias_refusal_is_unchanged() {
        assert_eq!(
            cast_set_wire_error(&StoreError::EmptyCastName),
            StoreError::EmptyCastName.to_string()
        );
    }
}
