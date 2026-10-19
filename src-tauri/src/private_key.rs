use std::{fs::File, io::Read, sync::Arc};
use russh::keys::{decode_secret_key, Error, PrivateKey};
use zeroize::Zeroizing;
use crate::config::expand_key_path;

const MAX_KEY_BYTES: u64 = 1024 * 1024;

// Classify local failures without printing any key material or passphrase.
pub fn load(raw_path: &str, passphrase: &str) -> Result<Arc<PrivateKey>, String> {
    let path = expand_key_path(raw_path);
    if path.is_dir() { return Err("私钥路径指向目录，请选择私钥文件".into()); }
    let file = File::open(&path).map_err(|error| {
        let reason = match error.kind() {
            std::io::ErrorKind::NotFound => "私钥文件不存在，请重新选择文件",
            std::io::ErrorKind::PermissionDenied => "没有权限读取私钥文件，请检查文件权限",
            _ => "无法打开私钥文件，请检查路径与文件访问权限",
        };
        format!("{reason}：{}", path.display())
    })?;
    if !file.metadata().map_err(|_| "无法读取私钥文件信息")?.is_file() {
        return Err("私钥路径指向目录，请选择私钥文件".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_KEY_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "无法读取私钥文件，请检查文件访问权限")?;
    if bytes.len() as u64 > MAX_KEY_BYTES { return Err("私钥文件超过 1 MB，请确认选择的是私钥文件".into()); }
    let text = std::str::from_utf8(&bytes).map_err(|_| "私钥文件不是 UTF-8 文本，请从密钥管理器导出 OpenSSH 格式私钥")?.trim_start_matches('\u{feff}').trim();
    if text.is_empty() { return Err("私钥文件为空，请重新选择有效私钥".into()); }
    if text.starts_with("ssh-") || text.starts_with("ecdsa-") || text.starts_with("sk-") || text.contains("BEGIN SSH2 PUBLIC KEY") || text.contains("BEGIN PUBLIC KEY") || text.contains("BEGIN RSA PUBLIC KEY") {
        return Err("选择的是公钥，不能用于私钥认证；请选择对应的私钥文件（通常不带 .pub 后缀）".into());
    }
    if text.contains("BEGIN SSH2") {
        return Err("暂不支持 SSH2 / XShell 专用私钥格式，请在 XShell 密钥管理器中导出 OpenSSH 格式私钥后重新选择".into());
    }
    let supported = ["-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN EC PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----", "-----BEGIN ENCRYPTED PRIVATE KEY-----"];
    if !supported.iter().any(|header| text.starts_with(header)) && !text.starts_with("PuTTY-User-Key-File-") {
        return Err("无法识别私钥格式，请选择 OpenSSH / PEM / PuTTY PPK 私钥；XShell 专用格式需先导出为 OpenSSH".into());
    }
    decode_secret_key(text, if passphrase.is_empty() { None } else { Some(passphrase) }).map(Arc::new).map_err(|error| match error {
        Error::KeyIsEncrypted | Error::SshKey(russh::keys::ssh_key::Error::Encrypted) => "私钥已加密，请在连接认证窗口填写私钥口令（不是服务器登录密码）".into(),
        Error::SshKey(russh::keys::ssh_key::Error::Crypto) | Error::Unpad(_) | Error::Pad(_) => "私钥解密失败：口令不正确或密钥已损坏，请检查私钥口令".into(),
        Error::UnsupportedKeyType { .. } | Error::UnknownAlgorithm(_) | Error::SshKey(russh::keys::ssh_key::Error::AlgorithmUnknown | russh::keys::ssh_key::Error::AlgorithmUnsupported { .. }) => "私钥算法不受支持，请使用 RSA、Ed25519 或 ECDSA 私钥".into(),
        _ => if passphrase.is_empty() { "私钥内容无效或格式不受支持，请重新导出为 OpenSSH 格式；若已加密，请填写私钥口令" } else { "私钥解析失败：口令不正确、文件损坏或格式不受支持，请检查口令或重新导出为 OpenSSH" }.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explains_paths_formats_and_public_keys_without_exposing_contents() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path().join("missing").to_str().unwrap(), "").unwrap_err().contains("不存在"));
        assert!(load(dir.path().to_str().unwrap(), "").is_err());
        let path = dir.path().join("输入文件.key");
        for (contents, message) in [("", "为空"), ("ssh-ed25519 secret-test-public-data", "公钥"), ("---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nprivate-secret-marker", "XShell"), ("private-secret-marker", "无法识别"), ("-----BEGIN OPENSSH PRIVATE KEY-----\nbroken-secret-marker\n-----END OPENSSH PRIVATE KEY-----", "私钥内容无效")] {
            std::fs::write(&path, contents).unwrap();
            let error = load(path.to_str().unwrap(), "").unwrap_err();
            assert!(error.contains(message), "{error}"); assert!(!error.contains("secret-marker") && !error.contains("secret-test"));
        }
        std::fs::write(&path, vec![b'a'; MAX_KEY_BYTES as usize + 1]).unwrap();
        assert!(load(path.to_str().unwrap(), "").unwrap_err().contains("1 MB"));
        std::fs::write(&path, [0xff, 0xfe, 0]).unwrap();
        assert!(load(path.to_str().unwrap(), "").unwrap_err().contains("UTF-8"));
    }
    #[test]
    fn reads_generated_keys_bom_quoted_paths_and_encrypted_keys() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("中文 key");
        let key = PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
        let text = key.to_openssh(russh::keys::ssh_key::LineEnding::LF).unwrap();
        std::fs::write(&path, format!("\u{feff}{}", text.as_str())).unwrap();
        assert_eq!(load(&format!("  \"{}\"  ", path.display()), "").unwrap().public_key(), key.public_key());
        let encrypted = key.encrypt(&mut rand::rng(), "test-passphrase").unwrap();
        encrypted.write_openssh_file(&path, russh::keys::ssh_key::LineEnding::LF).unwrap();
        assert!(load(path.to_str().unwrap(), "").unwrap_err().contains("已加密"));
        let error = load(path.to_str().unwrap(), "wrong-secret-passphrase").unwrap_err();
        assert!(error.contains("解密失败") && !error.contains("wrong-secret"));
        assert_eq!(load(path.to_str().unwrap(), "test-passphrase").unwrap().public_key(), key.public_key());
    }
}
