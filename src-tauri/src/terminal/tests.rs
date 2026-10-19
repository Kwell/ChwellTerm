use super::*;
use russh::{server, ChannelId, Channel as SshChannel, Pty};
use russh_sftp::protocol::{Attrs, Data, OpenFlags, File as ProtocolFile, FileAttributes, Handle, Name, Status, StatusCode, Version};
use tauri::ipc::InvokeResponseBody;
include!("editor_tests.rs");
include!("download_tests.rs");
include!("upload_tests.rs");

#[derive(Default)]
struct TestServer { channels: HashMap<ChannelId, SshChannel<server::Msg>>, forwarded: std::collections::HashSet<ChannelId>, auth_mode: u8, auth_round: u8 }
impl TestServer {
    fn primary_auth(&self) -> server::Auth {
        if self.auth_mode == 2 { let mut methods = russh::MethodSet::empty(); methods.push(russh::MethodKind::KeyboardInteractive); server::Auth::Reject { proceed_with_methods: Some(methods), partial_success: true } }
        else { server::Auth::Accept }
    }
}
impl server::Handler for TestServer {
    type Error = russh::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<server::Auth, Self::Error> {
        Ok(if user == "test" && password == "test-password" { self.primary_auth() } else { server::Auth::reject() })
    }
    async fn auth_publickey(&mut self, user: &str, _: &russh::keys::PublicKey) -> Result<server::Auth, Self::Error> {
        Ok(if user == "test" { self.primary_auth() } else { server::Auth::reject() })
    }
    async fn auth_keyboard_interactive<'a>(&'a mut self, user: &str, _: &str, response: Option<server::Response<'a>>) -> Result<server::Auth, Self::Error> {
        use std::borrow::Cow;
        if user != "test" || self.auth_mode == 0 { return Ok(server::Auth::reject()); }
        let challenge = |prompts: Vec<(Cow<'static, str>, bool)>| server::Auth::Partial { name: "Test authentication".into(), instructions: "服务器提示：请完成认证".into(), prompts: Cow::Owned(prompts) };
        let answers = response.map(|r| r.map(|b| b.to_vec()).collect::<Vec<_>>());
        if self.auth_mode == 1 {
            match self.auth_round {
                0 => { self.auth_round = 1; return Ok(challenge(vec![])); }
                1 if answers.as_ref().is_some_and(|a| a.is_empty()) => { self.auth_round = 2; return Ok(challenge(vec![("Account:".into(), true), ("Password:".into(), false)])); }
                2 if answers.as_ref().is_some_and(|a| a == &[b"test".to_vec(), b"test-password".to_vec()]) => { self.auth_round = 3; return Ok(challenge(vec![("[OTP Code]:".into(), false)])); }
                3 if answers.as_ref().is_some_and(|a| a == &[b"654321".to_vec()]) => return Ok(server::Auth::Accept),
                _ => return Ok(server::Auth::reject()),
            }
        }
        if answers.is_none() { return Ok(challenge(vec![("[OTP Code]:".into(), false)])); }
        Ok(if answers.unwrap() == vec![b"654321".to_vec()] { server::Auth::Accept } else { server::Auth::reject() })
    }
    async fn channel_open_session(&mut self, channel: SshChannel<server::Msg>, reply: server::ChannelOpenHandle, _: &mut server::Session) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel); reply.accept().await; Ok(())
    }
    async fn channel_open_direct_tcpip(&mut self, channel: SshChannel<server::Msg>, host: &str, port: u32, _: &str, _: u32, reply: server::ChannelOpenHandle, _: &mut server::Session) -> Result<(), Self::Error> {
        // Only loopback targets are allowed in this isolated test server.
        if host != "127.0.0.1" { return Ok(()); }
        if let Ok(mut socket) = tokio::net::TcpStream::connect((host, port as u16)).await {
            self.forwarded.insert(channel.id());
            reply.accept().await;
            tokio::spawn(async move { let _ = tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut socket).await; });
        }
        Ok(())
    }
    async fn pty_request(&mut self, channel: ChannelId, _: &str, _: u32, _: u32, _: u32, _: u32, _: &[(Pty, u32)], session: &mut server::Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?; Ok(())
    }
    async fn shell_request(&mut self, channel: ChannelId, session: &mut server::Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?; session.data(channel, b"test shell ready\r\n".to_vec())?; Ok(())
    }
    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut server::Session) -> Result<(), Self::Error> {
        if self.forwarded.contains(&channel) { return Ok(()); }
        session.data(channel, data.to_vec())?; Ok(())
    }
    async fn subsystem_request(&mut self, channel: ChannelId, name: &str, session: &mut server::Session) -> Result<(), Self::Error> {
        if name == "sftp" {
            session.channel_success(channel)?;
            let channel = self.channels.remove(&channel).unwrap();
            tokio::spawn(async move { russh_sftp::server::run(channel.into_stream(), TestSftp::default()).await; });
        } else { session.channel_failure(channel)?; } Ok(())
    }
}
struct TestSftp { rename_collision: bool, deny_part_remove: bool, write_ack_lost: bool, copy_change: bool, reads_from_zero: usize, done: bool, files: HashMap<String, Vec<u8>>, attrs: HashMap<String, FileAttributes>, no_atomic: bool, fail_write: bool, fail_permissions: bool, race_reads: usize, fail_backup: bool, cancel_write: Option<CancellationToken>, probe: Option<Arc<Mutex<HashMap<String, Vec<u8>>>>> }
impl Default for TestSftp {
    fn default() -> Self { Self { rename_collision: false, deny_part_remove: false, write_ack_lost: false, copy_change: false, reads_from_zero: 0, done: false, files: HashMap::from([("/edit.txt".into(), "\u{feff}中文\r\noriginal\r\n".as_bytes().to_vec())]), attrs: HashMap::new(), no_atomic: false, fail_write: false, fail_permissions: false, race_reads: 0, fail_backup: false, cancel_write: None, probe: None } }
}
impl russh_sftp::server::Handler for TestSftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error { StatusCode::OpUnsupported }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, Self::Error> { let mut version = Version::new(); if !self.no_atomic { version.extensions.insert("posix-rename@openssh.com".into(), "1".into()); } Ok(version) }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> { self.done = false; Ok(Handle { id, handle: path }) }
    async fn readdir(&mut self, id: u32, _: String) -> Result<Name, Self::Error> {
        if self.done { return Err(StatusCode::Eof); } self.done = true;
        let mut attrs = FileAttributes::default(); attrs.size = Some(42); attrs.set_regular(true);
        Ok(Name { id, files: vec![ProtocolFile::new("中文.txt", attrs)] })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> { Ok(Status { id, status_code: StatusCode::Ok, error_message: "".into(), language_tag: "en".into() }) }
    async fn open(&mut self, id: u32, filename: String, flags: OpenFlags, attrs: FileAttributes) -> Result<Handle, Self::Error> {
        if filename == "/readonly.txt" && flags.contains(OpenFlags::WRITE) { return Err(StatusCode::PermissionDenied); }
        if flags.contains(OpenFlags::EXCLUDE) && self.files.contains_key(&filename) { return Err(StatusCode::Failure); }
        if flags.contains(OpenFlags::CREATE) { self.files.entry(filename.clone()).or_default(); self.attrs.insert(filename.clone(), attrs); }
        if let Some(probe) = &self.probe { *probe.lock() = self.files.clone(); }
        if !self.files.contains_key(&filename) { return Err(StatusCode::NoSuchFile); }
        Ok(Handle { id, handle: filename })
    }
    async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status, Self::Error> {
        if handle == "/broken.txt" || (self.fail_write && handle.ends_with(".tmp")) || (self.fail_backup && handle.ends_with(".bak")) { return Err(StatusCode::Failure); }
        let file = self.files.get_mut(&handle).ok_or(StatusCode::NoSuchFile)?;
        let offset = offset as usize; file.resize(file.len().max(offset + data.len()), 0); file[offset..offset + data.len()].copy_from_slice(&data);
        if let Some(probe) = &self.probe { *probe.lock() = self.files.clone(); }
        if self.write_ack_lost && handle.ends_with(".part") { self.write_ack_lost = false; return Err(StatusCode::Failure); }
        if handle.ends_with(".tmp") { if let Some(cancel) = &self.cancel_write { cancel.cancel(); } }
        Ok(Status { id, status_code: StatusCode::Ok, error_message: "".into(), language_tag: "en".into() })
    }
    async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, Self::Error> {
        if handle == "/data.bin" && self.copy_change {
            if offset == 0 { self.reads_from_zero += 1; }
            if self.reads_from_zero >= 2 && offset >= 65536 { if let Some(byte) = self.files.get_mut(&handle).unwrap().get_mut(offset as usize) { *byte ^= 0x55; } }
        }
        let file = self.files.get(&handle).ok_or(StatusCode::NoSuchFile)?;
        let offset = offset as usize; if offset >= file.len() { return Err(StatusCode::Eof); }
        Ok(Data { id, data: file[offset..(offset + len as usize).min(file.len())].to_vec() })
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let mut attrs = self.attrs.get(&handle).cloned().unwrap_or_default(); attrs.size = Some(self.files.get(&handle).ok_or(StatusCode::NoSuchFile)?.len() as u64); attrs.permissions = Some(0o100000 | attrs.permissions.unwrap_or(0o640)); attrs.uid = Some(attrs.uid.unwrap_or(1000)); attrs.gid = Some(attrs.gid.unwrap_or(1000)); attrs.mtime = Some(1);
        Ok(Attrs { id, attrs })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> { self.fstat(id, path).await }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        if path == "/race.txt" { self.race_reads += 1; if self.race_reads == 5 { self.files.insert(path.clone(), b"external change".to_vec()); } }
        let mut value = self.fstat(id, path.clone()).await?;
        if path == "/link.txt" { value.attrs.permissions = Some(0o120777); }
        if path == "/folder" { value.attrs.permissions = Some(0o40755); }
        Ok(value)
    }
    async fn fsetstat(&mut self, id: u32, handle: String, attrs: FileAttributes) -> Result<Status, Self::Error> {
        if self.fail_permissions { return Err(StatusCode::PermissionDenied); }
        let existing = self.attrs.entry(handle).or_default();
        if attrs.permissions.is_some() { existing.permissions = attrs.permissions; }
        if attrs.uid.is_some() { existing.uid = attrs.uid; }
        if attrs.gid.is_some() { existing.gid = attrs.gid; }
        Ok(Status { id, status_code: StatusCode::Ok, error_message: "".into(), language_tag: "en".into() })
    }
    async fn extended(&mut self, id: u32, request: String, data: Vec<u8>) -> Result<russh_sftp::protocol::Packet, Self::Error> {
        if request != "posix-rename@openssh.com" || self.no_atomic { return Err(StatusCode::OpUnsupported); }
        let mut slice = data.as_slice();
        let mut string = || -> Result<String, StatusCode> { if slice.len() < 4 { return Err(StatusCode::BadMessage); } let len = u32::from_be_bytes(slice[..4].try_into().unwrap()) as usize; slice = &slice[4..]; if slice.len() < len { return Err(StatusCode::BadMessage); } let value = String::from_utf8(slice[..len].to_vec()).map_err(|_| StatusCode::BadMessage)?; slice = &slice[len..]; Ok(value) };
        let old = string()?; let new = string()?;
        if new == "/rename-fail.txt" { return Err(StatusCode::PermissionDenied); }
        let bytes = self.files.remove(&old).ok_or(StatusCode::NoSuchFile)?; self.files.insert(new.clone(), bytes);
        if let Some(attrs) = self.attrs.remove(&old) { self.attrs.insert(new, attrs); }
        if let Some(probe) = &self.probe { *probe.lock() = self.files.clone(); }
        Ok(Status { id, status_code: StatusCode::Ok, error_message: "".into(), language_tag: "en".into() }.into())
    }
    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        if filename == "/uncleanable.txt" || (self.deny_part_remove && filename.ends_with(".part")) { return Err(StatusCode::PermissionDenied); }
        self.files.remove(&filename).ok_or(StatusCode::NoSuchFile)?;
        if let Some(probe) = &self.probe { *probe.lock() = self.files.clone(); }
        Ok(Status { id, status_code: StatusCode::Ok, error_message: "".into(), language_tag: "en".into() })
    }
    async fn rename(&mut self, id: u32, oldpath: String, newpath: String) -> Result<Status, Self::Error> {
        if self.rename_collision { self.files.insert(newpath.clone(), b"late competitor".to_vec()); if let Some(probe) = &self.probe { *probe.lock() = self.files.clone(); } }
        if self.files.contains_key(&newpath) { return Err(StatusCode::Failure); }
        if newpath == "/rename-fail.txt" { return Err(StatusCode::PermissionDenied); }
        let bytes = self.files.remove(&oldpath).ok_or(StatusCode::NoSuchFile)?;
        self.files.insert(newpath.clone(), bytes);
        if let Some(attrs) = self.attrs.remove(&oldpath) { self.attrs.insert(newpath, attrs); }
        if let Some(probe) = &self.probe { *probe.lock() = self.files.clone(); }
        Ok(Status { id, status_code: StatusCode::Ok, error_message: "".into(), language_tag: "en".into() })
    }
}
async fn server_socket() -> (u16, tokio::task::JoinHandle<()>) { server_socket_mode(0).await }
async fn server_socket_mode(auth_mode: u8) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(server::Config { keys: vec![russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap()], auth_rejection_time: Duration::ZERO, auth_rejection_time_initial: Some(Duration::ZERO), ..Default::default() });
    let task = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = config.clone(); tokio::spawn(async move { if let Ok(session) = server::run_stream(config, socket, TestServer { auth_mode, ..Default::default() }).await { let _ = session.await; } });
        }
    });
    (port, task)
}
fn state(dir: &std::path::Path) -> AppState { AppState { uploads: Arc::new(Mutex::new(HashMap::new())), downloads: Arc::new(Mutex::new(HashMap::new())), transfers: Arc::new(Mutex::new(HashMap::new())), data_dir: dir.into(), sessions: Arc::new(Mutex::new(HashMap::new())), pending: Arc::new(Mutex::new(HashMap::new())), pending_auth: Arc::new(Mutex::new(HashMap::new())), trusted: Arc::new(Mutex::new(HashMap::new())) } }
fn events() -> (Channel<TerminalEvent>, mpsc::UnboundedReceiver<serde_json::Value>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Channel::new(move |body| { if let InvokeResponseBody::Json(json) = body { let _ = tx.send(serde_json::from_str(&json).unwrap()); } Ok(()) }), rx)
}
fn control() -> (Control, mpsc::Receiver<Input>) {
    let (input, rx) = mpsc::channel(256); (Control { verified_hosts: Arc::new(Mutex::new(HashMap::new())), transfer_identity: Arc::new(Mutex::new(String::new())), closing: Arc::new(AtomicBool::new(false)), input, cancel: CancellationToken::new(), sftp: Arc::new(Mutex::new(None)) }, rx)
}
fn session(port: u16) -> Session { Session { id: "test-session".into(), name: "test".into(), host: "127.0.0.1".into(), port, username: "test".into(), environment: "development".into(), auth: "password".into(), key_path: "".into(), kind: "ssh".into(), jump: None } }
async fn next_event(rx: &mut mpsc::UnboundedReceiver<serde_json::Value>, kind: &str) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(20), async { loop { let event = rx.recv().await.expect("event channel closed"); if event["type"] == kind { return event; } } }).await.expect("event timed out")
}
async fn accept_fingerprint(state: &AppState, rx: &mut mpsc::UnboundedReceiver<serde_json::Value>) -> serde_json::Value {
    let event = next_event(rx, "fingerprint").await;
    let request = state.pending.lock().remove(event["requestId"].as_str().unwrap()).unwrap(); request.sender.send(true).unwrap(); event
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keyboard_interactive_multiround_and_jump() {
    let (jump_port, jump_server) = server_socket_mode(3).await;
    let (port, server) = server_socket_mode(1).await;
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path());
    let (control, input) = control(); let (events, mut rx) = events();
    let mut config = session(port); config.auth = "keyboard-interactive".into();
    config.jump = Some(crate::config::JumpHost { host: "127.0.0.1".into(), port: jump_port, username: "test".into(), auth: "keyboard-interactive".into(), key_path: "".into() });
    let task = tokio::spawn(run_ssh("otp".into(), config, Credentials { password: "".into(), passphrase: "".into(), remember: false, jump: None }, state.clone(), control.clone(), input, events, 80, 24));
    accept_fingerprint(&state, &mut rx).await;
    let event = next_event(&mut rx, "auth-challenge").await;
    assert_eq!(event["challenge"]["role"], "跳板机");
    respond_auth(&state, "otp", event["requestId"].as_str().unwrap(), Some(vec!["654321".into()])).unwrap();
    accept_fingerprint(&state, &mut rx).await;
    for answers in [vec![], vec!["test".into(), "test-password".into()], vec!["654321".into()]] {
        let event = next_event(&mut rx, "auth-challenge").await;
        assert_eq!(event["challenge"]["role"], "目标服务器");
        assert_eq!(event["challenge"]["prompts"].as_array().unwrap().len(), answers.len());
        let request = event["requestId"].as_str().unwrap();
        assert!(respond_auth(&state, "different-tab", request, Some(answers.clone())).is_err());
        assert!(respond_auth(&state, "otp", request, Some(vec!["wrong count".into(); 17])).is_err());
        respond_auth(&state, "otp", request, Some(answers)).unwrap();
        assert!(respond_auth(&state, "otp", request, None).is_err(), "a request must be single use");
    }
    next_event(&mut rx, "connected").await;
    assert!(control.sftp.lock().is_some()); assert!(state.pending_auth.lock().is_empty());
    let saved = std::fs::read_to_string(dir.path().join("known-hosts.json")).unwrap();
    assert!(!saved.contains("654321") && !saved.contains("test-password"));
    task.abort(); server.abort(); jump_server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_success_continuation_uses_real_keyboard_interactive_transport() {
    let (port, server) = server_socket_mode(2).await;
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path());
    let (control, _) = control(); let (events, mut rx) = events();
    let continuation_state = state.clone();
    let task = tokio::spawn(async move {
        let socket = tcp("127.0.0.1", port, &events).await.unwrap();
        let mut ssh = handshake(socket, "127.0.0.1", port, "mfa", &continuation_state, &control, &events).await.unwrap();
        // russh 0.63's TEST SERVER resets partial_success to false for password/key.
        // Supply the protocol result explicitly; continuation still uses real encrypted SSH.
        let primary = ssh.authenticate_password("test", "test-password").await.unwrap();
        let client::AuthResult::Failure { remaining_methods, .. } = primary else { panic!("expected second factor"); };
        let result = client::AuthResult::Failure { remaining_methods: remaining_methods.clone(), partial_success: true };
        assert!(needs_interactive(&result));
        assert!(!needs_interactive(&client::AuthResult::Failure { remaining_methods, partial_success: false }));
        assert!(!needs_interactive(&client::AuthResult::Success));
        complete_auth(&result, &mut ssh, "test", "mfa", "localhost", "目标服务器", &continuation_state, &control, &events).await.unwrap();
        ssh.channel_open_session().await.unwrap();
    });
    accept_fingerprint(&state, &mut rx).await;
    let event = next_event(&mut rx, "auth-challenge").await;
    respond_auth(&state, "mfa", event["requestId"].as_str().unwrap(), Some(vec!["654321".into()])).unwrap();
    tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap(); server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn otp_rejection_cancel_and_dropped_connection_clear_pending_requests() {
    for action in ["wrong", "cancel", "drop"] {
        let (port, server) = server_socket_mode(3).await;
        let dir = tempfile::tempdir().unwrap(); let state = state(dir.path());
        let (control, input) = control(); let (events, mut rx) = events();
        let mut config = session(port); config.auth = "keyboard-interactive".into();
        let task = tokio::spawn(run_ssh("failure".into(), config, Credentials { password: "".into(), passphrase: "".into(), remember: false, jump: None }, state.clone(), control, input, events, 80, 24));
        accept_fingerprint(&state, &mut rx).await;
        let event = next_event(&mut rx, "auth-challenge").await;
        if action == "drop" { task.abort(); let _ = task.await; }
        else {
            respond_auth(&state, "failure", event["requestId"].as_str().unwrap(), if action == "cancel" { None } else { Some(vec!["wrong-otp".into()]) }).unwrap();
            let error = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
            assert!(error.contains(if action == "cancel" { "取消" } else { "认证失败" })); assert!(!error.contains("wrong-otp"));
        }
        assert!(state.pending_auth.lock().is_empty()); server.abort();
    }
}

#[tokio::test]
async fn auth_timeout_and_cancellation_clean_up_without_recording_answers() {
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path());
    let (control, _) = control(); let (events, mut rx) = events();
    for cancel in [false, true] {
        let mut challenge = AuthChallenge { role: "目标服务器".into(), username: "test".into(), name: "".into(), instructions: "".into(), prompts: vec![AuthPrompt { prompt: "OTP".into(), echo: false }] };
        if cancel { control.cancel.cancel(); challenge.name = "cancel".into(); }
        let error = ask_auth(&state, &control, "timeout", "localhost", challenge, &events, Duration::from_millis(10)).await.unwrap_err();
        assert!(error.contains(if cancel { "取消" } else { "超时" })); assert!(state.pending_auth.lock().is_empty());
        let _ = next_event(&mut rx, "auth-challenge").await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_password_fingerprint_unicode_data_and_sftp() {
    let (port, server) = server_socket().await;
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path()); let (control, input) = control(); let (events, mut rx) = events();
    let task = tokio::spawn(run_ssh("one".into(), session(port), Credentials { password: "test-password".into(), passphrase: "".into(), remember: false, jump: None }, state.clone(), control.clone(), input, events, 80, 24));
    let event = accept_fingerprint(&state, &mut rx).await; assert!(event["previous"].is_null());
    next_event(&mut rx, "connected").await;
    assert_eq!(crate::config::read_known_hosts(&dir.path().join("known-hosts.json")).unwrap().len(), 1);
    control.input.send(Input::Resize(120, 32)).await.unwrap();
    control.input.send(Input::Data("中文测试\r".into())).await.unwrap();
    let mut output = Vec::new();
    while !String::from_utf8_lossy(&output).contains("中文测试") { let event = next_event(&mut rx, "data").await; output.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap()); }
    let identity: serde_json::Value = serde_json::from_str(&control.transfer_identity.lock()).unwrap();
    assert_eq!(identity["host"], "127.0.0.1"); assert_eq!(identity["user"], "test");
    assert_eq!(identity["fingerprint"].as_str(), state.trusted.lock().values().next().map(String::as_str));
    let sftp = control.sftp.lock().clone().unwrap(); let names: Vec<_> = sftp.read_dir("/").await.unwrap().map(|e| e.file_name()).collect(); assert_eq!(names, vec!["中文.txt"]);
    let source = dir.path().join("upload.txt"); let payload = "文件传输测试\n".repeat(12000); std::fs::write(&source, &payload).unwrap();
    crate::upload_to(&sftp, source.to_str().unwrap(), "/").await.unwrap();
    assert!(crate::upload_to(&sftp, source.to_str().unwrap(), "/").await.is_err(), "existing remote file must not be overwritten");
    let destination = dir.path().join("download.txt"); std::fs::write(&destination, "old contents").unwrap();
    crate::download_from(&sftp, destination.to_str().unwrap(), "/upload.txt").await.unwrap();
    assert_eq!(std::fs::read_to_string(destination).unwrap(), payload);
    let cancel = CancellationToken::new();
    let cancelled_source = dir.path().join("cancelled.txt"); std::fs::write(&cancelled_source, &payload).unwrap();
    let result = crate::transfer::upload(&sftp, cancelled_source.to_str().unwrap(), "/", &cancel, |progress| { if progress.transferred >= 65536 { cancel.cancel(); } Ok(()) }).await;
    assert_eq!(result.unwrap_err(), "传输已取消");
    assert!(sftp.metadata("/cancelled.txt").await.is_err(), "cancelled upload must be cleaned up");
    let mut progress_bytes = Vec::new();
    crate::transfer::upload(&sftp, cancelled_source.to_str().unwrap(), "/", &CancellationToken::new(), |progress| { progress_bytes.push(progress.transferred); assert_eq!(progress.total, Some(payload.len() as u64)); Ok(()) }).await.unwrap();
    assert_eq!(progress_bytes.first(), Some(&0)); assert_eq!(progress_bytes.last(), Some(&(payload.len() as u64)));
    assert!(progress_bytes.windows(2).all(|pair| pair[0] <= pair[1]));
    let cancel = CancellationToken::new();
    let cancelled_dest = dir.path().join("keep.txt"); std::fs::write(&cancelled_dest, "keep original").unwrap();
    let before_files = std::fs::read_dir(dir.path()).unwrap().count();
    let result = crate::transfer::download(&sftp, cancelled_dest.to_str().unwrap(), "/cancelled.txt", &cancel, |progress| { if progress.transferred >= 65536 { cancel.cancel(); } Ok(()) }).await;
    assert_eq!(result.unwrap_err(), "传输已取消");
    assert_eq!(std::fs::read_to_string(&cancelled_dest).unwrap(), "keep original");
    assert_eq!(before_files, std::fs::read_dir(dir.path()).unwrap().count(), "cancelled download must remove its temporary file");
    let batch_dir = tempfile::tempdir().unwrap(); let target_dir = batch_dir.path().to_str().unwrap();
    crate::transfer::download_batch(&sftp, target_dir, "/upload.txt", &CancellationToken::new(), |_| Ok(())).await.unwrap();
    assert_eq!(std::fs::read_to_string(batch_dir.path().join("upload.txt")).unwrap(), payload);
    let error = crate::transfer::download_batch(&sftp, target_dir, "/upload.txt", &CancellationToken::new(), |_| Ok(())).await.unwrap_err();
    assert!(error.contains("同名"));
    assert_eq!(std::fs::read_to_string(batch_dir.path().join("upload.txt")).unwrap(), payload);
    let cancel = CancellationToken::new();
    let error = crate::transfer::download_batch(&sftp, target_dir, "/cancelled.txt", &cancel, |progress| { if progress.transferred >= 65536 { cancel.cancel(); } Ok(()) }).await.unwrap_err();
    assert_eq!(error, "传输已取消");
    assert_eq!(std::fs::read_dir(batch_dir.path()).unwrap().count(), 1, "cancelled batch download leaves no temporary or target file");
    // A local file appearing during download must survive the atomic final commit.
    let race_target = batch_dir.path().join("cancelled.txt");
    let error = crate::transfer::download_batch(&sftp, target_dir, "/cancelled.txt", &CancellationToken::new(), |progress| {
        if progress.transferred >= payload.len() as u64 { std::fs::write(&race_target, "created during transfer").unwrap(); } Ok(())
    }).await.unwrap_err();
    assert!(error.contains("同名")); assert_eq!(std::fs::read_to_string(&race_target).unwrap(), "created during transfer");
    assert_eq!(std::fs::read_dir(batch_dir.path()).unwrap().count(), 2, "failed atomic commit removes temporary file");
    let broken = dir.path().join("broken.txt"); std::fs::write(&broken, &payload).unwrap();
    assert!(crate::upload_to(&sftp, broken.to_str().unwrap(), "/").await.is_err());
    assert!(sftp.metadata("/broken.txt").await.is_err(), "failed upload must be cleaned up");
    let uncleanable = dir.path().join("uncleanable.txt"); std::fs::write(&uncleanable, &payload).unwrap();
    let cancel = CancellationToken::new();
    let error = crate::transfer::upload(&sftp, uncleanable.to_str().unwrap(), "/", &cancel, |progress| { if progress.transferred >= 65536 { cancel.cancel(); } Ok(()) }).await.unwrap_err();
    assert!(error.contains("传输已取消") && error.contains("未能清理远程文件 /uncleanable.txt"), "cleanup failure must report the remote path");
    task.abort(); server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_fingerprint_can_be_rejected_before_authentication() {
    let (port, server) = server_socket().await;
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path()); state.trusted.lock().insert(format!("[127.0.0.1]:{port}"), "old-fingerprint".into());
    let (control, input) = control(); let (events, mut rx) = events();
    let task = tokio::spawn(run_ssh("two".into(), session(port), Credentials { password: "test-password".into(), passphrase: "".into(), remember: false, jump: None }, state.clone(), control, input, events, 80, 24));
    let event = next_event(&mut rx, "fingerprint").await; assert_eq!(event["previous"], "old-fingerprint");
    state.pending.lock().remove(event["requestId"].as_str().unwrap()).unwrap().sender.send(false).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().is_err());
    assert_eq!(state.trusted.lock().values().next().unwrap(), "old-fingerprint"); server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_private_key_authentication() {
    let (port, server) = server_socket().await;
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path()); let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let key_path = dir.path().join("id_ed25519"); key.write_openssh_file(&key_path, russh::keys::ssh_key::LineEnding::LF).unwrap();
    let mut config = session(port); config.auth = "key".into(); config.key_path = key_path.to_string_lossy().into();
    let (control, input) = control(); let (events, mut rx) = events();
    let task = tokio::spawn(run_ssh("key".into(), config, Credentials { password: "".into(), passphrase: "".into(), remember: false, jump: None }, state.clone(), control, input, events, 80, 24));
    accept_fingerprint(&state, &mut rx).await; next_event(&mut rx, "connected").await; task.abort(); server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn encrypted_private_keys_authenticate_on_target_and_jump() {
    let (port, server) = server_socket().await; let (jump_port, jump_server) = server_socket().await;
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path());
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap().encrypt(&mut rand::rng(), "generated-test-passphrase").unwrap();
    let path = dir.path().join("加密 private key"); key.write_openssh_file(&path, russh::keys::ssh_key::LineEnding::LF).unwrap();
    let mut config = session(port); config.auth = "key".into(); config.key_path = format!(" \"{}\" ", path.display());
    config.jump = Some(crate::config::JumpHost { host: "127.0.0.1".into(), port: jump_port, username: "test".into(), auth: "key".into(), key_path: path.to_string_lossy().into() });
    let (control, input) = control(); let (events, mut rx) = events();
    let secret = || Credentials { password: "".into(), passphrase: "generated-test-passphrase".into(), remember: false, jump: None };
    let mut credentials = secret(); credentials.jump = Some(Box::new(secret()));
    let task = tokio::spawn(run_ssh("encrypted-key".into(), config, credentials, state.clone(), control.clone(), input, events, 80, 24));
    accept_fingerprint(&state, &mut rx).await; accept_fingerprint(&state, &mut rx).await;
    next_event(&mut rx, "connected").await; assert!(control.sftp.lock().is_some());
    task.abort(); server.abort(); jump_server.abort();
}

#[tokio::test]
async fn invalid_private_key_fails_before_any_network_connection_and_otp_ignores_old_key_path() {
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path());
    for jump in [false, true] {
        let mut config = session(1); config.auth = "key".into(); config.key_path = dir.path().join("missing-private-key").to_string_lossy().into();
        if jump { config.jump = Some(crate::config::JumpHost { host: "127.0.0.1".into(), port: 1, username: "test".into(), auth: "key".into(), key_path: config.key_path.clone() }); }
        let (control, input) = control(); let (events, mut rx) = events();
        let error = run_ssh("bad-key".into(), config, Credentials { password: "".into(), passphrase: "".into(), remember: false, jump: None }, state.clone(), control, input, events, 80, 24).await.unwrap_err();
        assert!(error.contains("不存在") && error.contains(if jump { "跳板机" } else { "目标服务器" }));
        while let Some(event) = rx.recv().await { assert!(!event.to_string().contains("TCP")); }
        assert!(state.pending.lock().is_empty());
    }
    let (control, _) = control(); let (events, _) = events();
    let mut passphrase = "unused-secret".to_string();
    assert!(prepare_key("keyboard-interactive", "missing", Some(&mut passphrase), "目标服务器", &events).await.unwrap().is_none());
    assert!(!control.cancel.is_cancelled());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_pty_runs_shell_and_closes_on_cancel() {
    let (control, input) = control(); let (events, mut rx) = events();
    let task = tokio::spawn(run_local(control.clone(), input, events, 80, 24));
    next_event(&mut rx, "connected").await;
    let command = if cfg!(windows) { "Write-Output ('PTY_OK_' + [char]0x4e2d + [char]0x6587)\r" } else { "printf '%s%s\\n' 'PTY_OK_' '中文'\r" };
    control.input.send(Input::Data(command.into())).await.unwrap();
    let mut text = Vec::new(); while !String::from_utf8_lossy(&text).contains("PTY_OK_中文") { let event = next_event(&mut rx, "data").await; let bytes=STANDARD.decode(event["data"].as_str().unwrap()).unwrap(); if bytes.windows(4).any(|s|s==b"\x1b[6n"){control.input.send(Input::Data("\x1b[1;1R".into())).await.unwrap();} text.extend(bytes); }
    control.cancel.cancel(); drop(control);
    assert!(tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().is_ok());
}

fn password() -> Credentials { Credentials { password: "test-password".into(), passphrase: String::new(), remember: false, jump: None } }
fn jump_session(target: u16, jump: u16) -> Session {
    let mut s = session(target);
    s.jump = Some(crate::config::JumpHost { host: "127.0.0.1".into(), port: jump, username: "test".into(), auth: "password".into(), key_path: String::new() });
    s
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jump_connection_verifies_both_hosts_and_carries_terminal_and_sftp() {
    let (target_port, target) = server_socket().await; let (jump_port, jump) = server_socket().await;
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path()); let (control, input) = control(); let (events, mut rx) = events();
    let mut credentials = password(); credentials.jump = Some(Box::new(password()));
    let task = tokio::spawn(run_ssh("jump".into(), jump_session(target_port, jump_port), credentials, state.clone(), control.clone(), input, events, 80, 24));
    assert_eq!(accept_fingerprint(&state, &mut rx).await["host"], format!("[127.0.0.1]:{jump_port}"));
    assert_eq!(accept_fingerprint(&state, &mut rx).await["host"], format!("[127.0.0.1]:{target_port}"));
    next_event(&mut rx, "connected").await;
    control.input.send(Input::Data("via-jump-中文".into())).await.unwrap();
    let mut output = Vec::new();
    while !String::from_utf8_lossy(&output).contains("via-jump-中文") { output.extend(STANDARD.decode(next_event(&mut rx, "data").await["data"].as_str().unwrap()).unwrap()); }
    let sf = control.sftp.lock().clone().unwrap();
    assert_eq!(sf.read_dir("/").await.unwrap().next().unwrap().file_name(), "中文.txt");
    assert_eq!(state.trusted.lock().len(), 2);
    drop(control); task.abort(); target.abort(); jump.abort();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jump_failures_and_target_fingerprint_rejection_stop_connection() {
    let (target_port, target) = server_socket().await; let (jump_port, jump) = server_socket().await;
    for case in ["jump-auth", "target-fingerprint", "forward", "cancel"] {
        let dir = tempfile::tempdir().unwrap(); let state = state(dir.path()); let (control, input) = control(); let (events, mut rx) = events();
        let mut credentials = password(); let mut jump_secret = password();
        if case == "jump-auth" { jump_secret.password = "wrong".into(); }
        credentials.jump = Some(Box::new(jump_secret));
        let mut config = jump_session(target_port, jump_port);
        if case == "forward" { config.host = "forbidden.invalid".into(); }
        let task = tokio::spawn(run_ssh(case.into(), config, credentials, state.clone(), control.clone(), input, events, 80, 24));
        if case == "cancel" {
            next_event(&mut rx, "fingerprint").await; control.cancel.cancel();
        } else {
            accept_fingerprint(&state, &mut rx).await;
            if case == "target-fingerprint" {
                let event = next_event(&mut rx, "fingerprint").await;
                state.pending.lock().remove(event["requestId"].as_str().unwrap()).unwrap().sender.send(false).unwrap();
            }
        }
        let error = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
        assert!(error.contains(if case == "jump-auth" || case == "cancel" { "跳板机" } else if case == "forward" { "转发" } else { "目标服务器" }), "{case}: {error}");
        assert!(control.sftp.lock().is_none()); assert!(state.pending.lock().is_empty());
    }
    target.abort(); jump.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_signs_real_ssh_authentication_over_isolated_os_transport() {
    use russh::keys::agent::client::AgentClient;
    // No system agent, service configuration or user's keys are touched.
    #[cfg(windows)]
    let (mut agent, agent_task) = {
        let path = format!(r"\\.\pipe\tw-agent-test-{}", uuid::Uuid::new_v4());
        let pipe = tokio::net::windows::named_pipe::ServerOptions::new().first_pipe_instance(true).create(&path).unwrap();
        let agent = AgentClient::connect_named_pipe(&path).await.unwrap();
        pipe.connect().await.unwrap();
        let task = tokio::spawn(russh::keys::agent::server::serve(Box::pin(futures::stream::once(async move { Ok(pipe) })), ()));
        (agent, task)
    };
    #[cfg(unix)]
    let (mut agent, agent_task) = {
        let (a, b) = tokio::net::UnixStream::pair().unwrap();
        let task = tokio::spawn(russh::keys::agent::server::serve(Box::pin(futures::stream::once(async move { Ok(b) })), ()));
        (AgentClient::connect(a), task)
    };
    let (port, server) = server_socket().await; let dir = tempfile::tempdir().unwrap(); let state = state(dir.path()); let (control, _) = control(); let (events, mut rx) = events();
    let handshake_state = state.clone(); let handshake_control = control.clone();
    let handshake_events = events.clone();
    let task = tokio::spawn(async move { let socket = tcp("127.0.0.1", port, &handshake_events).await.unwrap(); handshake(socket, "127.0.0.1", port, "agent", &handshake_state, &handshake_control, &handshake_events).await.unwrap() });
    accept_fingerprint(&state, &mut rx).await; let mut ssh = task.await.unwrap();
    assert!(agent_auth(&mut ssh, "test", &mut agent).await.unwrap_err().contains("没有密钥"));
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    agent.add_identity(&key, &[]).await.unwrap();
    assert!(agent_auth(&mut ssh, "wrong-user", &mut agent).await.unwrap_err().contains("拒绝"));
    agent_auth(&mut ssh, "test", &mut agent).await.unwrap();
    let mut channel = ssh.channel_open_session().await.unwrap(); channel.request_shell(true).await.unwrap();
    wait_success(&mut channel, &events).await.unwrap();
    drop(ssh); agent_task.abort(); server.abort();
}
