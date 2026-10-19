mod config;
mod private_key;
mod terminal;
mod transfer;
mod download_resume;
mod upload_resume;
mod remote_editor;
use std::{collections::HashMap, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use parking_lot::Mutex;
use tauri::{Manager, State, ipc::Channel};
use terminal::{AppState, Control, Credentials, Input, TerminalEvent, TransferTask};
use config::{Config, Session};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use russh_sftp::client::SftpSession;
use serde::Serialize;


#[tauri::command]
fn load_config(state: State<AppState>) -> Result<Option<String>, String> {
    match std::fs::read_to_string(state.data_dir.join("config.json")) {
        Ok(value) => Ok(Some(value)), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(e) => Err(e.to_string())
    }
}
#[tauri::command]
fn save_config(state: State<AppState>, json: String) -> Result<(), String> {
    if json.len() > 1_000_000 { return Err("配置文件过大".into()); }
    let config: Config = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if config.version != 1 { return Err("配置版本不支持".into()); }
    config::validate_workspaces(&config)?;
    config::atomic_write(&state.data_dir.join("config.json"), &serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
}
#[tauri::command]
async fn start_terminal(state: State<'_, AppState>, id: String, session: Session, credentials: Credentials, cols: u16, rows: u16, channel: Channel<TerminalEvent>) -> Result<(), String> {
    if cols == 0 || rows == 0 { return Err("无效终端尺寸".into()); }
    if session.kind != "local" && session.kind != "ssh" { return Err("不支持的终端类型".into()); }
    if session.kind == "ssh" && (session.host.trim().is_empty() || session.port == 0 || session.username.is_empty()) { return Err("主机、端口或用户名无效".into()); }
    if session.kind == "ssh" {
        if !["password", "key", "agent", "keyboard-interactive"].contains(&session.auth.as_str()) || (session.auth == "key" && session.key_path.trim().is_empty()) { return Err("认证方式或私钥路径无效".into()); }
        if let Some(jump) = &session.jump {
            if jump.host.trim().is_empty() || jump.port == 0 || jump.username.trim().is_empty() || !["password", "key", "agent", "keyboard-interactive"].contains(&jump.auth.as_str()) || (jump.auth == "key" && jump.key_path.trim().is_empty()) { return Err("跳板机配置无效".into()); }
        }
    }
    let app_state = state.inner().clone();
    let (sender, receiver) = mpsc::channel(256);
    let control = Control { verified_hosts: Arc::new(Mutex::new(HashMap::new())), transfer_identity: Arc::new(Mutex::new(String::new())), closing: Arc::new(AtomicBool::new(false)), input: sender, cancel: CancellationToken::new(), sftp: Arc::new(Mutex::new(None)) };
    { let mut registry = app_state.sessions.lock(); if registry.contains_key(&id) { return Err("终端已在连接或运行，请先关闭".into()); } registry.insert(id.clone(), control.clone()); }
    tauri::async_runtime::spawn(async move {
        let result = if session.kind == "local" { terminal::run_local(control.clone(), receiver, channel.clone(), cols, rows).await } else {
            tokio::select! {
                result = terminal::run_ssh(id.clone(), session, credentials, app_state.clone(), control.clone(), receiver, channel.clone(), cols, rows) => result,
                _ = control.cancel.cancelled() => Ok(()),
            }
        };
        app_state.sessions.lock().remove(&id);
        app_state.pending.lock().retain(|_, request| request.tab_id != id);
        app_state.pending_auth.lock().retain(|_, request| request.tab_id != id);
        *control.sftp.lock() = None;
        drop(control);
        let _ = channel.send(match result { Ok(()) => TerminalEvent::status("closed", None), Err(e) => TerminalEvent::status("error", Some(e)) });
    });
    Ok(())
}
#[tauri::command]
async fn terminal_input(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    if data.len() > 1_000_000 { return Err("输入内容过大".into()); }
    let sender = state.sessions.lock().get(&id).map(|s| s.input.clone()).ok_or("终端未连接")?;
    sender.send(Input::Data(data)).await.map_err(|_| "终端已结束".into())
}
#[tauri::command]
async fn terminal_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 { return Ok(()); }
    let sender = state.sessions.lock().get(&id).map(|s| s.input.clone()).ok_or("终端未连接")?;
    sender.send(Input::Resize(cols, rows)).await.map_err(|_| "终端已结束".into())
}
#[tauri::command]
async fn terminal_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    close_connection(state.inner(), &id).await;
    Ok(())
}
async fn close_connection(state: &AppState, id: &str) {
    let control = state.sessions.lock().get(id).cloned();
    let Some(control) = control else { return; };
    if control.closing.swap(true, Ordering::SeqCst) { return; }
    state.pending.lock().retain(|_, request| request.tab_id != id);
    state.pending_auth.lock().retain(|_, request| request.tab_id != id);
    for task in state.transfers.lock().values().filter(|task| task.tab_id == id) { task.cancel.cancel(); }
    // Keep the SSH transport alive while cancelled uploads close and remove
    // their new file. No new transfer may start once the connection is closing.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(22);
    loop {
        let pending = state.transfers.lock().values().any(|task| task.tab_id == id);
        if !pending || tokio::time::Instant::now() >= deadline { break; }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    control.cancel.cancel();
}
#[tauri::command]
fn trust_host(state: State<AppState>, request_id: String, accept: bool) -> Result<(), String> {
    if let Some(request) = state.pending.lock().remove(&request_id) { request.sender.send(accept).map_err(|_| "连接已取消".into()) } else { Err("指纹确认已失效".into()) }
}
#[tauri::command]
fn respond_auth(state: State<AppState>, tab_id: String, request_id: String, responses: Option<Vec<String>>) -> Result<(), String> {
    terminal::respond_auth(state.inner(), &tab_id, &request_id, responses)
}
#[tauri::command]
fn forget_credential(session_id: String) -> Result<(), String> {
    match keyring::Entry::new("terminal-workbench", &session_id).and_then(|entry| entry.delete_credential()) { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(e) => Err(e.to_string()) }
}
fn sftp(state: &AppState, id: &str) -> Result<Arc<SftpSession>, String> {
    state.sessions.lock().get(id).and_then(|s| s.sftp.lock().clone()).ok_or_else(|| "SFTP 未就绪或服务器未启用 SFTP".to_string())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFile { name: String, size: u64, is_dir: bool }
#[tauri::command]
async fn list_remote(state: State<'_, AppState>, id: String, path: String) -> Result<Vec<RemoteFile>, String> {
    let sf = sftp(state.inner(), &id)?;
    let mut files: Vec<_> = sf.read_dir(path).await.map_err(|e| e.to_string())?.filter_map(|entry| {
        let name = entry.file_name(); if name == "." || name == ".." { return None; } let meta = entry.metadata();
        Some(RemoteFile { name, size: meta.size.unwrap_or(0), is_dir: meta.file_type().is_dir() })
    }).collect();
    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(files)
}
struct TransferGuard { state: AppState, id: String }
impl Drop for TransferGuard { fn drop(&mut self) { self.state.transfers.lock().remove(&self.id); } }
fn register_transfer(state: &AppState, id: &str, transfer_id: &str) -> Result<(CancellationToken, TransferGuard), String> {
    if transfer_id.is_empty() || transfer_id.len() > 128 { return Err("无效传输 ID".into()); }
    let sessions = state.sessions.lock();
    let session = sessions.get(id).ok_or("终端已断开")?;
    if session.closing.load(Ordering::SeqCst) { return Err("终端正在关闭，不能开始新传输".into()); }
    let cancel = session.cancel.child_token();
    let mut tasks = state.transfers.lock();
    if tasks.contains_key(transfer_id) { return Err("传输 ID 已在使用".into()); }
    tasks.insert(transfer_id.into(), TransferTask { tab_id: id.into(), cancel: cancel.clone(), pause: CancellationToken::new(), discard: Arc::new(AtomicBool::new(false)) });
    Ok((cancel, TransferGuard { state: state.clone(), id: transfer_id.into() }))
}
#[tauri::command]
async fn cancel_transfer(state: State<'_, AppState>, transfer_id: String) -> Result<(), String> {
    let active = { let tasks = state.transfers.lock(); if let Some(task) = tasks.get(&transfer_id) { task.discard.store(true, Ordering::SeqCst); task.cancel.cancel(); true } else { false } };
    state.downloads.lock().remove(&transfer_id);
    if active { return Ok(()); }
    let checkpoint = { state.uploads.lock().get(&transfer_id).map(|cp| (cp.tab_id.clone(), cp.temp.clone(), cp.created)) };
    if let Some((tab_id, temp, created)) = checkpoint {
        if !created { state.uploads.lock().remove(&transfer_id); return Ok(()); }
        let sf = sftp(state.inner(), &tab_id).map_err(|e| format!("{e}；未清理 {temp}，请在原标签重连后再次取消"))?;
        let (_cancel, _guard) = register_transfer(state.inner(), &tab_id, &transfer_id)?;
        let (owner, _) = download_context(state.inner(), &tab_id, &transfer_id)?;
        upload_resume::cancel(&state.uploads, &transfer_id, &owner, &sf).await?;
    }
    Ok(())
}
#[tauri::command]
fn pause_transfer(state: State<AppState>, transfer_id: String) {
    if let Some(task) = state.transfers.lock().get(&transfer_id) { task.pause.cancel(); }
}
fn download_context(state: &AppState, id: &str, transfer_id: &str) -> Result<(String, download_resume::DownloadControl), String> {
    let owner = state.sessions.lock().get(id).map(|s| s.transfer_identity.lock().clone()).ok_or("终端已断开")?;
    if owner.is_empty() { return Err("传输连接身份未就绪".into()); }
    let tasks = state.transfers.lock(); let task = tasks.get(transfer_id).ok_or("传输未注册")?;
    Ok((format!("{id}:{owner}"), download_resume::DownloadControl { cancel: task.cancel.clone(), pause: task.pause.clone(), discard: task.discard.clone() }))
}
#[tauri::command]
async fn upload_remote(state: State<'_, AppState>, id: String, transfer_id: String, local_path: String, remote_dir: String, resumable: Option<bool>, channel: Channel<transfer::TransferProgress>) -> Result<String, String> {
    let sf = sftp(state.inner(), &id)?;
    let (cancel, _guard) = register_transfer(state.inner(), &id, &transfer_id)?;
    if resumable.unwrap_or(false) {
        let (owner, control) = download_context(state.inner(), &id, &transfer_id)?;
        upload_resume::run(&state.uploads, &transfer_id, &id, &owner, &sf, local_path.into(), &remote_dir, &control, transfer::reporter(channel)).await
    } else { transfer::upload(&sf, &local_path, &remote_dir, &cancel, transfer::reporter(channel)).await }
}
#[tauri::command]
async fn download_remote(state: State<'_, AppState>, id: String, transfer_id: String, local_path: String, remote_path: String, resumable: Option<bool>, channel: Channel<transfer::TransferProgress>) -> Result<(), String> {
    let sf = sftp(state.inner(), &id)?;
    let (cancel, _guard) = register_transfer(state.inner(), &id, &transfer_id)?;
    if resumable.unwrap_or(false) {
        let (owner, control) = download_context(state.inner(), &id, &transfer_id)?;
        download_resume::run(&state.downloads, &transfer_id, &owner, &sf, local_path.into(), &remote_path, true, &control, transfer::reporter(channel)).await
    } else { transfer::download(&sf, &local_path, &remote_path, &cancel, transfer::reporter(channel)).await }
}
#[tauri::command]
async fn download_remote_batch(state: State<'_, AppState>, id: String, transfer_id: String, target_dir: String, remote_path: String, resumable: Option<bool>, channel: Channel<transfer::TransferProgress>) -> Result<(), String> {
    let sf = sftp(state.inner(), &id)?;
    let (cancel, _guard) = register_transfer(state.inner(), &id, &transfer_id)?;
    if resumable.unwrap_or(false) {
        let (owner, control) = download_context(state.inner(), &id, &transfer_id)?;
        let target = transfer::batch_target(&target_dir, &remote_path)?;
        download_resume::run(&state.downloads, &transfer_id, &owner, &sf, target, &remote_path, false, &control, transfer::reporter(channel)).await
    } else { transfer::download_batch(&sf, &target_dir, &remote_path, &cancel, transfer::reporter(channel)).await }
}
async fn editor_channel(state: &AppState, id: &str) -> Result<Arc<remote_editor::RemoteEditor>, String> {
    let sender = state.sessions.lock().get(id).filter(|s| !s.closing.load(Ordering::SeqCst)).map(|s| s.input.clone()).ok_or("终端已断开或正在关闭")?;
    let (reply, receiver) = tokio::sync::oneshot::channel();
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        sender.send(Input::OpenEditor(reply)).await.map_err(|_| "终端已断开".to_string())?;
        receiver.await.map_err(|_| "远程编辑通道已关闭".to_string())?
    }).await.map_err(|_| "远程编辑通道请求超时".to_string())?
}
#[tauri::command]
async fn read_remote_text(state: State<'_, AppState>, id: String, path: String) -> Result<remote_editor::RemoteDocument, String> {
    let (cancel, _guard) = register_transfer(state.inner(), &id, &uuid::Uuid::new_v4().to_string())?;
    let editor = editor_channel(state.inner(), &id).await?;
    editor.read(&path, &cancel).await
}
#[tauri::command]
async fn save_remote_text(state: State<'_, AppState>, id: String, path: String, content: String, revision: String) -> Result<remote_editor::SaveResult, String> {
    let (cancel, _guard) = register_transfer(state.inner(), &id, &uuid::Uuid::new_v4().to_string())?;
    let editor = editor_channel(state.inner(), &id).await?;
    editor.save(&path, content, &revision, &cancel).await
}
#[cfg(test)]
pub(crate) async fn upload_to(sf: &SftpSession, local_path: &str, remote_dir: &str) -> Result<String, String> {
    transfer::upload(sf, local_path, remote_dir, &CancellationToken::new(), |_| Ok(())).await
}
#[cfg(test)]
pub(crate) async fn download_from(sf: &SftpSession, local_path: &str, remote_path: &str) -> Result<(), String> {
    transfer::download(sf, local_path, remote_path, &CancellationToken::new(), |_| Ok(())).await
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshConfigSource { text: String, username: String, home: String }
#[tauri::command]
async fn read_ssh_config(app: tauri::AppHandle, path: String) -> Result<SshConfigSource, String> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(1_000_001).read_to_end(&mut bytes).await.map_err(|e| e.to_string())?;
    if bytes.len() > 1_000_000 { return Err("配置文件过大".into()); }
    let text = String::from_utf8(bytes).map_err(|_| "配置文件需要 UTF-8 编码".to_string())?;
    let username = std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_default();
    Ok(SshConfigSource { text, username, home: app.path().home_dir().map_err(|e| e.to_string())?.to_string_lossy().into() })
}

pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let saved_theme = std::fs::read(data_dir.join("config.json")).ok()
                .and_then(|raw| serde_json::from_slice::<Config>(&raw).ok())
                .filter(|config| config.version == 1)
                .map(|config| config.settings.theme);
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.set_theme(Some(if saved_theme.as_deref() == Some("light") { tauri::Theme::Light } else { tauri::Theme::Dark })) {
                    eprintln!("Unable to apply initial window theme: {error}");
                }
            }
            let trusted = config::read_known_hosts(&data_dir.join("known-hosts.json")).map_err(std::io::Error::other)?;
            app.manage(AppState { uploads: Arc::new(Mutex::new(HashMap::new())), downloads: Arc::new(Mutex::new(HashMap::new())), transfers: Arc::new(Mutex::new(HashMap::new())), sessions: Arc::new(Mutex::new(HashMap::new())), pending: Arc::new(Mutex::new(HashMap::new())), pending_auth: Arc::new(Mutex::new(HashMap::new())), trusted: Arc::new(Mutex::new(trusted)), data_dir });
            Ok(())
        })
        .on_window_event(|window, event| { if matches!(event, tauri::WindowEvent::Destroyed) { let state = window.state::<AppState>(); for control in state.sessions.lock().values() { control.cancel.cancel(); } for task in state.transfers.lock().values() { task.discard.store(true, Ordering::SeqCst); task.cancel.cancel(); } state.downloads.lock().clear(); state.pending.lock().clear(); state.pending_auth.lock().clear(); } })
        .invoke_handler(tauri::generate_handler![load_config, save_config, start_terminal, terminal_input, terminal_resize, terminal_close, trust_host, respond_auth, forget_credential, list_remote, upload_remote, download_remote, download_remote_batch, cancel_transfer, pause_transfer, read_ssh_config, read_remote_text, save_remote_text])
        .run(tauri::generate_context!()).expect("Unable to launch ChwellTerm");
}

#[cfg(test)]
mod transfer_registry_tests {
    use super::*;
    #[tokio::test]
    async fn closing_a_connection_waits_for_its_transfers_and_does_not_cancel_another_connection() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState { uploads: Arc::new(Mutex::new(HashMap::new())), downloads: Arc::new(Mutex::new(HashMap::new())), transfers: Arc::new(Mutex::new(HashMap::new())), sessions: Arc::new(Mutex::new(HashMap::new())), pending: Arc::new(Mutex::new(HashMap::new())), pending_auth: Arc::new(Mutex::new(HashMap::new())), trusted: Arc::new(Mutex::new(HashMap::new())), data_dir: dir.path().into() };
        let make = || { let (input, _rx) = mpsc::channel(1); Control { verified_hosts: Arc::new(Mutex::new(HashMap::new())), transfer_identity: Arc::new(Mutex::new(String::new())), input, closing: Arc::new(AtomicBool::new(false)), cancel: CancellationToken::new(), sftp: Arc::new(Mutex::new(None)) } };
        let first = make(); state.sessions.lock().insert("first".into(), first.clone()); state.sessions.lock().insert("second".into(), make());
        let (cancel_first, guard) = register_transfer(&state, "first", "upload").unwrap();
        let (cancel_second, _other_guard) = register_transfer(&state, "second", "download").unwrap();
        assert!(register_transfer(&state, "first", "upload").is_err());
        let closing_state = state.clone();
        let closing = tokio::spawn(async move { close_connection(&closing_state, "first").await; });
        tokio::time::timeout(std::time::Duration::from_secs(1), cancel_first.cancelled()).await.unwrap();
        assert!(!cancel_second.is_cancelled());
        assert!(!first.cancel.is_cancelled(), "transport must remain open during cleanup");
        assert!(register_transfer(&state, "first", "new").is_err());
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), closing).await.unwrap().unwrap();
        assert!(first.cancel.is_cancelled());
        assert!(!cancel_second.is_cancelled());
        assert!(!state.transfers.lock().contains_key("upload"));
    }
}
