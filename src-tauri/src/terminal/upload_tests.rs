use tokio::io::AsyncWriteExt;
fn upload_store() -> crate::upload_resume::Store { Arc::new(Mutex::new(HashMap::new())) }
fn upload_probe(fixture: &mut TestSftp) -> Arc<Mutex<HashMap<String, Vec<u8>>>> {
    let probe = Arc::new(Mutex::new(fixture.files.clone())); fixture.probe = Some(probe.clone()); probe
}
#[tokio::test]
async fn upload_pause_resume_checks_content_and_publishes_only_when_complete() {
    let payload = download_payload(); let dir = tempfile::tempdir().unwrap(); let local = dir.path().join("data.bin"); std::fs::write(&local,&payload).unwrap();
    let mut fixture = TestSftp::default(); let probe = upload_probe(&mut fixture);
    let (sf, server) = download_fixture(fixture).await; let store = upload_store(); let control = crate::download_resume::DownloadControl::default(); let mut saved = 0;
    let error = crate::upload_resume::run(&store,"up","tab","owner",&sf,local.clone(),"/",&control,|p| {if p.transferred>=65536 { saved=p.transferred; control.pause.cancel(); } Ok(())}).await.unwrap_err();
    assert_eq!(error,"传输已暂停"); assert!(saved>0 && saved<payload.len() as u64); assert!(!probe.lock().contains_key("/data.bin"));
    let path = store.lock().get("up").unwrap().temp.clone(); assert_eq!(probe.lock()[&path],payload[..saved as usize]);
    assert!(sf.metadata("/edit.txt").await.is_ok()); let mut offsets=Vec::new();
    crate::upload_resume::run(&store,"up","tab","owner",&sf,local,"/",&Default::default(),|p| {offsets.push(p.transferred);Ok(())}).await.unwrap();
    assert_eq!(offsets[0],saved); assert!(offsets.windows(2).all(|p|p[0]<=p[1])); assert_eq!(probe.lock()["/data.bin"],payload); assert!(!probe.lock().contains_key(&path)); assert!(store.lock().is_empty()); server.abort();
}
#[tokio::test]
async fn upload_reconnect_binds_identity_and_paths_and_keeps_changed_local_source() {
    let payload=download_payload(); let dir=tempfile::tempdir().unwrap();let local=dir.path().join("data.bin");std::fs::write(&local,&payload).unwrap();
    let mut fixture=TestSftp::default();let probe=upload_probe(&mut fixture);let (sf,server)=download_fixture(fixture).await;let store=upload_store();let control=crate::download_resume::DownloadControl::default();
    assert!(crate::upload_resume::run(&store,"up","tab","owner",&sf,local.clone(),"/",&control,|p| {if p.transferred>=65536 {control.cancel.cancel();}Ok(())}).await.unwrap_err().starts_with("可恢复："));
    server.abort();drop(sf);let mut fixture=TestSftp::default();fixture.files=probe.lock().clone();let probe=upload_probe(&mut fixture);let (sf,server)=download_fixture(fixture).await;
    for (owner,path,remote) in [("other",local.clone(),"/"),("owner",dir.path().join("other.bin"),"/"),("owner",local.clone(),"/other")] {
        assert!(crate::upload_resume::run(&store,"up","tab",owner,&sf,path,remote,&Default::default(),|_|Ok(())).await.unwrap_err().contains("身份或文件路径"));
    }
    let mut changed=payload.clone();changed[0]^=1;std::fs::write(&local,&changed).unwrap();
    assert!(crate::upload_resume::run(&store,"up","tab","owner",&sf,local.clone(),"/",&Default::default(),|_|Ok(())).await.unwrap_err().contains("本地源文件内容已改变"));
    assert!(!probe.lock().contains_key("/data.bin"));std::fs::write(&local,&payload).unwrap();
    crate::upload_resume::run(&store,"up","tab","owner",&sf,local,"/",&Default::default(),|_|Ok(())).await.unwrap();assert_eq!(probe.lock()["/data.bin"],payload);server.abort();
}
#[tokio::test]
async fn upload_cancel_cleans_active_and_paused_files_without_needing_local_source() {
    for active in [true,false] {
        let dir=tempfile::tempdir().unwrap();let local=dir.path().join("data.bin");std::fs::write(&local,download_payload()).unwrap();let mut fixture=TestSftp::default();let probe=upload_probe(&mut fixture);
        let (sf,server)=download_fixture(fixture).await;let store=upload_store();let control=crate::download_resume::DownloadControl::default();
        let error=crate::upload_resume::run(&store,"up","tab","owner",&sf,local.clone(),"/",&control,|p|{if p.transferred>=65536 {if active {control.discard.store(true,std::sync::atomic::Ordering::SeqCst);control.cancel.cancel();}else{control.pause.cancel();}}Ok(())}).await.unwrap_err();
        if active {assert_eq!(error,"传输已取消");} else {
            assert_eq!(error,"传输已暂停");std::fs::remove_file(&local).unwrap();
            assert!(crate::upload_resume::cancel(&store,"up","other",&sf).await.unwrap_err().contains("身份已改变"));assert_eq!(store.lock().len(),1);
            crate::upload_resume::cancel(&store,"up","owner",&sf).await.unwrap();
        }
        assert!(store.lock().is_empty());assert!(!probe.lock().keys().any(|p|p.ends_with(".part")));assert!(!probe.lock().contains_key("/data.bin"));server.abort();
    }
}
#[tokio::test]
async fn upload_does_not_resume_or_delete_tampered_remote_partial() {
    let dir=tempfile::tempdir().unwrap();let local=dir.path().join("data.bin");std::fs::write(&local,download_payload()).unwrap();let mut fixture=TestSftp::default();let probe=upload_probe(&mut fixture);
    let (sf,server)=download_fixture(fixture).await;let store=upload_store();let control=crate::download_resume::DownloadControl::default();
    crate::upload_resume::run(&store,"up","tab","owner",&sf,local.clone(),"/",&control,|p|{if p.transferred>=65536 {control.pause.cancel();}Ok(())}).await.unwrap_err();
    let path=store.lock().get("up").unwrap().temp.clone();let mut bytes=probe.lock()[&path].clone();bytes[0]^=1;sf.write(&path,&bytes).await.unwrap();
    assert!(crate::upload_resume::run(&store,"up","tab","owner",&sf,local,"/",&Default::default(),|_|Ok(())).await.unwrap_err().contains("已上传内容已改变"));
    let error=crate::upload_resume::cancel(&store,"up","owner",&sf).await.unwrap_err();assert!(error.contains(&path));assert!(error.contains("未删除"));assert_eq!(probe.lock()[&path],bytes);assert_eq!(store.lock().len(),1);server.abort();
}
#[tokio::test]
async fn upload_no_overwrite_empty_files_and_publish_failure_recovery() {
    let dir=tempfile::tempdir().unwrap();let local=dir.path().join("data.bin");std::fs::write(&local,download_payload()).unwrap();
    let mut fixture=TestSftp::default();fixture.files.insert("/data.bin".into(),b"existing".to_vec());let probe=upload_probe(&mut fixture);let (sf,server)=download_fixture(fixture).await;let store=upload_store();
    assert!(crate::upload_resume::run(&store,"up","tab","owner",&sf,local.clone(),"/",&Default::default(),|_|Ok(())).await.unwrap_err().contains("同名文件"));
    crate::upload_resume::cancel(&store,"up","owner",&sf).await.unwrap();assert_eq!(probe.lock()["/data.bin"],b"existing");assert!(!probe.lock().keys().any(|p|p.ends_with(".part")));server.abort();
    let (sf,server)=download_fixture(TestSftp::default()).await;let empty=dir.path().join("empty");std::fs::write(&empty,[]).unwrap();
    crate::upload_resume::run(&store,"empty","tab","owner",&sf,empty,"/",&Default::default(),|_|Ok(())).await.unwrap();assert_eq!(sf.metadata("/empty").await.unwrap().size,Some(0));
    let fail=dir.path().join("rename-fail.txt");std::fs::write(&fail,b"publish failure").unwrap();assert!(crate::upload_resume::run(&store,"fail","tab","owner",&sf,fail,"/",&Default::default(),|_|Ok(())).await.unwrap_err().contains("发布失败"));
    crate::upload_resume::cancel(&store,"fail","owner",&sf).await.unwrap();assert!(store.lock().is_empty());server.abort();
}
#[tokio::test]
async fn upload_detects_local_replacement_during_copy_and_late_target_collision() {
    for collision in [false,true] {
        let dir=tempfile::tempdir().unwrap();let local=dir.path().join("data.bin");let payload=download_payload();std::fs::write(&local,&payload).unwrap();let mut fixture=TestSftp::default();let probe=upload_probe(&mut fixture);let (sf,server)=download_fixture(fixture).await;let store=upload_store();
        if collision {
            // A second SFTP session represents another process writing the target.
            let mut paused=false;let control=crate::download_resume::DownloadControl::default();
            crate::upload_resume::run(&store,"up","tab","owner",&sf,local.clone(),"/",&control,|p|{if p.transferred>=65536&&!paused {paused=true;control.pause.cancel();}Ok(())}).await.unwrap_err();
            let mut other=sf.open_with_flags("/data.bin",OpenFlags::CREATE|OpenFlags::WRITE).await.unwrap();other.write_all(b"concurrent").await.unwrap();other.shutdown().await.unwrap();
            assert!(crate::upload_resume::run(&store,"up","tab","owner",&sf,local,"/",&Default::default(),|_|Ok(())).await.unwrap_err().contains("同名文件"));assert_eq!(probe.lock()["/data.bin"],b"concurrent");
        } else {
            let mut changed=false;
            assert!(crate::upload_resume::run(&store,"up","tab","owner",&sf,local.clone(),"/",&Default::default(),|p|{if p.stage==Some("verifying")&&p.transferred==payload.len() as u64&&!changed {changed=true;std::fs::write(&local,vec![0;payload.len()]).unwrap();}Ok(())}).await.unwrap_err().contains("本地源文件在上传期间改变"));assert!(!probe.lock().contains_key("/data.bin"));
        }
        crate::upload_resume::cancel(&store,"up","owner",&sf).await.unwrap();assert!(!probe.lock().keys().any(|p|p.ends_with(".part")));server.abort();
    }
}
#[tokio::test]
async fn upload_publish_refuses_a_target_created_after_the_final_check() {
    let dir=tempfile::tempdir().unwrap();let local=dir.path().join("data.bin");std::fs::write(&local,download_payload()).unwrap();
    let mut fixture=TestSftp::default();fixture.rename_collision=true;let probe=upload_probe(&mut fixture);let (sf,server)=download_fixture(fixture).await;let store=upload_store();
    assert!(crate::upload_resume::run(&store,"up","tab","owner",&sf,local,"/",&Default::default(),|_|Ok(())).await.unwrap_err().contains("发布失败"));
    assert_eq!(probe.lock()["/data.bin"],b"late competitor");crate::upload_resume::cancel(&store,"up","owner",&sf).await.unwrap();assert!(!probe.lock().keys().any(|p|p.ends_with(".part")));server.abort();
}
#[tokio::test]
async fn upload_failed_cleanup_keeps_path_and_can_be_retried_on_a_new_connection() {
    let dir=tempfile::tempdir().unwrap();let local=dir.path().join("data.bin");std::fs::write(&local,download_payload()).unwrap();
    let mut fixture=TestSftp::default();fixture.deny_part_remove=true;let probe=upload_probe(&mut fixture);let (sf,server)=download_fixture(fixture).await;let store=upload_store();let control=crate::download_resume::DownloadControl::default();
    let error=crate::upload_resume::run(&store,"up","tab","owner",&sf,local,"/",&control,|p|{if p.transferred>=65536 {control.discard.store(true,std::sync::atomic::Ordering::SeqCst);control.cancel.cancel();}Ok(())}).await.unwrap_err();
    let path=store.lock().get("up").unwrap().temp.clone();assert!(error.contains(&path));assert!(error.starts_with("可恢复："));assert!(probe.lock().contains_key(&path));
    assert!(crate::upload_resume::cancel(&store,"up","owner",&sf).await.unwrap_err().contains(&path));assert_eq!(store.lock().len(),1);
    server.abort();drop(sf);let mut fixture=TestSftp::default();fixture.files=probe.lock().clone();let probe=upload_probe(&mut fixture);let (sf,server)=download_fixture(fixture).await;
    crate::upload_resume::cancel(&store,"up","owner",&sf).await.unwrap();assert!(store.lock().is_empty());assert!(!probe.lock().contains_key(&path));server.abort();
}
#[tokio::test]
async fn upload_verifies_unacknowledged_tail_before_adopting_it_after_a_write_failure() {
    let dir=tempfile::tempdir().unwrap();let local=dir.path().join("data.bin");let payload=download_payload();std::fs::write(&local,&payload).unwrap();
    let mut fixture=TestSftp::default();fixture.write_ack_lost=true;let probe=upload_probe(&mut fixture);let (sf,server)=download_fixture(fixture).await;let store=upload_store();
    assert!(crate::upload_resume::run(&store,"up","tab","owner",&sf,local.clone(),"/",&Default::default(),|_|Ok(())).await.unwrap_err().starts_with("可恢复："));
    let path=store.lock().get("up").unwrap().temp.clone();assert!(!probe.lock()[&path].is_empty());
    crate::upload_resume::run(&store,"up","tab","owner",&sf,local,"/",&Default::default(),|_|Ok(())).await.unwrap();assert_eq!(probe.lock()["/data.bin"],payload);assert!(store.lock().is_empty());server.abort();
}
