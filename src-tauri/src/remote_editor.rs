use std::future::Future;
use russh_sftp::{client::{RawSftpSession, error::Error}, protocol::{FileAttributes, OpenFlags, Packet, StatusCode}};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
#[derive(Debug, Serialize)]
pub struct RemoteDocument { pub content: String, pub revision: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult { pub document: RemoteDocument, pub backup_path: String }
pub struct RemoteEditor { raw: RawSftpSession, atomic_rename: bool, gate: Mutex<()> }
struct Snapshot { document: RemoteDocument, attrs: FileAttributes }

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') || path.ends_with('/') || matches!(path.rsplit('/').next(), Some("." | "..")) { return Err("无效远程文件路径".into()); }
    Ok(())
}
fn decode(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > MAX_TEXT_BYTES { return Err("仅支持不超过 1 MiB 的文本文件，请下载后编辑".into()); }
    if bytes.contains(&0) { return Err("此文件包含二进制内容，请下载后使用对应工具打开".into()); }
    String::from_utf8(bytes).map_err(|_| "仅支持 UTF-8 文本，请下载后转换编码".into())
}
fn revision(content: &str, attrs: &FileAttributes) -> String {
    let mut hash = Sha256::new(); hash.update(content.as_bytes());
    hash.update(format!("\0{:?}:{:?}:{:?}:{:?}:{:?}", attrs.size, attrs.permissions, attrs.uid, attrs.gid, attrs.mtime));
    format!("{:x}", hash.finalize())
}
async fn step<T, E: std::fmt::Display>(cancel: &CancellationToken, future: impl Future<Output = Result<T, E>>) -> Result<T, String> {
    tokio::select! { biased; _ = cancel.cancelled() => Err("远程编辑已取消".into()), result = future => result.map_err(|e| e.to_string()) }
}
impl RemoteEditor {
    pub async fn new<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static>(stream: S) -> Result<Self, String> {
        let raw = RawSftpSession::new(stream);
        let version = raw.init().await.map_err(|e| e.to_string())?;
        raw.set_timeout(10);
        Ok(Self { raw, atomic_rename: version.extensions.get("posix-rename@openssh.com").is_some_and(|v| v == "1"), gate: Mutex::new(()) })
    }
    async fn snapshot(&self, path: &str, cancel: &CancellationToken) -> Result<Snapshot, String> {
        validate_path(path)?;
        let attrs = step(cancel, self.raw.lstat(path)).await?.attrs;
        if !attrs.file_type().is_file() { return Err("仅支持普通文件；符号链接、目录和特殊文件请下载或在终端中编辑".into()); }
        if attrs.size.is_some_and(|n| n > MAX_TEXT_BYTES as u64) { return Err("仅支持不超过 1 MiB 的文本文件，请下载后编辑".into()); }
        if cancel.is_cancelled() { return Err("远程编辑已取消".into()); }
        let handle = self.raw.open(path, OpenFlags::READ, FileAttributes::default()).await.map_err(|e| e.to_string())?.handle;
        let result = async {
            let mut bytes = Vec::new();
            loop {
                let count = (MAX_TEXT_BYTES + 1 - bytes.len()).min(32768) as u32;
                let data = tokio::select! { biased; _ = cancel.cancelled() => return Err("远程编辑已取消".into()), data = self.raw.read(&handle, bytes.len() as u64, count) => data };
                match data {
                    Ok(data) if data.data.is_empty() => break,
                    Ok(data) => { bytes.extend(data.data); if bytes.len() > MAX_TEXT_BYTES { return Err("仅支持不超过 1 MiB 的文本文件，请下载后编辑".into()); } },
                    Err(Error::Status(status)) if status.status_code == StatusCode::Eof => break,
                    Err(e) => return Err(e.to_string()),
                }
            }
            let content = decode(bytes)?;
            let after = step(cancel, self.raw.lstat(path)).await?.attrs;
            if revision(&content, &attrs) != revision(&content, &after) || attrs.size.is_some_and(|n| n != content.len() as u64) { return Err("文件在读取期间发生变化，请重新打开".into()); }
            Ok(Snapshot { document: RemoteDocument { revision: revision(&content, &after), content }, attrs: after })
        }.await;
        let closed = self.raw.close(handle).await.map_err(|e| e.to_string());
        match result { Ok(value) => { closed?; Ok(value) }, Err(error) => Err(error) }
    }
    pub async fn read(&self, path: &str, cancel: &CancellationToken) -> Result<RemoteDocument, String> {
        let _lock = tokio::select! { biased; _ = cancel.cancelled() => return Err("远程编辑已取消".into()), lock = self.gate.lock() => lock };
        self.snapshot(path, cancel).await.map(|v| v.document)
    }
    async fn create_copy(&self, path: &str, content: &str, attrs: &FileAttributes, cancel: &CancellationToken) -> Result<FileAttributes, String> {
        // Exclusive creation is awaited: cancellation must not leave an unknown
        // file behind. The protocol itself has a ten-second response timeout.
        let handle = self.raw.open(path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE, FileAttributes { permissions: Some(0o600), ..Default::default() }).await.map_err(|e| format!("无法创建远程临时文件 {path}：{e}"))?.handle;
        let result = async {
            for (i, chunk) in content.as_bytes().chunks(32768).enumerate() { step(cancel, self.raw.write(&handle, (i * 32768) as u64, chunk.to_vec())).await?; }
            let created = step(cancel, self.raw.fstat(&handle)).await?.attrs;
            if (attrs.uid, attrs.gid) != (created.uid, created.gid) {
                step(cancel, self.raw.fsetstat(&handle, FileAttributes { uid: attrs.uid, gid: attrs.gid, ..Default::default() })).await.map_err(|e| format!("无法保留文件属主或属组：{e}"))?;
            }
            step(cancel, self.raw.fsetstat(&handle, FileAttributes { permissions: attrs.permissions.map(|p| p & 0o777), ..Default::default() })).await?;
            let final_attrs = step(cancel, self.raw.fstat(&handle)).await?.attrs;
            if final_attrs.size != Some(content.len() as u64) { return Err("服务器返回的文件大小与写入内容不符，保存已停止".into()); }
            if final_attrs.permissions.map(|p| p & 0o777) != attrs.permissions.map(|p| p & 0o777) || (final_attrs.uid, final_attrs.gid) != (attrs.uid, attrs.gid) { return Err("服务器未保留原文件权限、属主或属组，保存已停止".into()); }
            Ok(final_attrs)
        }.await;
        let close = self.raw.close(handle).await.map_err(|e| e.to_string());
        let result = result.and_then(|attrs| close.map(|_| attrs));
        if let Err(error) = result { return Err(self.cleanup(path, error).await); }
        result
    }
    async fn cleanup(&self, path: &str, error: String) -> String {
        match self.raw.remove(path).await { Ok(_) => error, Err(e) => format!("{error}；未能清理 {path}：{e}") }
    }
    pub async fn save(&self, path: &str, content: String, expected: &str, cancel: &CancellationToken) -> Result<SaveResult, String> {
        validate_path(path)?; decode(content.as_bytes().to_vec())?;
        if expected.len() != 64 { return Err("文件版本无效，请重新打开".into()); }
        if !self.atomic_rename { return Err("服务器不支持安全替换文件，请下载后使用其他工具编辑，或使用终端编辑器".into()); }
        let _lock = tokio::select! { biased; _ = cancel.cancelled() => return Err("远程编辑已取消".into()), lock = self.gate.lock() => lock };
        let original = self.snapshot(path, cancel).await?;
        if original.document.revision != expected { return Err("远端文件已被修改，未覆盖。请复制当前草稿，再重新读取远端内容".into()); }
        if original.attrs.permissions.is_some_and(|p| p & 0o7000 != 0) { return Err("包含特殊权限的文件请使用终端编辑器".into()); }
        // Check actual write permission on the original without truncating it.
        let permission = self.raw.open(path, OpenFlags::WRITE, FileAttributes::default()).await.map_err(|e| format!("无法以写入方式打开原文件（可能权限不足）：{e}"))?.handle;
        self.raw.close(permission).await.map_err(|e| e.to_string())?;
        let directory = path.rsplit_once('/').map_or(".", |(dir, _)| if dir.is_empty() { "/" } else { dir });
        let prefix = format!("{}/.twb-{}", directory.trim_end_matches('/'), uuid::Uuid::new_v4());
        let temp = format!("{prefix}.tmp"); let backup = format!("{prefix}.bak");
        let new_attrs = self.create_copy(&temp, &content, &original.attrs, cancel).await?;
        let mut backup_ready = false;
        let result = async {
            self.create_copy(&backup, &original.document.content, &original.attrs, cancel).await?;
            backup_ready = true;
            let current = self.snapshot(path, cancel).await?;
            if current.document.revision != expected { return Err("远端文件在保存期间发生变化，未覆盖，请重新读取".into()); }
            if cancel.is_cancelled() { return Err("远程编辑已取消".into()); }
            let mut payload = Vec::new();
            for value in [&temp, &path.to_string()] { payload.extend_from_slice(&(value.len() as u32).to_be_bytes()); payload.extend_from_slice(value.as_bytes()); }
            // Once commit starts, await its acknowledgement instead of racing
            // cancellation. Never delete or truncate the original as fallback.
            match self.raw.extended("posix-rename@openssh.com", payload).await {
                Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok => {},
                Ok(Packet::Status(status)) => return Err(format!("服务器拒绝替换文件：{}", status.error_message)),
                Ok(_) => return Err("保存结果未知，请重新读取远端文件后再操作".into()),
                Err(e) => return Err(format!("未收到保存确认，请重新读取远端文件核对：{e}")),
            }
            Ok(SaveResult { document: RemoteDocument { revision: revision(&content, &new_attrs), content }, backup_path: backup.clone() })
        }.await;
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                // A failed/unknown rename may already have consumed the temp.
                let error = match self.raw.lstat(&temp).await {
                    Ok(_) => self.cleanup(&temp, error).await,
                    Err(Error::Status(s)) if s.status_code == StatusCode::NoSuchFile => error,
                    Err(e) => format!("{error}；无法确认临时文件 {temp} 是否已清理：{e}"),
                };
                Err(if backup_ready { format!("{error}；原内容备份：{backup}") } else { error })
            }
        }
    }
}
