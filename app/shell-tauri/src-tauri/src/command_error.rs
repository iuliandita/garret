#[derive(Debug, serde::Serialize)]
pub struct CommandFailure {
    version: u8,
    code: &'static str,
    operation: String,
    detail: String,
}

impl CommandFailure {
    pub fn operation(operation: &str, detail: impl std::fmt::Display) -> Self {
        Self { version: 1, code: "operation_failed", operation: operation.into(), detail: detail.to_string() }
    }

    pub fn locked(operation: &str) -> Self {
        Self { version: 1, code: "application_locked", operation: operation.into(), detail: String::new() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[command_boundary::command]
    fn wire_sync(state: tauri::State<'_, u32>, item_id: String, refuse: bool) -> Result<String, String> {
        if refuse { Err(format!("refused {item_id}")) } else { Ok(format!("{}:{item_id}", *state)) }
    }

    #[cfg(test)]
    #[command_boundary::command(rename_all = "snake_case")]
    async fn wire_async(item_id: String) -> Result<String, String> {
        Ok(item_id)
    }

    #[test]
    fn structured_commands_keep_real_wire_names_arguments_state_and_async_success() {
        use tauri::test::{assert_ipc_response, mock_builder, mock_context, noop_assets};
        let app = mock_builder().manage(7u32)
            .invoke_handler(tauri::generate_handler![__wire_wire_sync, __wire_wire_async])
            .build(mock_context(noop_assets())).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let request = |command: &str, body: serde_json::Value| tauri::webview::InvokeRequest {
            cmd: command.into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
            url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body), headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        };
        assert_ipc_response(&webview, request("wire_sync", serde_json::json!({"itemId":"scene","refuse":false})), Ok(serde_json::json!("7:scene")));
        assert_ipc_response(&webview, request("wire_sync", serde_json::json!({"itemId":"scene","refuse":true})), Err(serde_json::json!({"version":1,"code":"operation_failed","operation":"wire_sync","detail":"refused scene"})));
        assert_ipc_response(&webview, request("wire_async", serde_json::json!({"item_id":"async scene"})), Ok(serde_json::json!("async scene")));
    }

    #[test]
    fn command_failure_identity_does_not_guess_from_diagnostic_text() {
        let error = serde_json::to_value(CommandFailure::operation("doc_flush", "disk, permission, or arbitrary diagnostic")).unwrap();
        assert_eq!(error, serde_json::json!({"version":1,"code":"operation_failed","operation":"doc_flush","detail":"disk, permission, or arbitrary diagnostic"}));
        assert_eq!(serde_json::to_value(CommandFailure::locked("doc_load")).unwrap()["code"], "application_locked");
    }
}
