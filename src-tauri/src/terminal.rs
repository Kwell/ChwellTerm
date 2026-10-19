use std::{collections::HashMap, io::{Read, Write}, path::PathBuf, sync::{Arc, atomic::AtomicBool}, time::Duration};
use base64::{engine::general_purpose::STANDARD, Engine};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use russh::{client, ChannelMsg, Disconnect, keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate}};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;
use crate::config::{Session, atomic_write};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    #[serde(rename = "type")] pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub previous: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub challenge: Option<AuthChallenge>,
}
#[derive(Clone, Serialize)]
pub struct AuthPrompt { pub prompt: String, pub echo: bool }
#[derive(Clone, Serialize)]
pub struct AuthChallenge { pub role: String, pub username: String, pub name: String, pub instructions: String, pub prompts: Vec<AuthPrompt> }
impl TerminalEvent {
    pub fn status(kind: &str, data: Option<String>) -> Self { Self { kind: kind.into(), data, fingerprint: None, previous: None, request_id: None, host: None, challenge: None } }
    fn output(bytes: &[u8]) -> Self { Self::status("data", Some(STANDARD.encode(bytes))) }
}
#[derive(Deserialize)]
pub struct Credentials { pub password: String, pub passphrase: String, pub remember: bool, #[serde(default)] pub jump: Option<Box<Credentials>> }
impl Drop for Credentials { fn drop(&mut self) { self.password.zeroize(); self.passphrase.zeroize(); } }

pub enum Input { Data(String), Resize(u16, u16), OpenEditor(oneshot::Sender<Result<Arc<crate::remote_editor::RemoteEditor>, String>>) }
#[derive(Clone)]
pub struct Control {
    pub verified_hosts: Arc<Mutex<HashMap<String, String>>>,
    pub transfer_identity: Arc<Mutex<String>>,
    pub closing: Arc<AtomicBool>,
    pub input: mpsc::Sender<Input>,
    pub cancel: CancellationToken,
    pub sftp: Arc<Mutex<Option<Arc<SftpSession>>>>,
}
pub struct PendingTrust { pub tab_id: String, pub sender: oneshot::Sender<bool> }
pub struct PendingAuth { pub tab_id: String, pub count: usize, pub sender: oneshot::Sender<Option<zeroize::Zeroizing<Vec<String>>>> }
struct AuthGuard { state: AppState, request_id: String }
impl Drop for AuthGuard { fn drop(&mut self) { self.state.pending_auth.lock().remove(&self.request_id); } }
pub struct TransferTask { pub tab_id: String, pub cancel: CancellationToken, pub pause: CancellationToken, pub discard: Arc<std::sync::atomic::AtomicBool> }
#[derive(Clone)]
pub struct AppState {
    pub uploads: crate::upload_resume::Store,
    pub downloads: crate::download_resume::Store,
    pub transfers: Arc<Mutex<HashMap<String, TransferTask>>>,
    pub sessions: Arc<Mutex<HashMap<String, Control>>>,
    pub pending: Arc<Mutex<HashMap<String, PendingTrust>>>,
    pub pending_auth: Arc<Mutex<HashMap<String, PendingAuth>>>,
    pub trusted: Arc<Mutex<HashMap<String, String>>>,
    pub data_dir: PathBuf,
}

pub struct HostVerifier { state: AppState, host_id: String, tab_id: String, events: Channel<TerminalEvent>, cancel: CancellationToken, verified_hosts: Arc<Mutex<HashMap<String, String>>> }
impl client::Handler for HostVerifier {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        // Pin the actual server public key; certificates are not implicitly trusted through a CA.
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let previous = self.state.trusted.lock().get(&self.host_id).cloned();
        if previous.as_ref() == Some(&fingerprint) { self.verified_hosts.lock().insert(self.host_id.clone(), fingerprint); return Ok(true); }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.state.pending.lock().insert(request_id.clone(), PendingTrust { tab_id: self.tab_id.clone(), sender });
        diagnostic(&self.events, &format!("{} · 等待确认服务器指纹", self.host_id));
        if self.events.send(TerminalEvent { kind: "fingerprint".into(), data: None, fingerprint: Some(fingerprint.clone()), previous, request_id: Some(request_id.clone()), host: Some(self.host_id.clone()), challenge: None }).is_err() {
            self.state.pending.lock().remove(&request_id); return Ok(false);
        }
        let accepted = tokio::select! { result = receiver => result.unwrap_or(false), _ = self.cancel.cancelled() => false, _ = tokio::time::sleep(Duration::from_secs(300)) => false };
        self.state.pending.lock().remove(&request_id);
        if accepted {
            let mut trusted = self.state.trusted.lock();
            let mut updated = trusted.clone(); updated.insert(self.host_id.clone(), fingerprint.clone());
            if let Ok(raw) = serde_json::to_vec_pretty(&updated) {
                if atomic_write(&self.state.data_dir.join("known-hosts.json"), &raw).is_ok() { *trusted = updated; self.verified_hosts.lock().insert(self.host_id.clone(), fingerprint); return Ok(true); }
            }
            let _ = self.events.send(TerminalEvent::status("error", Some("无法保存服务器指纹，连接已取消".into())));
        }
        Ok(false)
    }
}

fn diagnostic(events: &Channel<TerminalEvent>, text: &str) {
    let _ = events.send(TerminalEvent::status("diagnostic", Some(text.into())));
}

// A connection is also disconnected when a handshake, authentication or outer
// cancellation drops the future, including the jump transport.
struct SshConnection(Option<client::Handle<HostVerifier>>);
impl std::ops::Deref for SshConnection {
    type Target = client::Handle<HostVerifier>;
    fn deref(&self) -> &Self::Target { self.0.as_ref().unwrap() }
}
impl std::ops::DerefMut for SshConnection {
    fn deref_mut(&mut self) -> &mut Self::Target { self.0.as_mut().unwrap() }
}
impl Drop for SshConnection {
    fn drop(&mut self) {
        if let Some(ssh) = self.0.take() {
            tokio::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(3), ssh.disconnect(Disconnect::ByApplication, "Connection closed", "en")).await;
            });
        }
    }
}
async fn handshake<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static>(
    socket: S, host: &str, port: u16, id: &str, state: &AppState, control: &Control, events: &Channel<TerminalEvent>,
) -> Result<SshConnection, String> {
    diagnostic(events, &format!("[{host}]:{port} · SSH 握手与指纹验证"));
    let handler = HostVerifier { state: state.clone(), host_id: format!("[{}]:{port}", host.to_lowercase()), tab_id: id.into(), events: events.clone(), cancel: control.cancel.clone(), verified_hosts: control.verified_hosts.clone() };
    let config = client::Config { keepalive_interval: Some(Duration::from_secs(30)), keepalive_max: 3, nodelay: true, ..Default::default() };
    let ssh = tokio::time::timeout(Duration::from_secs(320), client::connect_stream(Arc::new(config), socket, handler)).await
        .map_err(|_| "SSH 握手超时".to_string())?.map_err(|e| format!("SSH 握手或指纹验证失败：{e}"))?;
    Ok(SshConnection(Some(ssh)))
}
async fn tcp(host: &str, port: u16, events: &Channel<TerminalEvent>) -> Result<tokio::net::TcpStream, String> {
    diagnostic(events, &format!("[{host}]:{port} · 解析地址并建立 TCP 连接"));
    tokio::time::timeout(Duration::from_secs(15), tokio::net::TcpStream::connect((host, port))).await
        .map_err(|_| "TCP 连接超时，请检查地址、端口和网络".to_string())?.map_err(|e| format!("TCP 连接失败：{e}"))
}
async fn agent_auth<S: russh::keys::agent::client::AgentStream + Send + Unpin>(
    ssh: &mut client::Handle<HostVerifier>, username: &str, agent: &mut russh::keys::agent::client::AgentClient<S>,
) -> Result<client::AuthResult, String> {
    use russh::keys::agent::AgentIdentity;
    let identities = agent.request_identities().await.map_err(|e| format!("读取 Agent 公钥失败：{e}"))?;
    if identities.is_empty() { return Err("SSH Agent 中没有密钥，请先使用 ssh-add 加载密钥".into()); }
    let hash = ssh.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
    // Certificates need a separate certificate authentication API; never offer
    // their underlying key as if the certificate had been presented.
    let mut offered = 0;
    for identity in identities.into_iter().take(6) {
        if let AgentIdentity::PublicKey { key, .. } = identity {
            offered += 1;
            let result = ssh.authenticate_publickey_with(username, key, hash, agent).await.map_err(|e| format!("Agent 签名失败：{e}"))?;
            if result.success() || needs_interactive(&result) { return Ok(result); }
        }
    }
    if offered == 0 { return Err("Agent 仅提供证书，本版支持普通公钥，请加载普通密钥".into()); }
    Err("服务器拒绝 Agent 密钥（最多尝试 6 个），请检查用户名或调整 ssh-add 中的密钥".into())
}
fn needs_interactive(result: &client::AuthResult) -> bool {
    matches!(result, client::AuthResult::Failure { remaining_methods, partial_success: true } if remaining_methods.iter().any(|m| *m == russh::MethodKind::KeyboardInteractive))
}
pub fn respond_auth(state: &AppState, tab_id: &str, request_id: &str, responses: Option<Vec<String>>) -> Result<(), String> {
    let responses = responses.map(zeroize::Zeroizing::new);
    let mut pending = state.pending_auth.lock();
    let request = pending.get(request_id).ok_or("认证请求已失效")?;
    if request.tab_id != tab_id { return Err("认证请求与会话不匹配".into()); }
    if let Some(values) = &responses {
        if values.len() != request.count || values.iter().any(|v| v.len() > 4096) { return Err("认证回答数量或长度无效".into()); }
    }
    pending.remove(request_id).unwrap().sender.send(responses).map_err(|_| "认证请求已失效".into())
}
async fn ask_auth(state: &AppState, control: &Control, id: &str, host: &str, challenge: AuthChallenge, events: &Channel<TerminalEvent>, timeout: Duration) -> Result<zeroize::Zeroizing<Vec<String>>, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    state.pending_auth.lock().insert(request_id.clone(), PendingAuth { tab_id: id.into(), count: challenge.prompts.len(), sender });
    let _guard = AuthGuard { state: state.clone(), request_id: request_id.clone() };
    let mut event = TerminalEvent::status("auth-challenge", None);
    event.host = Some(host.into()); event.request_id = Some(request_id); event.challenge = Some(challenge);
    events.send(event).map_err(|_| "认证窗口不可用".to_string())?;
    tokio::select! {
        response = receiver => response.ok().flatten().ok_or_else(|| "交互式认证已取消".into()),
        _ = control.cancel.cancelled() => Err("交互式认证已取消".into()),
        _ = tokio::time::sleep(timeout) => Err("交互式认证等待超时，请重新连接".into()),
    }
}
async fn interactive_auth(ssh: &mut client::Handle<HostVerifier>, username: &str, id: &str, host: &str, role: &str, state: &AppState, control: &Control, events: &Channel<TerminalEvent>) -> Result<(), String> {
    let mut response = tokio::time::timeout(Duration::from_secs(30), ssh.authenticate_keyboard_interactive_start(username, None::<String>)).await.map_err(|_| "交互式认证请求超时".to_string())?.map_err(|_| "交互式认证请求失败".to_string())?;
    for _ in 0..32 {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => return Err("交互式认证失败，请检查密码或验证码后重新连接".into()),
            client::KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                if prompts.len() > 16 || name.len() + instructions.len() + prompts.iter().map(|p| p.prompt.len()).sum::<usize>() > 65536 { return Err("服务器认证提示超出支持范围".into()); }
                diagnostic(events, &format!("{role} · 等待交互式认证回答"));
                let challenge = AuthChallenge { role: role.into(), username: username.into(), name, instructions, prompts: prompts.into_iter().map(|p| AuthPrompt { prompt: p.prompt, echo: p.echo }).collect() };
                let mut answers = ask_auth(state, control, id, host, challenge, events, Duration::from_secs(300)).await?;
                // russh owns the protocol response after submission; the UI/IPC copy is cleared here.
                let result = tokio::time::timeout(Duration::from_secs(30), ssh.authenticate_keyboard_interactive_respond(answers.to_vec())).await;
                answers.zeroize();
                response = result.map_err(|_| "交互式认证响应超时".to_string())?.map_err(|_| "交互式认证连接中断".to_string())?;
            }
        }
    }
    Err("交互式认证轮次过多，请检查服务器配置".into())
}
async fn authenticate(ssh: &mut client::Handle<HostVerifier>, username: &str, auth: &str, prepared_key: Option<Arc<russh::keys::PrivateKey>>, credential_id: &str, credentials: &mut Credentials, events: &Channel<TerminalEvent>, id: &str, host: &str, role: &str, state: &AppState, control: &Control) -> Result<(), String> {
    if auth == "keyboard-interactive" { return interactive_auth(ssh, username, id, host, role, state, control, events).await; }
    let auth_result = if auth == "agent" {
        use russh::keys::agent::client::AgentClient;
        tokio::time::timeout(Duration::from_secs(60), async {
            #[cfg(windows)]
            let mut agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await.map_err(|_| "无法连接 Windows OpenSSH Agent，请确认 ssh-agent 服务已启动".to_string())?;
            #[cfg(unix)]
            let mut agent = AgentClient::connect_env().await.map_err(|_| "无法连接 SSH Agent，请确认 SSH_AUTH_SOCK 和 ssh-agent 已就绪".to_string())?;
            agent_auth(ssh, username, &mut agent).await
        }).await.map_err(|_| "Agent 认证超时，请检查 Agent 的签名确认窗口".to_string())??
    } else {
    tokio::time::timeout(Duration::from_secs(30), async {
        let auth_result = match auth {
            "password" => {
                if credentials.password.is_empty() {
                    credentials.password = keyring::Entry::new("terminal-workbench", credential_id).map_err(|e| e.to_string())?.get_password().map_err(|_| "没有已保存密码，请输入密码".to_string())?;
                }
                ssh.authenticate_password(username, &credentials.password).await.map_err(|e| e.to_string())?
            },
            "key" => {
                let key = prepared_key.ok_or("私钥尚未通过本地校验")?;
                let hash = ssh.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
                ssh.authenticate_publickey(username, PrivateKeyWithHashAlg::new(key, hash)).await.map_err(|e| e.to_string())?
            },
            _ => return Err("不支持的认证方式".into()),
        };
        Ok::<_, String>(auth_result)
    }).await.map_err(|_| "认证超时".to_string())??
    };
    let result = complete_auth(&auth_result, ssh, username, id, host, role, state, control, events).await;
    if result.is_ok() {
        if credentials.remember && auth == "password" {
            if keyring::Entry::new("terminal-workbench", credential_id).and_then(|entry| entry.set_password(&credentials.password)).is_err() { diagnostic(events, "系统凭据保存失败，下次连接需要重新输入密码"); }
        }
    }
    credentials.password.zeroize(); credentials.passphrase.zeroize();
    result
}
async fn complete_auth(result: &client::AuthResult, ssh: &mut client::Handle<HostVerifier>, username: &str, id: &str, host: &str, role: &str, state: &AppState, control: &Control, events: &Channel<TerminalEvent>) -> Result<(), String> {
    if needs_interactive(result) { interactive_auth(ssh, username, id, host, role, state, control, events).await }
    else if result.success() { Ok(()) } else { Err("认证失败，请检查用户名、密码或私钥".into()) }
}

async fn prepare_key(auth: &str, path: &str, passphrase: Option<&mut String>, role: &str, events: &Channel<TerminalEvent>) -> Result<Option<Arc<russh::keys::PrivateKey>>, String> {
    if auth != "key" { return Ok(None); }
    diagnostic(events, &format!("{role} · 本地私钥校验"));
    let path = path.to_owned();
    let secret = zeroize::Zeroizing::new(passphrase.map(|value| { let secret = value.clone(); value.zeroize(); secret }).unwrap_or_default());
    let result = tokio::time::timeout(Duration::from_secs(30), tokio::task::spawn_blocking(move || crate::private_key::load(&path, &secret))).await
        .map_err(|_| format!("{role}：私钥校验超时"))?.map_err(|_| format!("{role}：私钥校验任务失败"))?;
    result.map(Some).map_err(|error| format!("{role}：{error}"))
}

pub async fn run_ssh(id: String, session: Session, mut credentials: Credentials, state: AppState, control: Control, mut input: mpsc::Receiver<Input>, events: Channel<TerminalEvent>, cols: u16, rows: u16) -> Result<(), String> {
    let jump_key = if let Some(jump) = &session.jump {
        prepare_key(&jump.auth, &jump.key_path, credentials.jump.as_deref_mut().map(|c| &mut c.passphrase), "跳板机", &events).await?
    } else { None };
    let target_key = prepare_key(&session.auth, &session.key_path, Some(&mut credentials.passphrase), "目标服务器", &events).await?;
    let mut jump_connection = None;
    let mut ssh = if let Some(jump) = &session.jump {
        diagnostic(&events, "跳板机 · 开始连接");
        let socket = tcp(&jump.host, jump.port, &events).await.map_err(|e| format!("跳板机：{e}"))?;
        let mut transport = handshake(socket, &jump.host, jump.port, &id, &state, &control, &events).await.map_err(|e| format!("跳板机：{e}"))?;
        diagnostic(&events, "跳板机 · 认证");
        let mut secret = credentials.jump.take().unwrap_or_else(|| Box::new(Credentials { password: String::new(), passphrase: String::new(), remember: false, jump: None }));
        authenticate(&mut transport, &jump.username, &jump.auth, jump_key, &format!("{}:jump", session.id), &mut secret, &events, &id, &format!("[{}]:{}", jump.host, jump.port), "跳板机", &state, &control).await.map_err(|e| format!("跳板机：{e}"))?;
        diagnostic(&events, &format!("跳板机 · 建立到 [{}]:{} 的转发通道", session.host, session.port));
        let tunnel = tokio::time::timeout(Duration::from_secs(15), transport.channel_open_direct_tcpip(&session.host, session.port.into(), "127.0.0.1", 0)).await
            .map_err(|_| "跳板转发超时".to_string())?.map_err(|e| format!("跳板转发失败，请检查目标可达性和 AllowTcpForwarding：{e}"))?;
        jump_connection = Some(transport);
        handshake(tunnel.into_stream(), &session.host, session.port, &id, &state, &control, &events).await.map_err(|e| format!("目标服务器：{e}"))?
    } else {
        let socket = tcp(&session.host, session.port, &events).await?;
        handshake(socket, &session.host, session.port, &id, &state, &control, &events).await?
    };
    diagnostic(&events, "目标服务器 · 认证");
    authenticate(&mut ssh, &session.username, &session.auth, target_key, &session.id, &mut credentials, &events, &id, &format!("[{}]:{}", session.host, session.port), "目标服务器", &state, &control).await.map_err(|e| format!("目标服务器：{e}"))?;
    {
    let trusted = control.verified_hosts.lock();
    *control.transfer_identity.lock() = serde_json::json!({
        "host": session.host.to_lowercase(), "port": session.port, "user": session.username,
        "fingerprint": trusted.get(&format!("[{}]:{}", session.host.to_lowercase(), session.port)),
        "jump": session.jump.as_ref().map(|jump| serde_json::json!({"host":jump.host.to_lowercase(),"port":jump.port,"user":jump.username,
            "fingerprint":trusted.get(&format!("[{}]:{}", jump.host.to_lowercase(), jump.port))})),
    }).to_string();
    }
    diagnostic(&events, "目标服务器 · 请求 PTY 与交互 shell");
    let mut channel = ssh.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.request_pty(true, "xterm-256color", cols.into(), rows.into(), 0, 0, &[]).await.map_err(|e| e.to_string())?;
    wait_success(&mut channel, &events).await?;
    channel.request_shell(true).await.map_err(|e| e.to_string())?;
    wait_success(&mut channel, &events).await?;
    diagnostic(&events, "目标服务器 · 启动 SFTP");
    // A missing SFTP subsystem must not prevent use of the interactive shell.
    let sftp = tokio::time::timeout(Duration::from_secs(10), async {
        let sf = ssh.channel_open_session().await.map_err(|e| e.to_string())?;
        sf.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
        SftpSession::new(sf.into_stream()).await.map_err(|e| e.to_string())
    }).await;
    if let Ok(Ok(sf)) = sftp { *control.sftp.lock() = Some(Arc::new(sf)); diagnostic(&events, "SFTP 已就绪"); } else { diagnostic(&events, "SFTP 不可用，交互终端仍可使用"); }
    diagnostic(&events, "连接已就绪");
    events.send(TerminalEvent::status("connected", None)).map_err(|e| e.to_string())?;
    let mut editor: Option<Arc<crate::remote_editor::RemoteEditor>> = None;
    loop {
        tokio::select! {
            command = input.recv() => match command {
                Some(Input::Data(data)) => channel.data(data.as_bytes()).await.map_err(|e| e.to_string())?,
                Some(Input::Resize(cols, rows)) => channel.window_change(cols.into(), rows.into(), 0, 0).await.map_err(|e| e.to_string())?,
                Some(Input::OpenEditor(reply)) => {
                    if reply.is_closed() { continue; }
                    let result = if let Some(existing) = &editor { Ok(existing.clone()) } else {
                        tokio::time::timeout(Duration::from_secs(10), async {
                            let sf = ssh.channel_open_session().await.map_err(|e| e.to_string())?;
                            sf.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
                            crate::remote_editor::RemoteEditor::new(sf.into_stream()).await.map(Arc::new)
                        }).await.map_err(|_| "远程编辑通道启动超时".to_string()).and_then(|v| v)
                    };
                    if let Ok(opened) = &result { editor = Some(opened.clone()); }
                    let _ = reply.send(result);
                },
                None => break,
            },
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => { events.send(TerminalEvent::output(&data)).map_err(|e| e.to_string())?; },
                Some(ChannelMsg::Close) | None => break,
                _ => {},
            }
        }
    }
    let _ = ssh.disconnect(Disconnect::ByApplication, "User disconnected", "en").await;
    drop(jump_connection);
    Ok(())
}

async fn wait_success(channel: &mut russh::Channel<client::Msg>, events: &Channel<TerminalEvent>) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => return Err("服务器拒绝了终端请求".into()),
                Some(ChannelMsg::Close) | None => return Err("SSH 通道已关闭".into()),
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => { events.send(TerminalEvent::output(&data)).map_err(|e| e.to_string())?; },
                _ => {},
            }
        }
    }).await.map_err(|_| "终端请求超时".to_string())?
}

struct KillOnDrop(Box<dyn portable_pty::ChildKiller + Send + Sync>);
impl Drop for KillOnDrop { fn drop(&mut self) { let _ = self.0.kill(); } }

pub async fn run_local(control: Control, mut input: mpsc::Receiver<Input>, events: Channel<TerminalEvent>, cols: u16, rows: u16) -> Result<(), String> {
    diagnostic(&events, "本地终端 · 创建 PTY 并启动系统 shell");
    let pair = native_pty_system().openpty(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let shell = if cfg!(windows) { "powershell.exe".to_string() } else { std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() }) };
    let mut command = CommandBuilder::new(shell);
    if cfg!(windows) { command.arg("-NoLogo"); } else { command.arg("-l"); }
    command.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    let _killer = KillOnDrop(child.clone_killer());
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;
    let output_events = events.clone();
    let read_task = tokio::task::spawn_blocking(move || {
        let mut buffer = vec![0u8; 32768];
        loop { match reader.read(&mut buffer) { Ok(0) | Err(_) => break, Ok(n) => { if output_events.send(TerminalEvent::output(&buffer[..n])).is_err() { break; } } } }
    });
    let write_task = tokio::task::spawn_blocking(move || {
        while let Some(command) = input.blocking_recv() {
            match command {
                Input::Data(data) => { if writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).is_err() { break; } },
                Input::Resize(cols, rows) => { let _ = master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }); },
                Input::OpenEditor(reply) => { let _ = reply.send(Err("本地终端不支持远程文件编辑".into())); },
            }
        }
    });
    let wait_task = tokio::task::spawn_blocking(move || child.wait());
    events.send(TerminalEvent::status("connected", None)).map_err(|e| e.to_string())?;
    tokio::select! { _ = control.cancel.cancelled() => {}, result = wait_task => { result.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?; } }
    // Closing the registry sender lets the blocking writer thread exit. Dropping the killer terminates the child.
    drop(write_task); drop(read_task);
    Ok(())
}

#[cfg(test)]
mod tests;
