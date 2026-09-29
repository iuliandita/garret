use crate::projects::{physical_same_file, BookLocation, ProtectionClaim, Settings};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Recovery,
    Mirror,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    pub claims: Vec<ProtectionClaim>,
    pub unresolved: Vec<Surface>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_key(key: &str) -> bool {
    let mut components = Path::new(key).components();
    matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !key.contains('/')
        && !key.contains('\\')
        && !matches!(key.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic())
}

fn claim_key(claim: &ProtectionClaim, surface: Surface) -> &Option<String> {
    match surface {
        Surface::Recovery => &claim.recovery_key,
        Surface::Mirror => &claim.mirror_key,
    }
}

fn validate_claims(settings: &Settings) -> Result<(), String> {
    for (index, claim) in settings.protection_claims.iter().enumerate() {
        if !valid_id(&claim.book_id) {
            return Err(format!("invalid protection claim id at {index}"));
        }
        if settings
            .protection_claims
            .iter()
            .skip(index + 1)
            .any(|other| other.book_id == claim.book_id)
        {
            return Err("duplicate protection claim".into());
        }
        for surface in [Surface::Recovery, Surface::Mirror] {
            if let Some(key) = claim_key(claim, surface) {
                if !valid_key(key) {
                    return Err(format!("invalid protection key for {}", claim.book_id));
                }
                for other in settings.protection_claims.iter().skip(index + 1) {
                    if other.book_id == claim.book_id
                        || claim_key(other, surface).as_deref() == Some(key)
                    {
                        return Err("duplicate protection claim".into());
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn key_for(settings: &Settings, id: &str, surface: Surface) -> Result<String, String> {
    if !valid_id(id) {
        return Err("invalid book identity".into());
    }
    validate_claims(settings)?;
    Ok(settings
        .protection_claims
        .iter()
        .find(|claim| claim.book_id == id)
        .and_then(|claim| claim_key(claim, surface).clone())
        .unwrap_or_else(|| format!("by-id/{id}")))
}

fn recovery_manifest_matches(dir: &Path, kind: &str, stem: &str) -> bool {
    crate::recovery::read_manifest::<crate::recovery::Point>(dir).is_some_and(|manifest| {
        manifest.manifest_version == 1
            && manifest.kind == kind
            && manifest.project.slug == stem
            && manifest.entries.iter().all(|entry| valid_key(&entry.id))
    })
}

fn mirror_manifest_matches(dir: &Path, stem: &str) -> bool {
    crate::recovery::read_manifest::<crate::mirror::MirrorEntry>(dir).is_some_and(|manifest| {
        manifest.manifest_version == 1
            && manifest.kind == crate::recovery::KIND_MIRROR
            && manifest.project.slug == stem
            && manifest.entries.iter().all(|entry| {
                !entry.path.is_empty()
                    && !Path::new(&entry.path).is_absolute()
                    && !entry.path.contains('\\')
                    && Path::new(&entry.path)
                        .components()
                        .all(|component| matches!(component, Component::Normal(_)))
            })
    })
}

fn sole_known(
    settings: &Settings,
    candidate: &Path,
    id: &str,
    known: &[PathBuf],
    stem: &str,
) -> Result<bool, String> {
    if !candidate.exists() {
        return Ok(false);
    }
    let mut found = false;
    for path in known {
        if path.file_stem().and_then(|part| part.to_str()) != Some(stem) {
            continue;
        }
        if !path.exists() {
            return Ok(false);
        }
        if !physical_same_file(candidate, path)? {
            return Ok(false);
        }
        found = true;
    }
    for BookLocation { book_id, path } in &settings.book_locations {
        let path = Path::new(path);
        if path.file_stem().and_then(|part| part.to_str()) != Some(stem) {
            continue;
        }
        if !path.exists() || !physical_same_file(candidate, path)? || book_id != id {
            return Ok(false);
        }
        found = true;
    }
    Ok(found)
}

fn claimed_elsewhere(settings: &Settings, id: &str, surface: Surface, key: &str) -> bool {
    settings
        .protection_claims
        .iter()
        .any(|claim| claim.book_id != id && claim_key(claim, surface).as_deref() == Some(key))
}

fn unresolved(plan: &mut Plan, surface: Surface) {
    if !plan.unresolved.contains(&surface) {
        plan.unresolved.push(surface);
    }
}

pub fn plan(
    settings: &Settings,
    candidate: &Path,
    id: &str,
    known: &[PathBuf],
    data_home: &Path,
    mirror_root: Option<&Path>,
    adopt_legacy: bool,
) -> Result<Plan, String> {
    let recovery = key_for(settings, id, Surface::Recovery)?;
    let mirror = key_for(settings, id, Surface::Mirror)?;
    let stem = candidate
        .file_stem()
        .and_then(|part| part.to_str())
        .ok_or_else(|| "book path has no usable stem".to_string())?;
    let existing = settings
        .protection_claims
        .iter()
        .find(|claim| claim.book_id == id);
    let recovery_claimed = existing
        .and_then(|claim| claim.recovery_key.as_ref())
        .is_some();
    let mirror_claimed = existing
        .and_then(|claim| claim.mirror_key.as_ref())
        .is_some();
    let mut result = Plan::default();
    if recovery_claimed {
        result.claims.push(ProtectionClaim {
            book_id: id.into(),
            recovery_key: Some(recovery),
            mirror_key: None,
        });
    }
    if mirror_claimed {
        result.claims.push(ProtectionClaim {
            book_id: id.into(),
            recovery_key: None,
            mirror_key: Some(mirror),
        });
    }
    if !adopt_legacy {
        return Ok(result);
    }
    let recovery_dir = crate::projects::recovery_dir(data_home, stem);
    let archives_dir = crate::projects::archives_dir(data_home, stem);
    let mirror_dir = crate::projects::mirror_dir(data_home, mirror_root, stem);
    if !sole_known(settings, candidate, id, known, stem)? {
        if recovery_dir.exists()
            && !recovery_claimed
            && !claimed_elsewhere(settings, id, Surface::Recovery, stem)
        {
            unresolved(&mut result, Surface::Recovery);
        }
        if ((mirror_dir.exists() && !mirror_claimed)
            || settings.mirrored.iter().any(|slug| slug == stem))
            && !claimed_elsewhere(settings, id, Surface::Mirror, stem)
        {
            unresolved(&mut result, Surface::Mirror);
        }
        return Ok(result);
    }
    if recovery_dir.exists() && !recovery_claimed {
        let claimed = claimed_elsewhere(settings, id, Surface::Recovery, stem);
        if recovery_manifest_matches(&recovery_dir, "recovery", stem)
            && (!archives_dir.exists() || recovery_manifest_matches(&archives_dir, "archive", stem))
            && !claimed
        {
            result.claims.push(ProtectionClaim {
                book_id: id.into(),
                recovery_key: Some(stem.into()),
                mirror_key: None,
            });
        } else if !claimed {
            unresolved(&mut result, Surface::Recovery);
        }
    }
    if mirror_dir.exists() && !mirror_claimed {
        let claimed = claimed_elsewhere(settings, id, Surface::Mirror, stem);
        if mirror_manifest_matches(&mirror_dir, stem) && !claimed {
            result.claims.push(ProtectionClaim {
                book_id: id.into(),
                recovery_key: None,
                mirror_key: Some(stem.into()),
            });
        } else if !claimed {
            unresolved(&mut result, Surface::Mirror);
        }
    }
    if settings.mirrored.iter().any(|slug| slug == stem)
        && !result.claims.iter().any(|claim| claim.mirror_key.is_some())
    {
        unresolved(&mut result, Surface::Mirror);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210";

    fn candidate(home: &Path) -> PathBuf {
        let path = home.join("book.db");
        std::fs::write(&path, b"book").unwrap();
        path
    }

    fn project() -> crate::recovery::ProjectRef {
        crate::recovery::ProjectRef {
            slug: "book".into(),
            name: "Book".into(),
            schema_version: 11,
        }
    }

    fn completeness() -> crate::recovery::Completeness {
        crate::recovery::Completeness {
            items_total: 0,
            entries_written: 0,
            documents_with_prose: 0,
            unreadable_bodies: 0,
            pictures: 0,
            covers: 0,
        }
    }

    fn recovery_manifest(dir: &Path, archive: bool) {
        std::fs::create_dir_all(dir).unwrap();
        let manifest = if archive {
            crate::recovery::Manifest::archive(project(), 1, completeness(), Vec::new())
        } else {
            crate::recovery::Manifest::recovery(project(), 1, completeness(), Vec::new())
        };
        crate::recovery::write_manifest(dir, &manifest).unwrap();
    }

    fn mirror_manifest(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        let manifest = crate::recovery::Manifest::mirror(
            project(),
            1,
            completeness(),
            Vec::<crate::mirror::MirrorEntry>::new(),
        );
        crate::recovery::write_manifest(dir, &manifest).unwrap();
    }

    #[test]
    fn missing_matching_owner_blocks_legacy_adoption() {
        let home = tempdir().unwrap();
        let book = candidate(home.path());
        recovery_manifest(&crate::projects::recovery_dir(home.path(), "book"), false);
        let missing = home.path().join("elsewhere").join("book.db");
        let plan = plan(
            &Settings::default(),
            &book,
            ID,
            &[book.clone(), missing],
            home.path(),
            None,
            true,
        )
        .unwrap();
        assert!(plan.claims.is_empty());
        assert_eq!(plan.unresolved, [Surface::Recovery]);
    }

    #[test]
    fn physical_aliases_are_one_known_owner() {
        let home = tempdir().unwrap();
        let book = candidate(home.path());
        let alias = home.path().join("elsewhere").join("book.db");
        std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
        std::fs::hard_link(&book, &alias).unwrap();
        recovery_manifest(&crate::projects::recovery_dir(home.path(), "book"), false);
        let plan = plan(
            &Settings::default(),
            &book,
            ID,
            &[book.clone(), alias],
            home.path(),
            None,
            true,
        )
        .unwrap();
        assert_eq!(plan.claims[0].recovery_key.as_deref(), Some("book"));
    }

    #[test]
    fn separate_book_bypasses_legacy_adoption() {
        let home = tempdir().unwrap();
        let book = candidate(home.path());
        recovery_manifest(&crate::projects::recovery_dir(home.path(), "book"), false);
        let plan = plan(
            &Settings::default(),
            &book,
            ID,
            &[book.clone()],
            home.path(),
            None,
            false,
        )
        .unwrap();
        assert!(plan.claims.is_empty());
        assert!(plan.unresolved.is_empty());
    }

    #[test]
    fn another_identitys_claim_is_never_inherited() {
        let home = tempdir().unwrap();
        let book = candidate(home.path());
        recovery_manifest(&crate::projects::recovery_dir(home.path(), "book"), false);
        let mut settings = Settings::default();
        settings.protection_claims.push(ProtectionClaim {
            book_id: OTHER.into(),
            recovery_key: Some("book".into()),
            mirror_key: None,
        });
        let plan = plan(
            &settings,
            &book,
            ID,
            &[book.clone()],
            home.path(),
            None,
            true,
        )
        .unwrap();
        assert!(plan.claims.is_empty());
        assert!(plan.unresolved.is_empty());
    }

    #[test]
    fn same_identity_reuses_its_existing_key() {
        let home = tempdir().unwrap();
        let book = candidate(home.path());
        let mut settings = Settings::default();
        settings.protection_claims.push(ProtectionClaim {
            book_id: ID.into(),
            recovery_key: Some("existing".into()),
            mirror_key: None,
        });
        let plan = plan(
            &settings,
            &book,
            ID,
            &[book.clone()],
            home.path(),
            None,
            true,
        )
        .unwrap();
        assert_eq!(plan.claims[0].recovery_key.as_deref(), Some("existing"));
    }

    #[test]
    fn malformed_and_split_manifests_stay_unresolved_independently() {
        let home = tempdir().unwrap();
        let book = candidate(home.path());
        let recovery = crate::projects::recovery_dir(home.path(), "book");
        std::fs::create_dir_all(&recovery).unwrap();
        std::fs::write(
            recovery.join("manifest.json"),
            br#"{"manifest_version":1,"kind":"recovery","project":{"slug":"book"}}"#,
        )
        .unwrap();
        let mirror = crate::projects::mirror_dir(home.path(), None, "book");
        mirror_manifest(&mirror);
        let mut settings = Settings::default();
        settings.mirrored.push("book".into());
        let plan = plan(
            &settings,
            &book,
            ID,
            &[book.clone()],
            home.path(),
            None,
            true,
        )
        .unwrap();
        assert_eq!(plan.claims[0].mirror_key.as_deref(), Some("book"));
        assert_eq!(plan.unresolved, [Surface::Recovery]);
    }

    #[test]
    fn candidate_must_be_a_known_physical_owner() {
        let home = tempdir().unwrap();
        let book = candidate(home.path());
        recovery_manifest(&crate::projects::recovery_dir(home.path(), "book"), false);
        let plan = plan(
            &Settings::default(),
            &book,
            ID,
            &[],
            home.path(),
            None,
            true,
        )
        .unwrap();
        assert!(plan.claims.is_empty());
        assert_eq!(plan.unresolved, [Surface::Recovery]);
    }

    #[test]
    fn different_identity_at_the_same_canonical_path_blocks_adoption() {
        let home = tempdir().unwrap();
        let book = candidate(home.path());
        recovery_manifest(&crate::projects::recovery_dir(home.path(), "book"), false);
        let mut settings = Settings::default();
        settings.book_locations.push(BookLocation {
            book_id: OTHER.into(),
            path: book.to_string_lossy().into_owned(),
        });
        let plan = plan(
            &settings,
            &book,
            ID,
            &[book.clone()],
            home.path(),
            None,
            true,
        )
        .unwrap();
        assert!(plan.claims.is_empty());
        assert_eq!(plan.unresolved, [Surface::Recovery]);
    }

    #[test]
    fn applying_a_new_mirror_claim_transfers_legacy_enablement_once() {
        let home = tempdir().unwrap();
        let book = candidate(home.path());
        let mirror = crate::projects::mirror_dir(home.path(), None, "book");
        mirror_manifest(&mirror);
        let mut settings = Settings::default();
        settings.mirrored.push("book".into());
        let adoption = plan(
            &settings,
            &book,
            ID,
            &[book.clone()],
            home.path(),
            None,
            true,
        )
        .unwrap();
        apply(&mut settings, &adoption);
        assert_eq!(settings.mirrored, ["book"]);
        assert_eq!(settings.mirrored_book_ids, [ID]);

        settings.mirrored_book_ids.clear();
        let replan = plan(
            &settings,
            &book,
            ID,
            &[book.clone()],
            home.path(),
            None,
            true,
        )
        .unwrap();
        apply(&mut settings, &replan);
        assert!(settings.mirrored_book_ids.is_empty());
    }

    #[test]
    fn invalid_or_duplicate_claims_fail_closed() {
        let mut settings = Settings::default();
        settings.protection_claims.push(ProtectionClaim {
            book_id: ID.into(),
            recovery_key: Some("../escape".into()),
            mirror_key: None,
        });
        assert!(key_for(&settings, ID, Surface::Recovery).is_err());
        settings.protection_claims = vec![ProtectionClaim {
            book_id: ID.into(),
            recovery_key: Some("C:book".into()),
            mirror_key: None,
        }];
        assert!(key_for(&settings, ID, Surface::Recovery).is_err());
        settings.protection_claims = vec![
            ProtectionClaim {
                book_id: ID.into(),
                recovery_key: Some("book".into()),
                mirror_key: None,
            },
            ProtectionClaim {
                book_id: OTHER.into(),
                recovery_key: Some("book".into()),
                mirror_key: None,
            },
        ];
        assert!(key_for(&settings, ID, Surface::Recovery).is_err());
    }
}

pub fn apply(settings: &mut Settings, plan: &Plan) {
    for claim in &plan.claims {
        let newly_claimed_mirror = claim.mirror_key.is_some()
            && settings
                .protection_claims
                .iter()
                .find(|entry| entry.book_id == claim.book_id)
                .and_then(|entry| entry.mirror_key.as_ref())
                .is_none();
        let entry = settings
            .protection_claims
            .iter_mut()
            .find(|entry| entry.book_id == claim.book_id);
        if let Some(entry) = entry {
            if claim.recovery_key.is_some() {
                entry.recovery_key = claim.recovery_key.clone();
            }
            if claim.mirror_key.is_some() {
                entry.mirror_key = claim.mirror_key.clone();
            }
        } else {
            settings.protection_claims.push(claim.clone());
        }
        if newly_claimed_mirror
            && claim
                .mirror_key
                .as_ref()
                .is_some_and(|key| settings.mirrored.contains(key))
            && !settings.mirrored_book_ids.contains(&claim.book_id)
        {
            settings.mirrored_book_ids.push(claim.book_id.clone());
        }
    }
}
