use argon2::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Argon2,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const MAX_RECORD: u64 = 4096;

fn required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    Password,
    Pin,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shortcut {
    #[default]
    CtrlAltL,
    CtrlAltP,
    Off,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    #[serde(deserialize_with = "required_option")]
    pub idle_min: Option<u32>,
    pub session_lock: bool,
    pub sleep: bool,
    pub neutral_title: bool,
    #[serde(default)]
    pub shortcut: Shortcut,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            idle_min: Some(15),
            session_lock: true,
            sleep: true,
            neutral_title: false,
            shortcut: Shortcut::default(),
        }
    }
}
impl Policy {
    fn valid(&self) -> bool {
        matches!(self.idle_min, None | Some(1 | 5 | 15 | 30 | 60))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LockState {
    Disabled,
    Locked,
    Verifying,
    Unlocked,
    Recovery,
}
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub state: LockState,
    pub policy: Policy,
    pub kind: Option<SecretKind>,
    pub retry_after_ms: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Error {
    Busy,
    Recovery,
    Disabled,
    AlreadyEnabled,
    InvalidSecret,
    Confirmation,
    InvalidPolicy,
    WrongSecret,
    RateLimited,
    Stale,
    Persist,
    Crypto,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Credential {
    kind: SecretKind,
    verifier: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    #[serde(deserialize_with = "required_option")]
    credential: Option<Credential>,
    policy: Policy,
}
impl Default for Record {
    fn default() -> Self {
        Self {
            version: 1,
            credential: None,
            policy: Policy::default(),
        }
    }
}
struct State {
    record: Record,
    recovery: bool,
    locked: bool,
    busy: bool,
    generation: u64,
    failures: u32,
    next_attempt: Option<Instant>,
}
pub struct Privacy {
    path: PathBuf,
    state: Mutex<State>,
    #[cfg(test)]
    fail_directory_sync: std::sync::atomic::AtomicBool,
}

fn valid_verifier(s: &str) -> bool {
    // An exact parameter set bounds work even for a tampered local record.
    let parts: Vec<_> = s.split('$').collect();
    parts.len() == 6
        && parts[0].is_empty()
        && parts[1] == "argon2id"
        && parts[2] == "v=19"
        && parts[3] == "m=19456,t=2,p=1"
        && parts[4].len() == 22
        && parts[5].len() == 43
        && PasswordHash::new(s).is_ok()
}
fn valid_secret(kind: SecretKind, secret: &str) -> bool {
    match kind {
        SecretKind::Password => secret.len() <= 1024 && secret.chars().count() >= 8,
        SecretKind::Pin => {
            (6..=128).contains(&secret.len()) && secret.bytes().all(|b| b.is_ascii_digit())
        }
    }
}
fn hash(kind: SecretKind, secret: &str, confirmation: &str) -> Result<Credential, Error> {
    if !valid_secret(kind, secret) {
        return Err(Error::InvalidSecret);
    }
    if secret != confirmation {
        return Err(Error::Confirmation);
    }
    let verifier = Argon2::default()
        .hash_password(secret.as_bytes())
        .map_err(|_| Error::Crypto)?
        .to_string();
    if !valid_verifier(&verifier) {
        return Err(Error::Crypto);
    }
    Ok(Credential { kind, verifier })
}
fn read_record(path: &Path) -> Result<Record, ()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Record::default()),
        _ => return Err(()),
    }
    let file = File::open(path).map_err(|_| ())?;
    if !file.metadata().map_err(|_| ())?.is_file() {
        return Err(());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_RECORD {
        return Err(());
    }
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if record.version != 1
        || !record.policy.valid()
        || record
            .credential
            .as_ref()
            .is_some_and(|c| !valid_verifier(&c.verifier))
    {
        return Err(());
    }
    Ok(record)
}
impl State {
    fn status(&self) -> Status {
        Status {
            state: if self.recovery {
                LockState::Recovery
            } else if self.record.credential.is_none() {
                LockState::Disabled
            } else if self.busy {
                LockState::Verifying
            } else if self.locked {
                LockState::Locked
            } else {
                LockState::Unlocked
            },
            policy: self.record.policy.clone(),
            kind: self.record.credential.as_ref().map(|c| c.kind),
            retry_after_ms: self.next_attempt.map_or(0, |d| {
                d.saturating_duration_since(Instant::now())
                    .as_millis()
                    .min(u64::MAX as u128) as u64
            }),
        }
    }
}
impl Privacy {
    pub fn load(data_home: &Path) -> Self {
        let path = data_home.join("cc.local.app/privacy.json");
        let loaded = read_record(&path);
        let recovery = loaded.is_err();
        let record = loaded.unwrap_or_default();
        let locked = recovery || record.credential.is_some();
        Self {
            path,
            #[cfg(test)]
            fail_directory_sync: std::sync::atomic::AtomicBool::new(false),
            state: Mutex::new(State {
                record,
                recovery,
                locked,
                busy: false,
                generation: 0,
                failures: 0,
                next_attempt: None,
            }),
        }
    }
    pub fn status(&self) -> Status {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .status()
    }
    pub fn locked(&self) -> bool {
        matches!(
            self.status().state,
            LockState::Locked | LockState::Verifying | LockState::Recovery
        )
    }
    pub fn lock(&self) -> Status {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.generation = s.generation.wrapping_add(1);
        s.locked = s.recovery || s.record.credential.is_some();
        s.status()
    }
    pub fn generation(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .generation
    }
    fn begin(&self, expected_generation: u64, enrollment: bool) -> Result<(u64, Record), Error> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if expected_generation != s.generation {
            return Err(Error::Stale);
        }
        if s.recovery {
            return Err(Error::Recovery);
        }
        if s.busy {
            return Err(Error::Busy);
        }
        if enrollment && s.record.credential.is_some() {
            return Err(Error::AlreadyEnabled);
        }
        if !enrollment && s.record.credential.is_none() {
            return Err(Error::Disabled);
        }
        if s.next_attempt.is_some_and(|d| d > Instant::now()) {
            return Err(Error::RateLimited);
        }
        s.busy = true;
        Ok((s.generation, s.record.clone()))
    }
    fn verify(record: &Record, secret: &str) -> Result<(), Error> {
        if secret.len() > 1024 {
            return Err(Error::WrongSecret);
        }
        let c = record.credential.as_ref().ok_or(Error::Disabled)?;
        let parsed = PasswordHash::new(&c.verifier).map_err(|_| Error::Recovery)?;
        Argon2::default()
            .verify_password(secret.as_bytes(), &parsed)
            .map_err(|_| Error::WrongSecret)
    }
    fn persist(&self, record: &Record) -> Result<(), Error> {
        let parent = self.path.parent().ok_or(Error::Persist)?;
        fs::create_dir_all(parent).map_err(|_| Error::Persist)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| Error::Persist)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temp.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| Error::Persist)?;
        }
        #[cfg(windows)]
        crate::privacy_windows_file::restrict(temp.path()).map_err(|_| Error::Persist)?;
        let bytes = serde_json::to_vec(record).map_err(|_| Error::Persist)?;
        temp.write_all(&bytes).map_err(|_| Error::Persist)?;
        temp.as_file().sync_all().map_err(|_| Error::Persist)?;
        #[cfg(windows)]
        {
            crate::privacy_windows_file::persist(temp, &self.path, &bytes)
                .map_err(|_| Error::Persist)?;
            #[cfg(test)]
            if self
                .fail_directory_sync
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(Error::Persist);
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
        temp.persist(&self.path).map_err(|_| Error::Persist)?;
        #[cfg(test)]
        if self
            .fail_directory_sync
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(Error::Persist);
        }
        File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|_| Error::Persist)?;
        // Also make a newly created application directory durable.
        File::open(parent.parent().ok_or(Error::Persist)?)
            .and_then(|f| f.sync_all())
            .map_err(|_| Error::Persist)?;
        Ok(())
        }
    }
    fn finish(
        &self,
        generation: u64,
        result: Result<Option<Record>, Error>,
        unlock: bool,
    ) -> Result<Status, Error> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.busy = false;
        if let Err(Error::WrongSecret) = result {
            s.failures = s.failures.saturating_add(1);
            let seconds = (1u64 << s.failures.saturating_sub(1).min(6)).min(60);
            s.next_attempt = Some(Instant::now() + Duration::from_secs(seconds));
            return Err(Error::WrongSecret);
        }
        let replacement = result?;
        if generation != s.generation {
            return Err(Error::Stale);
        }
        if let Some(record) = replacement {
            if self.persist(&record).is_err() {
                // A rename may have succeeded before a directory sync failed.
                // Never keep an unlocked session with uncertain credential state.
                s.recovery = true;
                s.locked = true;
                return Err(Error::Persist);
            }
            s.record = record;
        }
        s.failures = 0;
        s.next_attempt = None;
        if unlock || s.record.credential.is_none() {
            s.locked = false;
        }
        Ok(s.status())
    }
    pub fn unlock(&self, expected_generation: u64, secret: String) -> Result<Status, Error> {
        let secret = Zeroizing::new(secret);
        let (generation, record) = self.begin(expected_generation, false)?;
        let result = Self::verify(&record, &secret).map(|()| None);
        self.finish(generation, result, true)
    }
    pub fn enroll(
        &self,
        expected_generation: u64,
        kind: SecretKind,
        secret: String,
        confirmation: String,
        policy: Policy,
    ) -> Result<Status, Error> {
        let secret = Zeroizing::new(secret);
        let confirmation = Zeroizing::new(confirmation);
        if !policy.valid() {
            return Err(Error::InvalidPolicy);
        }
        let (generation, _) = self.begin(expected_generation, true)?;
        let result = hash(kind, &secret, &confirmation).map(|credential| {
            Some(Record {
                version: 1,
                credential: Some(credential),
                policy,
            })
        });
        self.finish(generation, result, true)
    }
    pub fn change_secret(
        &self,
        expected_generation: u64,
        current: String,
        kind: SecretKind,
        secret: String,
        confirmation: String,
    ) -> Result<Status, Error> {
        let current = Zeroizing::new(current);
        let secret = Zeroizing::new(secret);
        let confirmation = Zeroizing::new(confirmation);
        let (generation, mut record) = self.begin(expected_generation, false)?;
        let result = Self::verify(&record, &current)
            .and_then(|()| hash(kind, &secret, &confirmation))
            .map(|c| {
                record.credential = Some(c);
                Some(record)
            });
        self.finish(generation, result, false)
    }
    pub fn disable(&self, expected_generation: u64, current: String) -> Result<Status, Error> {
        let current = Zeroizing::new(current);
        let (generation, mut record) = self.begin(expected_generation, false)?;
        let result = Self::verify(&record, &current).map(|()| {
            record.credential = None;
            Some(record)
        });
        self.finish(generation, result, false)
    }
    pub fn update_policy(
        &self,
        expected_generation: u64,
        current: String,
        policy: Policy,
    ) -> Result<Status, Error> {
        let current = Zeroizing::new(current);
        if !policy.valid() {
            return Err(Error::InvalidPolicy);
        }
        let (generation, mut record) = self.begin(expected_generation, false)?;
        let result = Self::verify(&record, &current).map(|()| {
            record.policy = policy;
            Some(record)
        });
        self.finish(generation, result, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn enrolled() -> (tempfile::TempDir, Privacy) {
        let dir = tempfile::tempdir().unwrap();
        let service = Privacy::load(dir.path());
        service
            .enroll(
                service.generation(),
                SecretKind::Password,
                "eight chars".into(),
                "eight chars".into(),
                Policy::default(),
            )
            .unwrap();
        (dir, service)
    }
    #[test]
    fn privacy_missing_disabled_corrupt_recovery() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            Privacy::load(dir.path()).status().state,
            LockState::Disabled
        );
        let path = dir.path().join("cc.local.app/privacy.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for data in [b"broken".to_vec(), vec![b' '; 4097], br#"{"version":2,"credential":null,"policy":{"idle_min":15,"session_lock":true,"sleep":true,"neutral_title":false}}"#.to_vec()] {
            fs::write(&path, data).unwrap();
            assert_eq!(Privacy::load(dir.path()).status().state, LockState::Recovery);
        }
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(Privacy::load(dir.path()).locked());
    }
    #[test]
    fn privacy_restart_locked_unlock_does_not_write() {
        let (dir, service) = enrolled();
        assert_eq!(service.status().state, LockState::Unlocked);
        let loaded = Privacy::load(dir.path());
        assert_eq!(loaded.status().state, LockState::Locked);
        let bytes = fs::read(&loaded.path).unwrap();
        let modified = fs::metadata(&loaded.path).unwrap().modified().unwrap();
        // Replacing the directory with a file makes writes impossible, even as root.
        let moved = dir.path().join("saved");
        fs::rename(loaded.path.parent().unwrap(), &moved).unwrap();
        fs::write(loaded.path.parent().unwrap(), "blocked").unwrap();
        assert_eq!(
            loaded
                .unlock(loaded.generation(), "eight chars".into())
                .unwrap()
                .state,
            LockState::Unlocked
        );
        assert_eq!(fs::read(moved.join("privacy.json")).unwrap(), bytes);
        assert_eq!(
            fs::metadata(moved.join("privacy.json"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
    }
    #[test]
    fn privacy_wrong_secret_backoff_and_reset() {
        let (dir, service) = enrolled();
        service.lock();
        for expected in [1, 2, 4, 8, 16, 32, 60, 60] {
            assert_eq!(
                service
                    .unlock(service.generation(), "wrong".into())
                    .unwrap_err(),
                Error::WrongSecret
            );
            let s = service.state.lock().unwrap();
            let delay = s
                .next_attempt
                .unwrap()
                .saturating_duration_since(Instant::now());
            assert!(delay > Duration::from_millis(expected * 1000 - 500));
            assert!(delay <= Duration::from_secs(expected));
            drop(s);
            assert_eq!(
                service
                    .unlock(service.generation(), "eight chars".into())
                    .unwrap_err(),
                Error::RateLimited
            );
            service.state.lock().unwrap().next_attempt = Some(Instant::now());
        }
        service
            .unlock(service.generation(), "eight chars".into())
            .unwrap();
        assert_eq!(service.state.lock().unwrap().failures, 0);
        assert_eq!(Privacy::load(dir.path()).status().retry_after_ms, 0);
    }
    #[test]
    fn privacy_enrollment_policy_and_secret_bounds() {
        assert!(valid_secret(SecretKind::Password, "字字字字字字字字"));
        assert!(!valid_secret(SecretKind::Password, "字字字字字字字"));
        assert!(!valid_secret(SecretKind::Password, &"x".repeat(1025)));
        assert!(valid_secret(SecretKind::Pin, "123456"));
        assert!(!valid_secret(SecretKind::Pin, "12345"));
        assert!(!valid_secret(SecretKind::Pin, "１２３４５６"));
        assert!(!valid_secret(SecretKind::Pin, &"1".repeat(129)));
        let dir = tempfile::tempdir().unwrap();
        let service = Privacy::load(dir.path());
        assert_eq!(
            service
                .enroll(
                    service.generation(),
                    SecretKind::Password,
                    "abcdefgh".into(),
                    "different".into(),
                    Policy::default()
                )
                .unwrap_err(),
            Error::Confirmation
        );
        assert_eq!(service.status().state, LockState::Disabled);
        let policy = Policy {
            idle_min: Some(2),
            ..Policy::default()
        };
        assert_eq!(
            service
                .enroll(
                    service.generation(),
                    SecretKind::Pin,
                    "123456".into(),
                    "123456".into(),
                    policy
                )
                .unwrap_err(),
            Error::InvalidPolicy
        );
    }
    #[test]
    fn privacy_changed_secret_and_disabled_are_durable() {
        let (dir, service) = enrolled();
        assert_eq!(
            service
                .disable(service.generation(), "wrong".into())
                .unwrap_err(),
            Error::WrongSecret
        );
        service.state.lock().unwrap().next_attempt = None;
        service
            .change_secret(
                service.generation(),
                "eight chars".into(),
                SecretKind::Pin,
                "123456".into(),
                "123456".into(),
            )
            .unwrap();
        let loaded = Privacy::load(dir.path());
        assert_eq!(
            loaded
                .unlock(loaded.generation(), "eight chars".into())
                .unwrap_err(),
            Error::WrongSecret
        );
        loaded.state.lock().unwrap().next_attempt = None;
        loaded.unlock(loaded.generation(), "123456".into()).unwrap();
        let policy = Policy {
            idle_min: None,
            neutral_title: true,
            ..Policy::default()
        };
        loaded
            .update_policy(loaded.generation(), "123456".into(), policy.clone())
            .unwrap();
        assert_eq!(Privacy::load(dir.path()).status().policy, policy);
        loaded
            .disable(loaded.generation(), "123456".into())
            .unwrap();
        assert_eq!(
            Privacy::load(dir.path()).status().state,
            LockState::Disabled
        );
    }
    #[test]
    fn privacy_bounded_hash_and_strict_record() {
        let (dir, service) = enrolled();
        let bytes = fs::read_to_string(&service.path).unwrap();
        for invalid in [
            bytes.replace("m=19456", "m=999999999"),
            bytes.replace("t=2", "t=20"),
            bytes.replace("argon2id", "argon2i"),
            bytes.replace("\"version\":1", "\"version\":1,\"extra\":true"),
        ] {
            fs::write(&service.path, invalid).unwrap();
            assert_eq!(
                Privacy::load(dir.path()).status().state,
                LockState::Recovery
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&service.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn privacy_failed_persistence_is_concealed_and_preserves_record() {
        let (dir, service) = enrolled();
        let old = fs::read(&service.path).unwrap();
        let moved = dir.path().join("saved");
        fs::rename(service.path.parent().unwrap(), &moved).unwrap();
        fs::write(service.path.parent().unwrap(), "blocked").unwrap();
        assert_eq!(
            service
                .disable(service.generation(), "eight chars".into())
                .unwrap_err(),
            Error::Persist
        );
        assert_eq!(service.status().state, LockState::Recovery);
        assert_eq!(fs::read(moved.join("privacy.json")).unwrap(), old);
        assert_eq!(
            service
                .unlock(service.generation(), "eight chars".into())
                .unwrap_err(),
            Error::Recovery
        );
        let other = tempfile::tempdir().unwrap();
        fs::write(other.path().join("cc.local.app"), "blocked").unwrap();
        let other_service = Privacy::load(other.path());
        assert!(other_service.locked());
    }
    #[test]
    fn privacy_concurrent_operation_and_stale_result_cannot_unlock_or_disable() {
        let (_dir, service) = enrolled();
        service.lock();
        let (generation, mut record) = service.begin(service.generation(), false).unwrap();
        // These calls hit the same operation admission boundary as worker threads.
        assert_eq!(
            service
                .unlock(service.generation(), "eight chars".into())
                .unwrap_err(),
            Error::Busy
        );
        assert_eq!(
            service
                .disable(service.generation(), "eight chars".into())
                .unwrap_err(),
            Error::Busy
        );
        assert!(service.locked());
        service.lock();
        assert_eq!(
            service.finish(generation, Ok(None), true).unwrap_err(),
            Error::Stale
        );
        assert_eq!(service.status().state, LockState::Locked);
        let (generation, _) = service.begin(service.generation(), false).unwrap();
        service.lock();
        record.credential = None;
        assert_eq!(
            service
                .finish(generation, Ok(Some(record)), false)
                .unwrap_err(),
            Error::Stale
        );
        assert!(service.state.lock().unwrap().record.credential.is_some());
    }
    #[test]
    fn privacy_missing_credential_is_corrupt_and_failed_enrollment_stays_concealed() {
        let dir = tempfile::tempdir().unwrap();
        let service = Privacy::load(dir.path());
        fs::create_dir_all(service.path.parent().unwrap()).unwrap();
        fs::write(&service.path, br#"{"version":1,"policy":{"idle_min":15,"session_lock":true,"sleep":true,"neutral_title":false}}"#).unwrap();
        assert_eq!(
            Privacy::load(dir.path()).status().state,
            LockState::Recovery
        );
        fs::remove_file(&service.path).unwrap();
        service
            .fail_directory_sync
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            service
                .enroll(
                    service.generation(),
                    SecretKind::Password,
                    "eight chars".into(),
                    "eight chars".into(),
                    Policy::default()
                )
                .unwrap_err(),
            Error::Persist
        );
        assert_eq!(service.status().state, LockState::Recovery);
        assert_eq!(Privacy::load(dir.path()).status().state, LockState::Locked);
        assert!(service.state.lock().unwrap().record.credential.is_none());
    }
    #[test]
    fn privacy_lock_between_dispatch_and_admission_rejects_operations() {
        let (_dir, service) = enrolled();
        let dispatched = service.generation();
        service.lock();
        let before = fs::read(&service.path).unwrap();
        assert_eq!(
            service
                .unlock(dispatched, "eight chars".into())
                .unwrap_err(),
            Error::Stale
        );
        assert_eq!(
            service
                .disable(dispatched, "eight chars".into())
                .unwrap_err(),
            Error::Stale
        );
        assert_eq!(
            service
                .change_secret(
                    dispatched,
                    "eight chars".into(),
                    SecretKind::Pin,
                    "123456".into(),
                    "123456".into()
                )
                .unwrap_err(),
            Error::Stale
        );
        assert_eq!(
            service
                .update_policy(dispatched, "eight chars".into(), Policy::default())
                .unwrap_err(),
            Error::Stale
        );
        assert_eq!(service.status().state, LockState::Locked);
        assert_eq!(fs::read(&service.path).unwrap(), before);
        assert!(!service.state.lock().unwrap().busy);
        service
            .unlock(service.generation(), "eight chars".into())
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let disabled = Privacy::load(dir.path());
        let dispatched = disabled.generation();
        disabled.lock();
        assert_eq!(
            disabled
                .enroll(
                    dispatched,
                    SecretKind::Password,
                    "eight chars".into(),
                    "eight chars".into(),
                    Policy::default()
                )
                .unwrap_err(),
            Error::Stale
        );
        assert_eq!(disabled.status().state, LockState::Disabled);
        assert!(!disabled.path.exists());
    }
    #[test]
    fn privacy_shortcut_roundtrip_and_legacy_default() {
        let (dir, service) = enrolled();
        for shortcut in [Shortcut::CtrlAltL, Shortcut::CtrlAltP, Shortcut::Off] {
            let policy = Policy {
                shortcut,
                ..Policy::default()
            };
            service
                .update_policy(service.generation(), "eight chars".into(), policy)
                .unwrap();
            assert_eq!(Privacy::load(dir.path()).status().policy.shortcut, shortcut);
        }
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&service.path).unwrap()).unwrap();
        record["policy"].as_object_mut().unwrap().remove("shortcut");
        fs::write(&service.path, serde_json::to_vec(&record).unwrap()).unwrap();
        let legacy = Privacy::load(dir.path());
        assert_eq!(legacy.status().state, LockState::Locked);
        assert_eq!(legacy.status().policy.shortcut, Shortcut::CtrlAltL);
        record["policy"]["shortcut"] = serde_json::json!("ctrl_alt_unknown");
        fs::write(&service.path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(
            Privacy::load(dir.path()).status().state,
            LockState::Recovery
        );
    }

    #[test]
    fn privacy_shortcut_wire_values_are_explicit() {
        for (shortcut, wire) in [
            (Shortcut::CtrlAltL, "ctrl_alt_l"),
            (Shortcut::CtrlAltP, "ctrl_alt_p"),
            (Shortcut::Off, "off"),
        ] {
            assert_eq!(serde_json::to_value(shortcut).unwrap(), wire);
            assert_eq!(
                serde_json::from_value::<Shortcut>(serde_json::json!(wire)).unwrap(),
                shortcut
            );
        }
    }
}
