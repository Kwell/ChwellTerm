use std::{collections::HashMap, io::Write, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String, pub name: String, pub host: String, pub port: u16,
    pub username: String, pub environment: String, pub auth: String,
    pub key_path: String, pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump: Option<JumpHost>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpHost { pub host: String, pub port: u16, pub username: String, pub auth: String, pub key_path: String }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings { pub theme: String, pub font_size: u16, pub font_family: String, pub scrollback: u32, #[serde(default)] pub restore_workspace: bool }
#[derive(Serialize, Deserialize)]
pub struct Snippet { pub name: String, pub command: String }
#[derive(Serialize, Deserialize)]
pub struct Config {
    pub version: u8, pub sessions: Vec<Session>, pub settings: Settings, pub snippets: Vec<Snippet>,
    #[serde(default)] pub workspaces: Vec<Workspace>,
    #[serde(default, rename = "lastWorkspace", skip_serializing_if = "Option::is_none")] pub last_workspace: Option<WorkspaceSnapshot>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTab { pub id: String, pub session_id: String }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot { pub tabs: Vec<WorkspaceTab>, pub active_tab_id: String, #[serde(default, skip_serializing_if = "Option::is_none")] pub secondary_tab_id: Option<String>, pub layout: String, pub split_ratio: f64, pub files_open: bool, #[serde(default, skip_serializing_if = "Option::is_none")] pub pane_tab_ids: Option<Vec<String>>, #[serde(default, skip_serializing_if = "Option::is_none")] pub row_ratio: Option<f64> }
#[derive(Serialize, Deserialize)]
pub struct Workspace { pub id: String, pub name: String, #[serde(flatten)] pub snapshot: WorkspaceSnapshot }

pub fn validate_workspaces(config: &Config) -> Result<(), String> {
    if config.workspaces.len() > 100 { return Err("最多保存 100 个工作空间".into()); }
    let mut ids = std::collections::HashSet::new();
    for workspace in &config.workspaces {
        if workspace.id.is_empty() || workspace.id.len() > 128 || !ids.insert(&workspace.id) || workspace.name.trim().is_empty() || workspace.name.chars().count() > 80 { return Err("工作空间名称或 ID 无效".into()); }
    }
    for snapshot in config.workspaces.iter().map(|w| &w.snapshot).chain(config.last_workspace.iter()) {
        if snapshot.tabs.len() > 32 || !["single", "horizontal", "vertical", "grid"].contains(&snapshot.layout.as_str()) || !snapshot.split_ratio.is_finite() || !(20.0..=80.0).contains(&snapshot.split_ratio) { return Err("工作空间布局无效".into()); }
        let mut tab_ids = std::collections::HashSet::new();
        if snapshot.tabs.iter().any(|t| t.id.is_empty() || t.id.len() > 128 || t.session_id.is_empty() || !tab_ids.insert(&t.id)) { return Err("工作空间标签无效".into()); }
        if snapshot.tabs.is_empty() { if !snapshot.active_tab_id.is_empty() { return Err("工作空间活动标签无效".into()); } }
        else if !tab_ids.contains(&snapshot.active_tab_id) { return Err("工作空间活动标签无效".into()); }
        if let Some(id) = &snapshot.secondary_tab_id { if !id.is_empty() && (id == &snapshot.active_tab_id || !tab_ids.contains(id)) { return Err("工作空间第二面板无效".into()); } }
        if let Some(panes) = &snapshot.pane_tab_ids { let mut unique = std::collections::HashSet::new(); if panes.len() > 4 || panes.iter().any(|id| !tab_ids.contains(id) || !unique.insert(id)) { return Err("工作空间面板排列无效".into()); } }
        if snapshot.row_ratio.is_some_and(|ratio| !ratio.is_finite() || !(20.0..=80.0).contains(&ratio)) { return Err("工作空间上下比例无效".into()); }
    }
    Ok(())
}

pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("无效配置路径")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(contents).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn read_known_hosts(path: &Path) -> Result<HashMap<String, String>, String> {
    match std::fs::read(path) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(|e| format!("已知主机配置损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(e.to_string()),
    }
}
pub fn expand_key_path(raw: &str) -> PathBuf {
    let raw = raw.trim();
    let raw = raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')).or_else(|| raw.strip_prefix('\'').and_then(|s| s.strip_suffix('\''))).unwrap_or(raw);
    if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
        if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
            return PathBuf::from(home).join(raw.trim_start_matches('~').trim_start_matches(['/', '\\']));
        }
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grid_workspace_schema_preserves_positions_and_validates_references() {
        let fixture = serde_json::json!({"version":1,"sessions":[],"snippets":[],"settings":{"theme":"dark","fontSize":13,"fontFamily":"mono","scrollback":1000},"workspaces":[{"id":"grid","name":"四宫格","tabs":[{"id":"a","sessionId":"local"},{"id":"b","sessionId":"local"},{"id":"c","sessionId":"local"},{"id":"d","sessionId":"local"}],"activeTabId":"c","secondaryTabId":"b","layout":"grid","splitRatio":35,"rowRatio":65,"paneTabIds":["d","c","b","a"],"filesOpen":false}]});
        let config: Config = serde_json::from_value(fixture.clone()).unwrap(); validate_workspaces(&config).unwrap();
        let saved = serde_json::to_value(&config).unwrap(); assert_eq!(saved["workspaces"][0]["paneTabIds"], fixture["workspaces"][0]["paneTabIds"]); assert_eq!(saved["workspaces"][0]["rowRatio"], 65.0);
        for bad in [serde_json::json!(["a","a"]),serde_json::json!(["unknown"]),serde_json::json!(["a","b","c","d","a"])] {
            let mut invalid=fixture.clone(); invalid["workspaces"][0]["paneTabIds"]=bad;
            assert!(validate_workspaces(&serde_json::from_value(invalid).unwrap()).is_err());
        }
        for ratio in [19,81] { let mut invalid=fixture.clone(); invalid["workspaces"][0]["rowRatio"]=ratio.into(); assert!(validate_workspaces(&serde_json::from_value(invalid).unwrap()).is_err()); }
    }
    #[test]
    fn atomic_replacement_preserves_valid_known_hosts() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("known-hosts.json");
        atomic_write(&path, br#"{"server:22":"original"}"#).unwrap();
        atomic_write(&path, br#"{"server:22":"replacement"}"#).unwrap();
        assert_eq!(read_known_hosts(&path).unwrap()["server:22"], "replacement");
        std::fs::write(&path, "invalid").unwrap(); assert!(read_known_hosts(&path).is_err());
    }
    #[test]
    fn config_serialization_drops_secret_fields() {
        let value = serde_json::json!({"version":1,"sessions":[{"id":"a","name":"a","host":"localhost","port":22,"username":"u","environment":"development","auth":"password","keyPath":"","kind":"ssh","password":"secret"}],"settings":{"theme":"dark","fontSize":13,"fontFamily":"mono","scrollback":1000},"snippets":[]});
        let parsed: Config = serde_json::from_value(value).unwrap();
        assert!(!serde_json::to_string(&parsed).unwrap().contains("secret"));
    }
    #[test]
    fn workspace_persistence_keeps_layout_and_strips_runtime_secrets() {
        let mut value = serde_json::json!({"version":1,"sessions":[],"settings":{"theme":"dark","fontSize":13,"fontFamily":"mono","scrollback":1000},"snippets":[]});
        let old: Config = serde_json::from_value(value.clone()).unwrap(); assert!(old.workspaces.is_empty()); assert!(!old.settings.restore_workspace);
        value["settings"]["restoreWorkspace"] = true.into();
        value["workspaces"] = serde_json::json!([{"id":"daily","name":"日常","tabs":[{"id":"tab-a","sessionId":"server","password":"never-save","session":{"password":"secret-key"}}],"activeTabId":"tab-a","layout":"vertical","splitRatio":35,"filesOpen":false,"responses":["private-otp"]}]);
        value["lastWorkspace"] = value["workspaces"][0].clone();
        let parsed: Config = serde_json::from_value(value).unwrap(); validate_workspaces(&parsed).unwrap();
        let saved = serde_json::to_string(&parsed).unwrap(); assert!(!saved.contains("never-save") && !saved.contains("secret-key") && !saved.contains("private-otp"));
        let mut restored: Config = serde_json::from_str(&saved).unwrap(); assert!(restored.settings.restore_workspace); assert_eq!(restored.workspaces[0].snapshot.split_ratio, 35.0); assert!(!restored.last_workspace.as_ref().unwrap().files_open);
        restored.workspaces[0].snapshot.active_tab_id = "absent".into(); assert!(validate_workspaces(&restored).is_err());
    }
}
