// Runs the production editor over SFTP packets, with isolated fixture files.
async fn editor_fixture(fixture: TestSftp) -> (crate::remote_editor::RemoteEditor, tokio::task::JoinHandle<()>) {
    let (client, server) = tokio::io::duplex(65536);
    let task = tokio::spawn(async move { russh_sftp::server::run(server, fixture).await; });
    (crate::remote_editor::RemoteEditor::new(client).await.unwrap(), task)
}

#[tokio::test]
async fn editor_sftp_preserves_bom_crlf_permissions_and_creates_exact_backup() {
    let (editor, server) = editor_fixture(TestSftp::default()).await;
    let cancel = CancellationToken::new();
    let original = editor.read("/edit.txt", &cancel).await.unwrap();
    let result = editor.save("/edit.txt", "\u{feff}修改\r\n".into(), &original.revision, &cancel).await.unwrap();
    assert_eq!(result.document.content, "\u{feff}修改\r\n");
    assert_eq!(editor.read(&result.backup_path, &cancel).await.unwrap().content, original.content);
    let current = editor.read("/edit.txt", &cancel).await.unwrap();
    assert_eq!(current.revision, result.document.revision);
    assert!(editor.save("/edit.txt", "stale edit".into(), &original.revision, &cancel).await.unwrap_err().contains("已被修改"));
    assert_eq!(editor.read("/edit.txt", &cancel).await.unwrap().content, result.document.content);
    editor.save("/edit.txt", "".into(), &result.document.revision, &cancel).await.unwrap();
    assert_eq!(editor.read("/edit.txt", &cancel).await.unwrap().content, "");
    server.abort();
}

#[tokio::test]
async fn editor_rejects_binary_encoding_size_links_and_special_files() {
    let mut fixture = TestSftp::default();
    for (path, content) in [("/nul.bin", vec![0,1]), ("/legacy.txt", vec![0xff]), ("/large.txt", vec![b'a'; 1024*1024+1]), ("/link.txt", b"link".to_vec()), ("/folder", b"dir".to_vec())] { fixture.files.insert(path.into(), content); }
    let (editor, server) = editor_fixture(fixture).await;
    let cancel = CancellationToken::new();
    for path in ["/nul.bin", "/legacy.txt", "/large.txt", "/link.txt", "/folder", "/missing.txt", "/", ""] { assert!(editor.read(path, &cancel).await.is_err(), "must reject {path}"); }
    let original = editor.read("/edit.txt", &cancel).await.unwrap();
    for content in ["x".repeat(1024*1024+1), "\0".into()] { assert!(editor.save("/edit.txt", content, &original.revision, &cancel).await.is_err()); }
    assert_eq!(editor.read("/edit.txt", &cancel).await.unwrap().content, original.content);
    server.abort();
}

#[tokio::test]
async fn editor_write_permission_rename_and_unsupported_failures_preserve_original() {
    for failure in 0..6 {
        let path = if failure == 2 { "/rename-fail.txt" } else if failure == 3 { "/readonly.txt" } else { "/edit.txt" };
        let mut fixture = TestSftp::default(); fixture.files.insert(path.into(), b"original".to_vec());
        fixture.fail_write = failure == 0; fixture.fail_permissions = failure == 1; fixture.no_atomic = failure == 4;
        fixture.fail_backup = failure == 5;
        let probe = Arc::new(Mutex::new(fixture.files.clone())); fixture.probe = Some(probe.clone());
        let (editor, server) = editor_fixture(fixture).await;
        let cancel = CancellationToken::new(); let original = editor.read(path, &cancel).await.unwrap();
        let error = editor.save(path, "modified".into(), &original.revision, &cancel).await.unwrap_err();
        assert_eq!(editor.read(path, &cancel).await.unwrap().content, "original", "{error}");
        assert!(!probe.lock().keys().any(|p| p.ends_with(".tmp")), "temporary file must be cleaned: {error}");
        if failure == 5 { assert!(!probe.lock().keys().any(|p| p.ends_with(".bak")), "partial backup must be cleaned"); }
        if failure == 2 { assert!(error.contains("原内容备份")); }
        if failure == 4 { assert!(error.contains("不支持安全替换")); }
        server.abort();
    }
}

#[tokio::test]
async fn editor_cancelled_mid_write_cleans_temp_and_never_changes_original() {
    let cancel = CancellationToken::new();
    let mut fixture = TestSftp::default(); fixture.cancel_write = Some(cancel.clone());
    let probe = Arc::new(Mutex::new(fixture.files.clone())); fixture.probe = Some(probe.clone());
    let (editor, server) = editor_fixture(fixture).await;
    let original = editor.read("/edit.txt", &cancel).await.unwrap();
    let error = editor.save("/edit.txt", "long text".repeat(20000), &original.revision, &cancel).await.unwrap_err();
    assert!(error.contains("取消"));
    assert_eq!(editor.read("/edit.txt", &CancellationToken::new()).await.unwrap().content, original.content);
    assert!(!probe.lock().keys().any(|p| p.ends_with(".tmp") || p.ends_with(".bak")));
    server.abort();
}

#[tokio::test]
async fn editor_checks_again_before_commit_and_honors_cancellation() {
    let mut fixture = TestSftp::default(); fixture.files.insert("/race.txt".into(), b"original".to_vec());
    let (editor, server) = editor_fixture(fixture).await;
    let cancel = CancellationToken::new(); let original = editor.read("/race.txt", &cancel).await.unwrap();
    let error = editor.save("/race.txt", "my draft".into(), &original.revision, &cancel).await.unwrap_err();
    assert!(error.contains("在保存期间发生变化"));
    assert_eq!(editor.read("/race.txt", &cancel).await.unwrap().content, "external change");
    cancel.cancel();
    assert!(editor.read("/edit.txt", &cancel).await.is_err());
    assert!(editor.save("/edit.txt", "never saved".into(), &original.revision, &cancel).await.is_err());
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn editor_opens_lazily_over_authenticated_jump_connection() {
    let (jump_port, jump_server) = server_socket().await; let (port, server) = server_socket().await;
    let dir = tempfile::tempdir().unwrap(); let state = state(dir.path()); let (control, input) = control(); let (events, mut rx) = events();
    let mut config = session(port); config.jump = Some(crate::config::JumpHost { host: "127.0.0.1".into(), port: jump_port, username: "test".into(), auth: "password".into(), key_path: "".into() });
    let secret = Credentials { password: "test-password".into(), passphrase: "".into(), remember: false, jump: Some(Box::new(Credentials { password: "test-password".into(), passphrase: "".into(), remember: false, jump: None })) };
    let task = tokio::spawn(run_ssh("editor".into(), config, secret, state.clone(), control.clone(), input, events, 80, 24));
    accept_fingerprint(&state, &mut rx).await; accept_fingerprint(&state, &mut rx).await; next_event(&mut rx, "connected").await;
    let (reply, receiver) = oneshot::channel(); control.input.send(Input::OpenEditor(reply)).await.unwrap();
    let editor = tokio::time::timeout(Duration::from_secs(15), receiver).await.unwrap().unwrap().unwrap();
    let original = editor.read("/edit.txt", &control.cancel).await.unwrap();
    let saved = editor.save("/edit.txt", "jump edit".into(), &original.revision, &control.cancel).await.unwrap();
    assert_eq!(editor.read("/edit.txt", &control.cancel).await.unwrap().content, saved.document.content);
    control.input.send(Input::Data("terminal remains alive".into())).await.unwrap();
    let mut output = Vec::new(); while !String::from_utf8_lossy(&output).contains("terminal remains alive") { let event = next_event(&mut rx, "data").await; output.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap()); }
    task.abort(); server.abort(); jump_server.abort();
}
