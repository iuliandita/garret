//! Host-only SAF transport. The mobile host owns session admission and private staging.
//! Register `init()` and retain each operation until its native reply drains; never abort it.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

pub(crate) const ARCHIVE_LIMIT: u64 = 1024 * 1024 * 1024;
pub(crate) const KEY_LIMIT: u64 = 512;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Archive,
    Key,
}
impl Kind {
    pub(crate) fn limit(self) -> u64 {
        match self {
            Self::Archive => ARCHIVE_LIMIT,
            Self::Key => KEY_LIMIT,
        }
    }
    pub(crate) fn file_name(self, mode: Mode) -> &'static str {
        match (self, mode) {
            (Self::Archive, Mode::Open) => "archive.in",
            (Self::Archive, Mode::Create) => "archive.out",
            (Self::Key, Mode::Open) => "key.in",
            (Self::Key, Mode::Create) => "key.out",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Mode {
    Open,
    Create,
}

// No Serialize: this native capability and its internals must never become page data.
pub(crate) struct Ticket {
    operation: String,
    ticket: String,
    kind: Kind,
    mode: Mode,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PickReply {
    operation: String,
    cancelled: bool,
    ticket: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Receipt {
    pub(crate) operation: String,
    pub(crate) stage_id: String,
    pub(crate) bytes: u64,
    pub(crate) sha256: String,
    pub(crate) verified: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelReply {
    operation: String,
}
pub(crate) struct Bridge<R: Runtime>(PluginHandle<R>);

pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("writing-transfer")
        // Returning false would forward arbitrary frontend invocations to Kotlin on mobile.
        .invoke_handler(|invoke| {
            invoke
                .resolver
                .reject("native transfer bridge is host-only");
            true
        })
        .setup(|app, api| {
            app.manage(Bridge(
                api.register_android_plugin("cc.local.app", "TransferPlugin")?,
            ));
            Ok(())
        })
        .build()
}
fn canonical_uuid(value: &str) -> Result<(), String> {
    match uuid::Uuid::parse_str(value) {
        Ok(id) if id.to_string() == value => Ok(()),
        _ => Err("invalid transfer identifier".into()),
    }
}
fn hash_ok(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(crate) fn stage_dir(data_home: &Path, stage_id: &str) -> Result<PathBuf, String> {
    canonical_uuid(stage_id)?;
    Ok(data_home.join("transfer").join(stage_id))
}
impl Receipt {
    fn validate(
        &self,
        operation: &str,
        stage_id: &str,
        limit: u64,
        verified: bool,
    ) -> Result<(), String> {
        if self.operation != operation
            || self.stage_id != stage_id
            || self.bytes > limit
            || !hash_ok(&self.sha256)
            || self.verified != verified
        {
            Err("invalid native transfer receipt".into())
        } else {
            Ok(())
        }
    }
}
impl<R: Runtime> Bridge<R> {
    async fn call<T: DeserializeOwned + Send + 'static>(
        &self,
        command: &'static str,
        payload: Value,
    ) -> Result<T, String> {
        let handle = self.0.clone();
        // Tauri 2.11.5 unwraps its oneshot send: dropping that future before a late
        // native reply can panic. Dropping our caller only detaches this draining task.
        tauri::async_runtime::spawn(async move {
            handle
                .run_mobile_plugin_async(command, payload)
                .await
                .map_err(|_| "native transfer failed or was cancelled".to_string())
        })
        .await
        .map_err(|_| "native transfer task failed".to_string())?
    }
    /// After a successful pick, recheck generation/privacy before invoking read or write.
    pub(crate) async fn pick(
        &self,
        operation: &str,
        kind: Kind,
        mode: Mode,
        display_name: &str,
    ) -> Result<Option<Ticket>, String> {
        canonical_uuid(operation)?;
        if display_name.is_empty()
            || display_name.chars().count() > 120
            || display_name
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
        {
            return Err("invalid transfer display name".into());
        }
        let reply: PickReply = self.call("pick", json!({"operation": operation, "kind": kind, "mode": mode, "displayName": display_name})).await?;
        if reply.operation != operation || (reply.cancelled && reply.ticket.is_some()) {
            return Err("invalid native picker receipt".into());
        }
        if reply.cancelled {
            return Ok(None);
        }
        let ticket = reply.ticket.ok_or("missing native picker ticket")?;
        canonical_uuid(&ticket)?;
        Ok(Some(Ticket {
            operation: operation.into(),
            ticket,
            kind,
            mode,
        }))
    }
    /// Rust must create the private 0700 stage directory first. Native copy creates
    /// only kind.in with O_EXCL and mode0600; partial/uncertain files are retained.
    pub(crate) async fn read(
        &self,
        ticket: Ticket,
        stage_id: &str,
        max_bytes: u64,
    ) -> Result<Receipt, String> {
        canonical_uuid(stage_id)?;
        if ticket.mode != Mode::Open || max_bytes == 0 || max_bytes > ticket.kind.limit() {
            return Err("invalid transfer read admission".into());
        }
        let reply: Receipt = self.call("readPicked", json!({"operation":ticket.operation,"ticket":ticket.ticket,"stageId":stage_id,"maxBytes":max_bytes})).await?;
        reply.validate(&ticket.operation, stage_id, max_bytes, false)?;
        Ok(reply)
    }
    /// A write receipt means closed-and-read-back equality, not a provider durability promise.
    /// Recheck host ownership after await; do not publish an import or page success on stale state.
    pub(crate) async fn write(
        &self,
        ticket: Ticket,
        stage_id: &str,
        bytes: u64,
        sha256: &str,
    ) -> Result<Receipt, String> {
        canonical_uuid(stage_id)?;
        if ticket.mode != Mode::Create || bytes > ticket.kind.limit() || !hash_ok(sha256) {
            return Err("invalid transfer write admission".into());
        }
        let reply: Receipt = self.call("writeVerified", json!({"operation":ticket.operation,"ticket":ticket.ticket,"stageId":stage_id,"maxBytes":ticket.kind.limit(),"expectedBytes":bytes,"expectedSha256":sha256})).await.map_err(|_| "transfer export is unverified".to_string())?;
        reply.validate(&ticket.operation, stage_id, bytes, true)?;
        if reply.bytes != bytes || reply.sha256 != sha256 {
            return Err("transfer export is unverified".into());
        }
        Ok(reply)
    }
    /// This acknowledges cancellation admission only. Retain and await the original
    /// operation before treating native I/O as drained or cleaning its stage.
    /// Cancellation is terminal for the operation, but a picker remains occupied
    /// until Android returns its callback; a blocked stream remains occupied until drained.
    pub(crate) async fn cancel(&self, operation: &str) -> Result<(), String> {
        canonical_uuid(operation)?;
        let reply: CancelReply = self.call("cancel", json!({"operation":operation})).await?;
        if reply.operation != operation {
            return Err("invalid native cancellation receipt".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saf_identifiers_paths_and_receipts_are_constrained() {
        let id = "12345678-1234-4234-8234-123456789abc";
        assert!(canonical_uuid(id).is_ok());
        for bad in [
            "../book",
            "12345678123442348234123456789abc",
            "12345678-1234-4234-8234-123456789ABC",
        ] {
            assert!(canonical_uuid(bad).is_err());
        }
        assert_eq!(
            stage_dir(Path::new("private"), id).unwrap(),
            Path::new("private/transfer").join(id)
        );
        assert_eq!(Kind::Key.limit(), 512);
        assert_eq!(Kind::Archive.limit(), 1 << 30);
        assert_eq!(Kind::Key.file_name(Mode::Create), "key.out");
        let mut receipt = Receipt {
            operation: id.into(),
            stage_id: id.into(),
            bytes: 512,
            sha256: "a".repeat(64),
            verified: true,
        };
        assert!(receipt.validate(id, id, 512, true).is_ok());
        assert!(receipt.validate("other", id, 512, true).is_err());
        assert!(receipt.validate(id, id, 511, true).is_err());
        assert!(receipt.validate(id, id, 512, false).is_err());
        receipt.sha256 = "A".repeat(64);
        assert!(receipt.validate(id, id, 512, true).is_err());
        assert!(serde_json::from_value::<Receipt>(json!({"operation":id,"stageId":id,"bytes":1,"sha256":"a".repeat(64),"verified":true,"uri":"content://provider"})).is_err());
    }
}
