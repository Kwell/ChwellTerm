import { useState } from 'react';
import * as api from './bridge';
import { parseSshConfig, type SshImportPreview } from './sshConfig';
import type { Session } from './types';

export function SshImportDialog({ onImport }: { onImport: (sessions: Session[]) => void }) {
  const [text, setText] = useState(''), [username, setUsername] = useState(''), [home, setHome] = useState('');
  const [preview, setPreview] = useState<SshImportPreview | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  function reset() { setPreview(null); setSelected([]); setError(''); }
  async function chooseFile() {
    setBusy(true); reset();
    try { const source = await api.pickSshConfig(); if (source) { setText(source.text); setUsername(source.username); setHome(source.home); } }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  function inspect() {
    try { const next = parseSshConfig(text, username.trim(), home); setPreview(next); setSelected(next.entries.filter(e => e.session).map(e => e.alias)); setError(''); }
    catch (error) { setPreview(null); setError((error as Error).message); }
  }
  return <>
    <p className="subtle">选择 ~/.ssh/config 或粘贴内容，预览后合并会话。含未支持代理的主机会跳过；已有连接不会被覆盖。</p>
    {api.desktop && <button className="import-file-button" disabled={busy} onClick={() => void chooseFile()}>{busy ? '读取中…' : '选择 OpenSSH 文件'}</button>}
    <label>OpenSSH 配置<textarea rows={7} value={text} onChange={e => { setText(e.target.value); reset(); }} placeholder={'Host my-server\n  HostName 192.168.1.10\n  User admin\n  Port 22'} /></label>
    <label>默认用户名<input value={username} onChange={e => { setUsername(e.target.value); reset(); }} placeholder="用于未指定 User 的主机" /></label>
    <button className="import-file-button" disabled={!text.trim() || busy} onClick={inspect}>预览会话</button>
    {error && <p className="error-message" role="alert">{error}</p>}
    {preview && <div className="ssh-import-preview">
      {preview.warnings.map((warning, i) => <p className="notice" key={i}>{warning}</p>)}
      {preview.entries.map(entry => <div className="ssh-import-entry" key={entry.alias}>
        <label className="check-row"><input type="checkbox" disabled={!entry.session} checked={selected.includes(entry.alias)} onChange={e => setSelected(previous => e.target.checked ? [...previous, entry.alias] : previous.filter(name => name !== entry.alias))} />{entry.alias}{!entry.session && <span className="subtle">不可导入</span>}</label>
        {entry.session && <p className="subtle">{entry.session.username}@{entry.session.host}:{entry.session.port} · {{ key: '私钥', password: '密码', agent: 'SSH Agent', 'keyboard-interactive': '交互式认证 / OTP' }[entry.session.auth]}{entry.session.jump && ` · 经 ${entry.session.jump.username}@${entry.session.jump.host}:${entry.session.jump.port}`}</p>}
        {entry.warnings.map((warning, i) => <p className="subtle" key={i}>{warning}</p>)}
      </div>)}
    </div>}
    <div className="dialog-actions"><button className="primary" disabled={!preview || !selected.length} onClick={() => onImport(preview!.entries.filter(e => selected.includes(e.alias) && e.session).map(e => e.session!))}>导入所选会话（{selected.length}）</button></div>
  </>;
}
