async fn download_fixture(fixture: TestSftp) -> (SftpSession, tokio::task::JoinHandle<()>) {
    let (client, server) = tokio::io::duplex(65536);
    let task = tokio::spawn(async move { russh_sftp::server::run(server, fixture).await; });
    (SftpSession::new(client).await.unwrap(), task)
}
fn download_payload() -> Vec<u8> { (0..300000).map(|n| ((n * 13 + n / 997) % 251) as u8).collect() }
fn download_store() -> crate::download_resume::Store { Arc::new(Mutex::new(HashMap::new())) }

#[tokio::test]
async fn download_pause_releases_channel_and_resumes_exact_bytes() {
    let payload = download_payload(); let mut fixture = TestSftp::default(); fixture.files.insert("/data.bin".into(), payload.clone());
    let (sf, server) = download_fixture(fixture).await; let store = download_store(); let dir = tempfile::tempdir().unwrap(); let target = dir.path().join("result.bin");
    std::fs::write(&target, "original").unwrap();
    let control = crate::download_resume::DownloadControl::default(); let mut saved = 0;
    let error = crate::download_resume::run(&store, "one", "owner", &sf, target.clone(), "/data.bin", true, &control, |progress| {
        if progress.transferred >= 65536 { saved = progress.transferred; control.pause.cancel(); } Ok(())
    }).await.unwrap_err();
    assert_eq!(error, "传输已暂停"); assert!(saved > 0 && saved < payload.len() as u64); assert_eq!(store.lock().len(), 1);
    assert_eq!(std::fs::read(&target).unwrap(), b"original");
    // The previous download future returned; the same SFTP channel remains usable.
    assert!(sf.metadata("/data.bin").await.is_ok());
    let mut offsets = Vec::new();
    crate::download_resume::run(&store, "one", "owner", &sf, target.clone(), "/data.bin", true, &Default::default(), |progress| { offsets.push(progress.transferred); Ok(()) }).await.unwrap();
    assert_eq!(offsets[0], saved); assert!(offsets.windows(2).all(|pair| pair[0] <= pair[1]));
    assert_eq!(std::fs::read(target).unwrap(), payload); assert!(store.lock().is_empty()); assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    server.abort();
}

#[tokio::test]
async fn interrupted_download_uses_a_new_sftp_connection_and_rejects_other_owner() {
    let payload = download_payload(); let fixture = || { let mut fixture = TestSftp::default(); fixture.files.insert("/data.bin".into(), payload.clone()); fixture };
    let (sf, server) = download_fixture(fixture()).await; let store = download_store(); let dir = tempfile::tempdir().unwrap(); let target = dir.path().join("result.bin");
    let control = crate::download_resume::DownloadControl::default();
    let error = crate::download_resume::run(&store, "one", "identity-A", &sf, target.clone(), "/data.bin", false, &control, |progress| { if progress.transferred >= 65536 { control.cancel.cancel(); } Ok(()) }).await.unwrap_err();
    assert!(error.starts_with("可恢复：")); assert!(!target.exists()); server.abort(); drop(sf);
    let (sf, server) = download_fixture(fixture()).await;
    for (owner, destination, path, overwrite) in [("identity-B",target.clone(),"/data.bin",false),("identity-A",dir.path().join("other"),"/data.bin",false),("identity-A",target.clone(),"/different",false),("identity-A",target.clone(),"/data.bin",true)] {
        assert!(crate::download_resume::run(&store,"one",owner,&sf,destination,path,overwrite,&Default::default(), |_| Ok(())).await.unwrap_err().contains("身份或文件路径"));
        assert_eq!(store.lock().len(),1);
    }
    crate::download_resume::run(&store,"one","identity-A",&sf,target.clone(),"/data.bin",false,&Default::default(), |_| Ok(())).await.unwrap();
    assert_eq!(std::fs::read(target).unwrap(), payload); assert!(store.lock().is_empty()); server.abort();
}

#[tokio::test]
async fn download_resume_rejects_same_size_remote_changes_and_local_temp_or_target_changes() {
    for mutation in 0..3 {
        let payload = download_payload(); let mut fixture = TestSftp::default(); fixture.files.insert("/data.bin".into(),payload.clone());
        let (sf, server) = download_fixture(fixture).await; let store = download_store(); let dir = tempfile::tempdir().unwrap(); let target = dir.path().join("result.bin");
        std::fs::write(&target,"original").unwrap(); let control = crate::download_resume::DownloadControl::default();
        crate::download_resume::run(&store,"one","owner",&sf,target.clone(),"/data.bin",true,&control,|progress| {if progress.transferred >= 65536 {control.pause.cancel();} Ok(())}).await.unwrap_err();
        let mut source = payload.clone();
        if mutation == 0 { source[200000] ^= 0x55; } // Same size and same mtime, outside the saved prefix.
        if mutation == 1 { let temp = std::fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().path()).find(|path| path != &target).unwrap(); std::fs::write(temp, vec![0; 65536]).unwrap(); }
        if mutation == 2 { std::fs::write(&target,"external edit").unwrap(); }
        server.abort(); drop(sf); let mut fixture = TestSftp::default(); fixture.files.insert("/data.bin".into(),source);
        let (sf, server) = download_fixture(fixture).await;
        let error = crate::download_resume::run(&store,"one","owner",&sf,target.clone(),"/data.bin",true,&Default::default(), |_| Ok(())).await.unwrap_err();
        assert!(error.contains(match mutation {0 => "远端文件内容已改变", 1 => "本地临时文件已改变", _ => "本地目标已改变"}), "{error}");
        assert_eq!(std::fs::read(target).unwrap(), if mutation == 2 { b"external edit".as_slice() } else { b"original".as_slice() });
        store.lock().clear(); assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(),1); server.abort();
    }
}

#[tokio::test]
async fn cancelled_download_discards_checkpoint_and_never_overwrites_new_target() {
    let payload = download_payload(); let mut fixture = TestSftp::default(); fixture.files.insert("/data.bin".into(),payload.clone());
    let (sf, server) = download_fixture(fixture).await; let store = download_store(); let dir = tempfile::tempdir().unwrap(); let target = dir.path().join("result.bin");
    let control = crate::download_resume::DownloadControl::default();
    let error = crate::download_resume::run(&store,"cancel","owner",&sf,target.clone(),"/data.bin",false,&control,|progress| {
        if progress.transferred >= 65536 {control.discard.store(true, std::sync::atomic::Ordering::SeqCst); control.cancel.cancel();} Ok(())
    }).await.unwrap_err();
    assert_eq!(error,"传输已取消"); assert!(store.lock().is_empty()); assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(),0);
    let error = crate::download_resume::run(&store,"race","owner",&sf,target.clone(),"/data.bin",false,&Default::default(),|progress| {
        if progress.transferred >= 65536 {std::fs::write(&target,"created during transfer").unwrap();} Ok(())
    }).await.unwrap_err();
    assert!(error.contains("本地目标已改变")); assert_eq!(std::fs::read(&target).unwrap(),b"created during transfer");
    store.lock().clear(); assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(),1); server.abort();
}

#[tokio::test]
async fn download_integrity_catches_changes_during_copy_and_handles_empty_files() {
    let payload = download_payload(); let mut fixture = TestSftp::default(); fixture.files.insert("/data.bin".into(),payload);
    fixture.files.insert("/empty".into(),Vec::new());
    let (sf, server) = download_fixture(fixture).await; let store = download_store(); let dir = tempfile::tempdir().unwrap(); let target = dir.path().join("result.bin");
    crate::download_resume::run(&store,"empty","owner",&sf,target.clone(),"/empty",false,&Default::default(), |_| Ok(())).await.unwrap();
    assert_eq!(std::fs::metadata(&target).unwrap().len(),0);
    // Mutate an unread suffix after the source hash was captured.
    let changed = Arc::new(AtomicBool::new(false));
    let sf = Arc::new(sf); let write_sf = sf.clone(); let flag = changed.clone(); let (tx, rx) = oneshot::channel();
    let writer = tokio::spawn(async move {rx.await.unwrap(); write_sf.write("/data.bin",&vec![0;300000]).await.unwrap(); flag.store(true,std::sync::atomic::Ordering::SeqCst);});
    let control = crate::download_resume::DownloadControl::default(); let mut trigger = Some(tx);
    let error = crate::download_resume::run(&store,"change","owner",&sf,target.clone(),"/data.bin",true,&control,|progress| {
        if progress.transferred >= 65536 {if let Some(tx) = trigger.take() {let _=tx.send(());} control.pause.cancel();} Ok(())
    }).await.unwrap_err();
    assert_eq!(error,"传输已暂停"); writer.await.unwrap(); assert!(changed.load(std::sync::atomic::Ordering::SeqCst));
    assert!(crate::download_resume::run(&store,"change","owner",&sf,target.clone(),"/data.bin",true,&Default::default(), |_| Ok(())).await.unwrap_err().contains("远端文件内容已改变"));
    assert_eq!(std::fs::metadata(&target).unwrap().len(),0); store.lock().clear(); server.abort();
}

#[tokio::test]
async fn changing_an_unread_suffix_during_copy_never_commits_a_mixed_file() {
    let mut fixture = TestSftp::default(); fixture.files.insert("/data.bin".into(),download_payload()); fixture.copy_change = true;
    let (sf,server) = download_fixture(fixture).await; let store = download_store(); let dir = tempfile::tempdir().unwrap(); let target = dir.path().join("result");
    let error = crate::download_resume::run(&store,"mix","owner",&sf,target.clone(),"/data.bin",false,&Default::default(), |_| Ok(())).await.unwrap_err();
    assert!(error.contains("传输内容校验失败"),"{error}"); assert!(!target.exists()); store.lock().clear(); assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(),0); server.abort();
}
