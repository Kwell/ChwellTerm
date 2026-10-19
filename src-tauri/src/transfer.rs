use std::{path::Path, time::{Duration, Instant}};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress { #[serde(skip_serializing_if = "Option::is_none")] pub temporary_path: Option<String>, pub transferred: u64, pub total: Option<u64>, pub name: String, #[serde(skip_serializing_if = "Option::is_none")] pub stage: Option<&'static str> }

pub fn reporter(channel: Channel<TransferProgress>) -> impl FnMut(TransferProgress) -> Result<(), String> {
    let mut previous = Instant::now() - Duration::from_secs(1);
    move |progress| {
        if progress.stage.is_some() || progress.transferred == 0 || progress.total == Some(progress.transferred) || previous.elapsed() >= Duration::from_millis(100) {
            previous = Instant::now(); channel.send(progress).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
async fn cancellable<T>(cancel: &CancellationToken, future: impl std::future::Future<Output = Result<T, impl std::fmt::Display>>) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("传输已取消".into()),
        result = tokio::time::timeout(Duration::from_secs(30), future) => result.map_err(|_| "传输超时".to_string())?.map_err(|e| e.to_string()),
    }
}
async fn copy_progress(
    source: &mut (impl AsyncRead + Unpin), dest: &mut (impl AsyncWrite + Unpin), cancel: &CancellationToken,
    total: Option<u64>, name: &str, report: &mut impl FnMut(TransferProgress) -> Result<(), String>,
) -> Result<u64, String> {
    let mut transferred = 0; let mut buffer = vec![0; 64 * 1024];
    report(TransferProgress { temporary_path: None, stage: None, transferred, total, name: name.into() })?;
    loop {
        let count = cancellable(cancel, source.read(&mut buffer)).await?;
        if count == 0 { break; }
        cancellable(cancel, dest.write_all(&buffer[..count])).await?;
        transferred += count as u64;
        report(TransferProgress { temporary_path: None, stage: None, transferred, total, name: name.into() })?;
    }
    if total.is_some_and(|expected| expected != transferred) { return Err("文件大小在传输期间发生变化，请重新传输".into()); }
    report(TransferProgress { temporary_path: None, stage: None, transferred, total: Some(transferred), name: name.into() })?;
    Ok(transferred)
}

pub async fn upload(
    sf: &SftpSession, local_path: &str, remote_dir: &str, cancel: &CancellationToken,
    mut report: impl FnMut(TransferProgress) -> Result<(), String>,
) -> Result<String, String> {
    let path = Path::new(local_path);
    let name = path.file_name().and_then(|s| s.to_str()).ok_or("无效本地文件名")?.to_string();
    let target = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
    let mut source = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
    let meta = source.metadata().await.map_err(|e| e.to_string())?;
    if !meta.is_file() { return Err("只能上传普通文件".into()); }
    report(TransferProgress { temporary_path: None, stage: None, transferred: 0, total: Some(meta.len()), name: name.clone() })?;
    if cancel.is_cancelled() { return Err("传输已取消".into()); }
    // Await exclusive creation to learn whether this task owns the new file;
    // cancelling the open future could otherwise strand an unknown file.
    let mut dest = sf.open_with_flags(&target, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).await
        .map_err(|e| format!("无法创建远程文件（同名文件不会覆盖）：{e}"))?;
    let result = async {
        copy_progress(&mut source, &mut dest, cancel, Some(meta.len()), &name, &mut report).await?;
        cancellable(cancel, dest.shutdown()).await?;
        if cancel.is_cancelled() { return Err("传输已取消".into()); }
        Ok(name)
    }.await;
    if result.is_err() {
        let _ = tokio::time::timeout(Duration::from_secs(5), dest.shutdown()).await;
        drop(dest);
        if let Err(cleanup) = tokio::time::timeout(Duration::from_secs(5), sf.remove_file(&target)).await.map_err(|_| "清理超时".to_string()).and_then(|v| v.map_err(|e| e.to_string())) {
            return Err(format!("{}；未能清理远程文件 {target}：{cleanup}", result.unwrap_err()));
        }
    }
    result
}
pub async fn download(
    sf: &SftpSession, local_path: &str, remote_path: &str, cancel: &CancellationToken,
    report: impl FnMut(TransferProgress) -> Result<(), String>,
) -> Result<(), String> {
    download_file(sf, Path::new(local_path), remote_path, true, cancel, report).await
}

pub(crate) fn batch_target(target_dir: &str, remote_path: &str) -> Result<std::path::PathBuf, String> {
    let name = remote_path.rsplit('/').next().unwrap_or("");
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(prefix).is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")));
    if name.is_empty() || matches!(name, "." | "..") || name.ends_with(['.', ' ']) || reserved
        || name.chars().any(|ch| ch.is_control() || "\\:<>\"|?*".contains(ch)) {
        return Err(format!("无法安全保存文件名 {name:?}，请单独下载并指定本地文件名"));
    }
    let dir = Path::new(target_dir);
    if !dir.is_absolute() || !dir.is_dir() { return Err("无效下载目录，请选择现有目录".into()); }
    Ok(dir.join(name))
}

pub async fn download_batch(
    sf: &SftpSession, target_dir: &str, remote_path: &str, cancel: &CancellationToken,
    report: impl FnMut(TransferProgress) -> Result<(), String>,
) -> Result<(), String> {
    let path = batch_target(target_dir, remote_path)?;
    download_file(sf, &path, remote_path, false, cancel, report).await
}

async fn download_file(
    sf: &SftpSession, path: &Path, remote_path: &str, overwrite: bool, cancel: &CancellationToken,
    mut report: impl FnMut(TransferProgress) -> Result<(), String>,
) -> Result<(), String> {
    if !overwrite && path.try_exists().map_err(|e| e.to_string())? { return Err("本地已有同名文件，未覆盖；请单独下载并另存为".into()); }
    let name = remote_path.rsplit('/').next().unwrap_or(remote_path);
    report(TransferProgress { temporary_path: None, stage: None, transferred: 0, total: None, name: name.into() })?;
    let mut source = cancellable(cancel, sf.open(remote_path)).await?;
    let total = cancellable(cancel, source.metadata()).await?.size;
    let temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("无效目标目录")?).map_err(|e| e.to_string())?;
    let mut dest = tokio::fs::File::from_std(temp.reopen().map_err(|e| e.to_string())?);
    copy_progress(&mut source, &mut dest, cancel, total, name, &mut report).await?;
    cancellable(cancel, dest.sync_all()).await?;
    drop(dest);
    if cancel.is_cancelled() { return Err("传输已取消".into()); }
    if overwrite { temp.persist(path).map_err(|e| e.to_string())?; }
    else { temp.persist_noclobber(path).map_err(|e| format!("无法保存下载文件（同名文件不会覆盖）：{e}"))?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batch_names_cannot_escape_or_address_device_files() {
        let dir = tempfile::tempdir().unwrap(); let target = dir.path().to_str().unwrap();
        for name in ["", ".", "..", "..\\escape", "C:evil", "NUL.txt", "com1.txt", "LPT²", "CONOUT$", "a.", "a ", "a\0", "a\n", "bad?", "bad<"] {
            assert!(batch_target(target, &format!("/files/{name}")).is_err(), "{name:?}");
        }
        assert_eq!(batch_target(target, "/files/中文 hello.txt").unwrap(), dir.path().join("中文 hello.txt"));
        assert!(batch_target("relative", "/file.txt").is_err());
    }
}
