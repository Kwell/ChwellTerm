use std::{collections::HashMap, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use crate::transfer::TransferProgress;

pub type Store = Arc<Mutex<HashMap<String, Checkpoint>>>;
pub struct Checkpoint {
    owner: String, target: PathBuf, remote: String, overwrite: bool,
    temp: Option<tempfile::NamedTempFile>, offset: u64, source_hash: Option<[u8; 32]>,
    prefix: Sha256, target_hash: Option<[u8; 32]>, total: u64,
}
#[derive(Clone)]
pub struct DownloadControl {
    pub cancel: CancellationToken, pub pause: CancellationToken, pub discard: Arc<AtomicBool>,
}
impl Default for DownloadControl {
    fn default() -> Self { Self { cancel: CancellationToken::new(), pause: CancellationToken::new(), discard: Arc::new(AtomicBool::new(false)) } }
}
pub(crate) async fn io<T>(control: &DownloadControl, future: impl std::future::Future<Output=Result<T, impl std::fmt::Display>>) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = control.cancel.cancelled() => Err("传输已取消".into()),
        _ = control.pause.cancelled() => Err("传输已暂停".into()),
        result = tokio::time::timeout(std::time::Duration::from_secs(30), future) => result.map_err(|_| "传输超时".to_string())?.map_err(|e| e.to_string()),
    }
}
pub(crate) async fn hash(reader: &mut (impl AsyncRead + Unpin), limit: Option<u64>, control: &DownloadControl) -> Result<[u8; 32], String> {
    let mut digest = Sha256::new(); let mut buffer = vec![0; 65536]; let mut count = 0;
    loop {
        let len = limit.map(|n| (n - count).min(buffer.len() as u64) as usize).unwrap_or(buffer.len());
        if len == 0 { break; }
        let n = io(control, reader.read(&mut buffer[..len])).await?;
        if n == 0 { if limit.is_some_and(|expected| count != expected) { return Err("文件长度发生变化".into()); } break; }
        digest.update(&buffer[..n]); count += n as u64;
    }
    Ok(digest.finalize().into())
}
async fn target_hash(target: &PathBuf, control: &DownloadControl) -> Result<Option<[u8; 32]>, String> {
    match tokio::fs::File::open(target).await {
        Ok(mut file) => {
            if !file.metadata().await.map_err(|e| e.to_string())?.is_file() { return Err("目标不是普通文件".into()); }
            Ok(Some(hash(&mut file, None, control).await?))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A dangling link also occupies the destination.
            if tokio::fs::symlink_metadata(target).await.is_ok() { return Err("目标路径已被符号链接占用".into()); }
            Ok(None)
        }
        Err(error) => Err(error.to_string()),
    }
}

// Checkpoints are process-local capabilities: no credentials, paths or offsets are persisted.
// The frontend cannot supply an offset or change a checkpoint's owner or destinations.
pub async fn run(
    store: &Store, id: &str, owner: &str, sf: &SftpSession, target: PathBuf, remote: &str, overwrite: bool,
    control: &DownloadControl, mut report: impl FnMut(TransferProgress) -> Result<(), String>,
) -> Result<(), String> {
    let mut checkpoint = {
        let mut entries = store.lock();
        if !entries.contains_key(id) && entries.len() >= 200 { return Err("下载断点最多保留 200 项，请取消不再需要的任务".into()); }
        if let Some(existing) = entries.get(id) {
            if existing.owner != owner || existing.target != target || existing.remote != remote || existing.overwrite != overwrite {
                return Err("可恢复：连接身份或文件路径已改变，请恢复原连接或取消此任务后重新下载".into());
            }
        }
        entries.remove(id)
    };
    if checkpoint.is_none() {
        let original = target_hash(&target, control).await?;
        if !overwrite && original.is_some() { return Err("本地已有同名文件，未覆盖；请单独下载并另存为".into()); }
        let temp = tempfile::NamedTempFile::new_in(target.parent().ok_or("无效目标目录")?).map_err(|e| e.to_string())?;
        checkpoint = Some(Checkpoint { owner: owner.into(), target, remote: remote.into(), overwrite, temp: Some(temp), offset: 0, source_hash: None, prefix: Sha256::new(), target_hash: original, total: 0 });
    }
    let mut cp = checkpoint.unwrap();
    let result = async {
        let name = cp.remote.rsplit('/').next().unwrap_or(&cp.remote).to_string();
        report(TransferProgress { temporary_path: None, stage: None, transferred: cp.offset, total: cp.source_hash.map(|_| cp.total), name: name.clone() })?;
        report(TransferProgress { temporary_path: None, stage: Some("verifying"), transferred: cp.offset, total: cp.source_hash.map(|_| cp.total), name: name.clone() })?;
        let meta = io(control, sf.symlink_metadata(&cp.remote)).await?;
        if !meta.file_type().is_file() { return Err("仅支持普通文件的断点下载".into()); }
        let mut source = io(control, sf.open(&cp.remote)).await?;
        let attrs = io(control, source.metadata()).await?;
        let total = attrs.size.ok_or("服务器未提供文件大小，无法校验续传")?;
        let source_hash = hash(&mut source, Some(total), control).await?;
        if let Some(expected) = cp.source_hash {
            if total != cp.total || source_hash != expected { return Err("远端文件内容已改变，未续传；请取消此任务后重新下载".into()); }
        } else { cp.source_hash = Some(source_hash); cp.total = total; }
        if target_hash(&cp.target, control).await? != cp.target_hash { return Err("本地目标已改变，未覆盖；请取消此任务后重新选择保存位置".into()); }
        let mut dest = tokio::fs::File::from_std(cp.temp.as_ref().unwrap().reopen().map_err(|e| e.to_string())?);
        io(control, dest.seek(std::io::SeekFrom::Start(0))).await?;
        if hash(&mut dest, Some(cp.offset), control).await? != <[u8; 32]>::from(cp.prefix.clone().finalize()) {
            return Err("本地临时文件已改变，未续传；请取消此任务后重新下载".into());
        }
        dest.set_len(cp.offset).await.map_err(|e| e.to_string())?;
        dest.seek(std::io::SeekFrom::Start(cp.offset)).await.map_err(|e| e.to_string())?;
        io(control, source.seek(std::io::SeekFrom::Start(cp.offset))).await?;
        report(TransferProgress { temporary_path: None, stage: None, transferred: cp.offset, total: Some(total), name: name.clone() })?;
        let mut buffer = vec![0; 65536];
        loop {
            let count = io(control, source.read(&mut buffer)).await?;
            if count == 0 { break; }
            // Finish each local write (including Tokio's blocking IO) before acknowledging
            // pause/cancel. A detached background write must never outlive its checkpoint.
            // If an IO error leaves a tail, the next attempt truncates to confirmed bytes.
            dest.write_all(&buffer[..count]).await.map_err(|e| e.to_string())?;
            dest.flush().await.map_err(|e| e.to_string())?;
            cp.offset += count as u64; cp.prefix.update(&buffer[..count]);
            report(TransferProgress { temporary_path: None, stage: None, transferred: cp.offset, total: Some(total), name: name.clone() })?;
        }
        if cp.offset != total || <[u8; 32]>::from(cp.prefix.clone().finalize()) != source_hash { return Err("传输内容校验失败，未提交目标文件".into()); }
        io(control, dest.sync_all()).await?;
        report(TransferProgress { temporary_path: None, stage: Some("verifying"), transferred: cp.offset, total: Some(total), name: name.clone() })?;
        io(control, dest.seek(std::io::SeekFrom::Start(0))).await?;
        if hash(&mut dest, Some(total), control).await? != source_hash { return Err("本地文件完整性校验失败，未提交目标文件".into()); }
        let final_attrs = io(control, source.metadata()).await?;
        if final_attrs.size != attrs.size || final_attrs.mtime != attrs.mtime { return Err("远端文件在传输期间改变，未提交目标文件".into()); }
        if target_hash(&cp.target, control).await? != cp.target_hash { return Err("本地目标已改变，未覆盖；请重新选择保存位置".into()); }
        drop(dest);
        if control.cancel.is_cancelled() { return Err("传输已取消".into()); }
        if control.pause.is_cancelled() { return Err("传输已暂停".into()); }
        let temp = cp.temp.take().unwrap();
        let saved = if cp.overwrite && cp.target_hash.is_some() { temp.persist(&cp.target) } else { temp.persist_noclobber(&cp.target) };
        if let Err(error) = saved { let message = format!("无法提交下载文件（目标未覆盖）：{}", error.error); cp.temp = Some(error.file); return Err(message); }
        let _ = report(TransferProgress { temporary_path: None, stage: None, transferred: cp.offset, total: Some(total), name });
        Ok(())
    }.await;
    match result {
        Ok(()) => Ok(()),
        Err(_) if control.discard.load(Ordering::SeqCst) => { drop(cp); Err("传输已取消".into()) },
        Err(error) => {
            store.lock().insert(id.into(), cp);
            if error == "传输已暂停" { Err(error) } else { Err(format!("可恢复：{error}")) }
        }
    }
}
