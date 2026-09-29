// app/shell-tauri/src-tauri/src/commands/identity.rs
// The identity vault and the project's pin, as the page reaches them.
//
// THIN, DELIBERATELY, exactly as `commands/covers.rs` and `commands/design.rs`
// are: a `#[tauri::command]` cannot be unit-tested, so everything worth a test
// -- where an identity lives, what a pin may hold, what an export discloses,
// what the two checks prove -- is in `crate::identity`, over plain values.
// Nothing decides anything here.
//
// **THE PAGE NEVER HANDS THE HOST A PIN.** `identity_pin` takes an `id` and
// the opaque token from a host preview; the host reads the identity OUT OF THE VAULT ITSELF and builds
// the pin from what it found. That is 042's containment rule verbatim -- a cover
// is not an argument to `book_design_set` because a page-composed value would be
// naming a file on disk -- one surface further in and for a sharper reason: a
// page-composed pin is a page-composed BYLINE, and the whole guarantee of this
// feature is that what travels in a project file came from the vault's own
// public and publishing tiers.
//
// **AND THE PAGE IS NEVER SENT THE PRIVATE TIER IT DID NOT ASK TO EDIT.** It is
// sent, because the panel is where a writer types a legal name and there is
// nowhere else for it to be. What must never happen is that tier reaching a
// PROJECT, and it cannot: `identity::Pin` has no field for it.
use crate::{locked, open_project, DataHome, MirrorDirty, MirrorPassing, StoreState};
use tauri::State;

/// Public/publishing snapshots for a deliberate pin change. Private fields and
/// aliases are absent from `Pin`, including in this preview.
#[derive(Debug, serde::Serialize)]
pub(crate) struct PinPreview {
    token: String,
    before: Option<crate::identity::Pin>,
    before_unreadable: bool,
    after: crate::identity::Pin,
}

fn preview_for(project: &crate::OpenProject, identity: &crate::identity::Identity) -> std::result::Result<PinPreview, String> {
    let raw_pin = project.store.get_meta(crate::identity::PIN_KEY).map_err(|error| error.to_string())?;
    let (before, before_unreadable) = current_pin_for_preview(raw_pin.as_deref());
    let after = crate::identity::pin_of(identity, 0);
    let token = preview_token(&project.book_id, project.generation, &raw_pin, identity)?;
    Ok(PinPreview { token, before, before_unreadable, after })
}

fn current_pin_for_preview(raw: Option<&str>) -> (Option<crate::identity::Pin>, bool) {
    match raw {
        None => (None, false),
        Some(raw) => match serde_json::from_str(raw) {
            Ok(pin) => (Some(pin), false),
            Err(_) => (None, true),
        },
    }
}

fn preview_token(
    book_id: &str,
    generation: u64,
    raw_pin: &Option<String>,
    identity: &crate::identity::Identity,
) -> std::result::Result<String, String> {
    // Recomputed under the store lock on confirm. This is a comparison value,
    // not pin data accepted from the page. No hash or secret is involved.
    let token = serde_json::to_string(&(
        book_id, generation, raw_pin,
        &identity.id, identity.rev, &identity.public, &identity.publishing,
    )).map_err(|error| error.to_string())?;
    Ok(token)
}

/// What the panel paints: the whole vault, and what the open book is pinned to.
#[derive(serde::Serialize)]
pub(crate) struct IdentitiesView {
    pub(crate) identities: Vec<crate::identity::Identity>,
    /// The open project's pin, or None. The PIN and not the vault entry: the two
    /// are deliberately not kept in sync, and the panel has to be able to show
    /// that they differ.
    pub(crate) pinned: Option<crate::identity::Pin>,
    /// Whether the vault has moved on since the pin was taken. Reported, never
    /// repaired: a pin that followed the vault would rewrite the front matter of
    /// a book already on a shelf, from a text field edit, with no prompt.
    pub(crate) stale: bool,
}

/// The vault and the pin, read fresh.
///
/// READS ONLY, `covers_get`'s rule: opening this panel on a book nobody has
/// pinned leaves the file exactly as it was.
#[command_boundary::command]
pub(crate) fn identities_get(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
) -> std::result::Result<IdentitiesView, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    read_identities(&data_home.0, project)
}

/// Record an identity, whole.
///
/// THE `rev` IS THE HOST'S AND NEVER THE PAGE'S. It is bumped here on every
/// edit, so a page that sent a stale or an invented one cannot make a changed
/// identity look unchanged -- which is what would make a stale pin report
/// itself as current.
///
/// AN EDIT DOES NOT TOUCH ANY PROJECT. That is the feature: a book keeps the
/// biography it was published with until somebody explicitly repins.
#[command_boundary::command]
pub(crate) fn identity_save(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    passing: State<'_, MirrorPassing>,
    dirty: State<'_, MirrorDirty>,
    identity: crate::identity::Identity,
) -> std::result::Result<IdentitiesView, String> {
    let _passing = passing.0.lock().map_err(|_| "the readable folder is busy")?;
    let guard = locked(&state);
    let result = save_identity(&data_home.0, guard.as_ref(), identity);
    crate::mark_mirror_dirty(&dirty);
    result
}

/// The whole of `identity_save` except unwrapping Tauri's `State` -- so it can
/// be driven with `project: None`, which a `#[tauri::command]` signature
/// cannot be.
///
/// **NO OPEN PROJECT IS NOT A FAILURE HERE.** The library screen's "New pen
/// name..." calls this with nothing mounted -- that is the whole point
/// of an identity vault that lives beside `settings.json` rather than inside
/// a project file. The vault write above already succeeded by the time an
/// older version of this function reached `open_project(&guard)?` and
/// reported "no project is open", which threw the write away from the
/// writer's point of view while it stood written on disk. `pinned: None,
/// stale: false` is the honest answer for a book that is not open to have a
/// pin at all.
fn save_identity(
    data_home: &std::path::Path,
    project: Option<&crate::OpenProject>,
    identity: crate::identity::Identity,
) -> std::result::Result<IdentitiesView, String> {
    let mut vault = crate::identity::read_vault(data_home).map_err(|e| e.to_string())?;
    let id = if identity.id.trim().is_empty() {
        crate::identity::new_id(&vault)
    } else {
        identity.id.clone()
    };
    let mut next = identity;
    next.id = id.clone();
    next.aliases = crate::identity::normalize_aliases(next.aliases)?;
    match vault.identities.iter_mut().find(|i| i.id == id) {
        Some(existing) => {
            next.rev = existing.rev.saturating_add(1);
            *existing = next;
        }
        None => {
            next.rev = 1;
            vault.identities.push(next);
        }
    }
    vault.version = crate::identity::VAULT_VERSION;
    crate::identity::write_vault(data_home, &vault)?;
    match project {
        Some(project) => read_identities(data_home, project),
        None => Ok(IdentitiesView {
            identities: vault.identities,
            pinned: None,
            stale: false,
        }),
    }
}

/// Take an identity out of the vault.
///
/// THE PIN IS LEFT ALONE, and that is not an oversight. A pin is a portable
/// snapshot; a book published under a name the writer has since retired is still
/// that book. Deleting the vault entry and rewriting every project that named it
/// would be the automatic repin this design refuses.
///
/// What it DOES change is the cross-identity check: a name no longer in the
/// vault is no longer a needle, which is the honest consequence of the writer
/// saying it is not one of theirs.
#[command_boundary::command]
pub(crate) fn identity_remove(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    passing: State<'_, MirrorPassing>,
    dirty: State<'_, MirrorDirty>,
    id: String,
) -> std::result::Result<IdentitiesView, String> {
    let _passing = passing.0.lock().map_err(|_| "the readable folder is busy")?;
    let guard = locked(&state);
    let mut vault = crate::identity::read_vault(&data_home.0).map_err(|e| e.to_string())?;
    vault.identities.retain(|i| i.id != id);
    crate::identity::write_vault(&data_home.0, &vault)?;
    crate::mark_mirror_dirty(&dirty);
    match guard.as_ref() {
        Some(project) => read_identities(&data_home.0, project),
        None => Ok(IdentitiesView { identities: vault.identities, pinned: None, stale: false }),
    }
}

/// Preview the exact public/publishing change, without writing the book.
#[command_boundary::command]
pub(crate) fn identity_pin_preview(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    id: String,
) -> std::result::Result<PinPreview, String> {
    let guard = locked(&state);
    let project = open_project(&guard)?;
    let vault = crate::identity::read_vault(&data_home.0).map_err(|e| e.to_string())?;
    let identity = vault.identities.iter().find(|i| i.id == id)
        .ok_or_else(|| format!("{id:?} is not an identity this vault holds"))?;
    preview_for(project, identity)
}

/// Pin an identity to the open book, only if the preview still describes the
/// same book, existing pin, and complete public/publishing source snapshot.
///
/// The pin is built here, from the vault's
/// own record, by `identity::pin_of` -- so the public and publishing tiers that
/// land in the project file are the ones the writer typed into the vault and
/// never a payload the page composed. See this module's header.
#[command_boundary::command]
pub(crate) fn identity_pin(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    passing: State<'_, MirrorPassing>,
    dirty: State<'_, MirrorDirty>,
    id: String,
    token: String,
) -> std::result::Result<IdentitiesView, String> {
    let _passing = passing.0.lock().map_err(|_| "the readable folder is busy")?;
    let guard = locked(&state);
    let project = open_project(&guard)?;
    let vault = crate::identity::read_vault(&data_home.0).map_err(|e| e.to_string())?;
    let identity = vault
        .identities
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| format!("{id:?} is not an identity this vault holds"))?;
    if preview_for(project, identity)?.token != token {
        return Err("the book or pen name changed since the preview; preview it again".into());
    }
    crate::identity::set_pin(
        &project.store,
        Some(&crate::identity::pin_of(identity, now_seconds())),
    )?;
    crate::mark_mirror_dirty(&dirty);
    read_identities(&data_home.0, project)
}

/// Take the pin off the open book.
#[command_boundary::command]
pub(crate) fn identity_unpin(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    passing: State<'_, MirrorPassing>,
    dirty: State<'_, MirrorDirty>,
) -> std::result::Result<IdentitiesView, String> {
    let _passing = passing.0.lock().map_err(|_| "the readable folder is busy")?;
    let guard = locked(&state);
    let project = open_project(&guard)?;
    crate::identity::set_pin(&project.store, None)?;
    crate::mark_mirror_dirty(&dirty);
    read_identities(&data_home.0, project)
}

/// What an export of the open book in `format` would be checked for.
///
/// IT DOES NOT EXPORT AND IT DOES NOT RENDER. A blocker stops a render, so the
/// only way a writer can read the report of an export that would be refused is a
/// path that does not attempt one.
///
/// OFF THE STORE MUTEX, `project_export`'s rule: the path and the name come out
/// under the guard, the guard drops with that block, and the walk runs on its
/// own read-only connection.
#[command_boundary::command]
pub(crate) fn preflight_get(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    format: String,
) -> std::result::Result<crate::identity::Preflight, String> {
    let format = crate::export::Format::from_id(&format)
        .ok_or_else(|| format!("{format:?} is not a format this build writes"))?;
    let (path, name) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        (project.path.clone(), project.name.clone())
    };
    let vault = crate::commands::export::vault_for(&data_home.0)?;
    crate::commands::export::preflight_of(&path, &name, format, &vault)
}

/// Record context for one warning still present in a fresh check of this
/// project. The warning remains in the returned report and export policy is
/// unchanged. Holding the open-project guard and one SQLite immediate
/// transaction makes generation, current finding and append one decision.
#[command_boundary::command]
pub(crate) fn preflight_reason_add(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
    format: String,
    token: String,
    reason: String,
    generation: u64,
) -> std::result::Result<crate::identity::Preflight, String> {
    let format = crate::export::Format::from_id(&format)
        .ok_or_else(|| format!("{format:?} is not a format this build writes"))?;
    let guard = locked(&state);
    let project = open_project(&guard)?;
    if project.generation != generation {
        return Err("preflight belongs to an earlier project; no reason was recorded".into());
    }
    let vault = crate::commands::export::vault_for(&data_home.0)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?
        .as_millis() as i64;
    project.store.with_immediate(|store| {
        let mut report = crate::commands::export::preflight_of_store(store, &project.name, format, &vault)?;
        report.reason_history = crate::warning_history::append(store, &report, &token, &reason, now_ms)?;
        Ok(report)
    })
}

/// The one place an `IdentitiesView` is built, so the read, the save, the
/// removal and the pin cannot answer with four differently-shaped truths.
fn read_identities(
    data_home: &std::path::Path,
    project: &crate::OpenProject,
) -> std::result::Result<IdentitiesView, String> {
    let vault = crate::identity::read_vault(data_home).map_err(|e| e.to_string())?;
    let pinned = crate::identity::pin_of_project(&project.store)?;
    let stale = pinned.as_ref().is_some_and(|pin| {
        vault
            .identities
            .iter()
            .find(|i| i.id == pin.identity_id)
            .is_some_and(|i| i.rev > pin.rev)
    });
    Ok(IdentitiesView {
        identities: vault.identities,
        pinned,
        stale,
    })
}

/// Seconds since the Unix epoch, or the epoch itself if this machine's clock is
/// set before it. `commands::export`'s own, restated rather than shared: that
/// one is about an EPUB's `dcterms:modified` and this one is about when a writer
/// pinned a name, and a shared clock helper is the kind of thing a later slice
/// makes configurable for one caller.
fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn a_preview_token_changes_with_the_book_pin_generation_or_source() {
        let source = crate::identity::Identity {
            id: "ada".into(), rev: 2,
            public: crate::identity::Public { name: "Ada Vane".into(), ..Default::default() },
            ..Default::default()
        };
        let initial = preview_token("book-1", 1, &None, &source).unwrap();
        assert_ne!(initial, preview_token("book-2", 1, &None, &source).unwrap());
        assert_ne!(initial, preview_token("book-1", 2, &None, &source).unwrap());
        let pin = serde_json::to_string(&crate::identity::pin_of(&source, 12)).unwrap();
        assert_ne!(initial, preview_token("book-1", 1, &Some(pin), &source).unwrap());
        assert_ne!(initial, preview_token("book-1", 1, &Some("damaged".into()), &source).unwrap());
        let mut changed = source.clone();
        changed.public.bio = "New bio".into();
        assert_ne!(initial, preview_token("book-1", 1, &None, &changed).unwrap());
        changed = source.clone();
        changed.rev += 1;
        assert_ne!(initial, preview_token("book-1", 1, &None, &changed).unwrap());
        changed = source.clone();
        changed.private.legal_name = "Vault-only".into();
        assert_eq!(initial, preview_token("book-1", 1, &None, &changed).unwrap());
        assert!(!initial.contains("/book.db"));
    }

    #[test]
    fn a_damaged_pin_is_explicit_in_preview_and_its_raw_bytes_remain_checked() {
        assert_eq!(current_pin_for_preview(None), (None, false));
        assert_eq!(current_pin_for_preview(Some("damaged")), (None, true));
        let source = crate::identity::Identity { id: "ada".into(), ..Default::default() };
        let raw = serde_json::to_string(&crate::identity::pin_of(&source, 12)).unwrap();
        assert_eq!(current_pin_for_preview(Some(&raw)), (Some(crate::identity::pin_of(&source, 12)), false));
        assert_ne!(preview_token("book-1", 1, &Some("damaged".into()), &source).unwrap(),
            preview_token("book-1", 1, &Some("changed damage".into()), &source).unwrap());
    }

    #[test]
    fn identity_save_with_no_project_open_answers_ok_and_the_vault_holds_it() {
        // THE BLOCKER THIS PINS: `identity_save` used to end in
        // `open_project(&guard)?`, so calling it with nothing mounted errored
        // "no project is open" AFTER the vault write had already succeeded --
        // the write stood on disk while the writer was told it had failed.
        // The library screen's "New pen name..." is exactly this call.
        let dir = tempdir().unwrap();
        let identity = crate::identity::Identity {
            aliases: vec![" Anne Grey ".into(), "ANNE GREY".into()],
            public: crate::identity::Public {
                name: "Ada Vane".into(),
                sort_name: "Vane, Ada".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        let view = save_identity(dir.path(), None, identity).expect("no project open must not fail the save");
        assert_eq!(view.identities.len(), 1);
        assert_eq!(view.identities[0].public.name, "Ada Vane");
        assert_eq!(view.identities[0].aliases, vec!["Anne Grey"]);
        assert_eq!(view.pinned, None);
        assert!(!view.stale);

        // AND THE WRITE REALLY LANDED: read the vault back independently of
        // the answer this call handed back.
        let vault = crate::identity::read_vault(dir.path()).unwrap();
        assert_eq!(vault.identities.len(), 1);
        assert_eq!(vault.identities[0].public.name, "Ada Vane");
        assert_eq!(vault.identities[0].aliases, vec!["Anne Grey"]);
    }

    #[test]
    fn identity_save_with_no_project_open_still_mints_a_fresh_id_each_time() {
        let dir = tempdir().unwrap();
        let one = save_identity(
            dir.path(),
            None,
            crate::identity::Identity {
                public: crate::identity::Public {
                    name: "Ada Vane".into(),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        let two = save_identity(
            dir.path(),
            None,
            crate::identity::Identity {
                public: crate::identity::Public {
                    name: "Bram Kell".into(),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(two.identities.len(), 2);
        assert_ne!(one.identities[0].id, two.identities[1].id);
    }
}
