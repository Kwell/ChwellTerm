use std::{collections::HashMap, path::PathBuf, sync::{Arc, atomic::Ordering}, time::Duration};
use parking_lot::Mutex;
use russh_sftp::{client::{SftpSession, error::Error}, protocol::{OpenFlags, StatusCode}};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use crate::{download_resume::{DownloadControl, hash, io}, transfer::TransferProgress};

pub type Store = Arc<Mutex<HashMap<String, Checkpoint>>>;
pub struct Checkpoint {
    pub owner: String, pub tab_id: String, pub temp: String,
    local: PathBuf, target: String, source_hash: Option<[u8; 32]>, total: u64,
    pub created: bool, offset: u64, prefix: Sha256,
}
async fn exists(sf: &SftpSession, path: &str) -> Result<bool, String> {
    match sf.symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(Error::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}
async fn cleanup(cp: &Checkpoint, sf: &SftpSession) -> Result<(), String> {
    if !cp.created { return Ok(()); }
    let check = DownloadControl::default();
    if !io(&check, exists(sf, &cp.temp)).await? { return Ok(()); }
    let attrs = io(&check, sf.symlink_metadata(&cp.temp)).await?;
    if !attrs.file_type().is_file() || attrs.size != Some(cp.offset) { return Err("临时文件类型或长度已改变，未删除".into()); }
    let mut file = io(&check, sf.open(&cp.temp)).await?;
    if hash(&mut file, Some(cp.offset), &check).await? != <[u8; 32]>::from(cp.prefix.clone().finalize()) {
        return Err("临时文件内容已改变，未删除".into());
    }
    io(&check, file.shutdown()).await?;
    io(&check, sf.remove_file(&cp.temp)).await
}
// Failed cleanup keeps the capability so the user can retry after reconnecting.
pub async fn cancel(store: &Store, id: &str, owner: &str, sf: &SftpSession) -> Result<(), String> {
    let cp = {
        let mut entries = store.lock();
        if let Some(cp) = entries.get(id) {
            if cp.owner != owner { return Err(format!("连接身份已改变，未清理 {}；请在原标签连接原服务器后重试", cp.temp)); }
        }
        entries.remove(id)
    };
    if let Some(cp) = cp {
        if let Err(error) = cleanup(&cp, sf).await {
            let message = format!("未能清理 {}：{error}；断点仍保留，请重连后重试或手动检查", cp.temp);
            store.lock().insert(id.into(), cp); return Err(message);
        }
    }
    Ok(())
}

pub async fn run(
    store: &Store, id: &str, tab_id: &str, owner: &str, sf: &SftpSession,
    local: PathBuf, remote_dir: &str, control: &DownloadControl,
    mut report: impl FnMut(TransferProgress) -> Result<(), String>,
) -> Result<String, String> {
    let name = local.file_name().and_then(|v| v.to_str()).ok_or("无效本地文件名")?.to_string();
    if name.contains(['/', '\\']) || name.chars().any(char::is_control) { return Err("不支持此上传文件名".into()); }
    let target = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
    let mut cp = {
        let mut entries = store.lock();
        if let Some(cp) = entries.get(id) {
            if cp.owner != owner || cp.local != local || cp.target != target {
                return Err("可恢复：连接身份或文件路径已改变，请恢复原连接或取消此任务".into());
            }
        } else if entries.len() >= 200 { return Err("上传断点最多保留 200 项".into()); }
        entries.remove(id).unwrap_or_else(|| Checkpoint {
            owner: owner.into(), tab_id: tab_id.into(), local, target,
            temp: format!("{}/.twb-upload-{}.part", remote_dir.trim_end_matches('/'), uuid::Uuid::new_v4()),
            source_hash: None, total: 0, created: false, offset: 0, prefix: Sha256::new(),
        })
    };
    let result = async {
        report(TransferProgress { temporary_path: Some(cp.temp.clone()), name: name.clone(), transferred: cp.offset, total: cp.source_hash.map(|_| cp.total), stage: Some("verifying") })?;
        let mut source = io(control, tokio::fs::File::open(&cp.local)).await?;
        let attrs = io(control, source.metadata()).await?;
        if !attrs.is_file() { return Err("只能上传普通文件".into()); }
        let source_hash = hash(&mut source, None, control).await?;
        if let Some(expected) = cp.source_hash {
            if expected != source_hash || cp.total != attrs.len() { return Err("本地源文件内容已改变，未续传；请取消后重新上传".into()); }
        } else { cp.source_hash = Some(source_hash); cp.total = attrs.len(); }
        if io(control, exists(sf, &cp.target)).await? { return Err("远端已有同名文件，未覆盖；请取消后更换目录或文件名".into()); }
        if !cp.created {
            // Exclusive create is awaited to learn ownership even if pause/cancel arrives.
            let mut created = sf.open_with_flags(&cp.temp, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE | OpenFlags::READ).await.map_err(|e| format!("创建上传临时文件失败 {}：{e}", cp.temp))?;
            cp.created = true;
            io(&DownloadControl::default(), created.shutdown()).await?;
        }
        let meta = io(control, sf.symlink_metadata(&cp.temp)).await?;
        if !meta.file_type().is_file() { return Err("远端临时路径已改变，未续传".into()); }
        let mut dest = io(control, sf.open_with_flags(&cp.temp, OpenFlags::READ | OpenFlags::WRITE)).await?;
        let size = io(control, dest.metadata()).await?.size.ok_or("服务器未提供临时文件大小")?;
        if size < cp.offset || size > cp.total { return Err("远端临时文件长度已改变，未续传".into()); }
        let remote_hash = hash(&mut dest, Some(size), control).await?;
        io(control, source.seek(std::io::SeekFrom::Start(0))).await?;
        let mut prefix = Sha256::new(); let mut count = 0; let mut buffer = vec![0; 65536];
        while count < size {
            let limit = (size - count).min(buffer.len() as u64) as usize;
            let n = io(control, source.read(&mut buffer[..limit])).await?;
            if n == 0 { return Err("本地文件长度发生变化".into()); }
            prefix.update(&buffer[..n]); count += n as u64;
        }
        if <[u8; 32]>::from(prefix.clone().finalize()) != remote_hash { return Err("远端已上传内容已改变，未续传或删除；请手动检查临时文件".into()); }
        cp.offset = size; cp.prefix = prefix;
        io(control, dest.seek(std::io::SeekFrom::Start(size))).await?;
        report(TransferProgress { temporary_path: Some(cp.temp.clone()), name: name.clone(), transferred: cp.offset, total: Some(cp.total), stage: None })?;
        loop {
            let n = io(control, source.read(&mut buffer)).await?;
            if n == 0 { break; }
            // Drain SFTP write acknowledgements before acknowledging a pause.
            tokio::time::timeout(Duration::from_secs(30), async {
                dest.write_all(&buffer[..n]).await?; dest.flush().await
            }).await.map_err(|_| "上传写入超时，远端可能有未确认字节".to_string())?.map_err(|e| e.to_string())?;
            cp.offset += n as u64; cp.prefix.update(&buffer[..n]);
            report(TransferProgress { temporary_path: Some(cp.temp.clone()), name: name.clone(), transferred: cp.offset, total: Some(cp.total), stage: None })?;
        }
        if cp.offset != cp.total || <[u8; 32]>::from(cp.prefix.clone().finalize()) != source_hash { return Err("本地文件在上传期间改变，未发布".into()); }
        io(control, dest.shutdown()).await?;
        report(TransferProgress { temporary_path: Some(cp.temp.clone()), name: name.clone(), transferred: cp.offset, total: Some(cp.total), stage: Some("verifying") })?;
        let mut remote = io(control, sf.open(&cp.temp)).await?;
        if io(control, remote.metadata()).await?.size != Some(cp.total) || hash(&mut remote, None, control).await? != source_hash {
            return Err("远端完整性校验失败，未发布".into());
        }
        io(control, remote.shutdown()).await?;
        // Reopen by path to detect replacement of the local source as well as in-place edits.
        let mut current = io(control, tokio::fs::File::open(&cp.local)).await?;
        if hash(&mut current, None, control).await? != source_hash { return Err("本地源文件在上传期间改变，未发布".into()); }
        if io(control, exists(sf, &cp.target)).await? { return Err("远端目标已被占用，未覆盖".into()); }
        io(control, async { Ok::<_, String>(()) }).await?;
        // SFTP v3 RENAME refuses an existing destination. Never use POSIX rename here.
        // Await the response without racing cancellation so a committed file is reported correctly.
        sf.rename(&cp.temp, &cp.target).await.map_err(|e| format!("发布失败（同名文件不会覆盖）：{e}"))?;
        let _ = report(TransferProgress { temporary_path: Some(cp.temp.clone()), name: name.clone(), transferred: cp.offset, total: Some(cp.total), stage: None });
        Ok(name)
    }.await;
    match result {
        Ok(name) => Ok(name),
        Err(error) => {
            if control.discard.load(Ordering::SeqCst) {
                match cleanup(&cp, sf).await {
                    Ok(()) => return Err("传输已取消".into()),
                    Err(cleanup_error) => {
                        let message = format!("可恢复：取消后未能清理 {}：{cleanup_error}；请重连后再次取消或手动检查", cp.temp);
                        store.lock().insert(id.into(), cp); return Err(message);
                    }
                }
            }
            let message = if error == "传输已暂停" { error } else { format!("可恢复：{error}；临时路径：{}", cp.temp) };
            store.lock().insert(id.into(), cp); Err(message)
        }
    }
}
