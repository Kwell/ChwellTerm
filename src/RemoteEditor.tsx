import { useEffect, useRef, useState } from 'react';
import { Copy, Save, RefreshCw } from 'lucide-react';
import { Dialog } from './Dialog';
import * as api from './bridge';
import type { RemoteDocument } from './types';
import { openText, saveText, textBytes, MAX_TEXT_BYTES, type LineEnding } from './remoteText';

export interface EditorTarget { tabId: string; sessionName: string; path: string; }
export function RemoteEditor({ target, connected, suspended = false, onClose, onSaved }: { target: EditorTarget; connected: boolean; suspended?: boolean; onClose(): void; onSaved(): void }) {
  const [document, setDocument] = useState<RemoteDocument | null>(null);
  const [text, setText] = useState(''), [bom, setBom] = useState(false), [lineEnding, setLineEnding] = useState<LineEnding>('lf');
  const [busy, setBusy] = useState<'read' | 'save' | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [backup, setBackup] = useState(''), [confirm, setConfirm] = useState<'close' | 'reload' | null>(null), [lost, setLost] = useState(!connected);
  const alive = useRef(true), inFlight = useRef(false), textarea = useRef<HTMLTextAreaElement>(null);
  const content = saveText(text, bom, lineEnding), bytes = textBytes(content);
  const original = document ? openText(document.content) : null;
  const dirty = !!original && (text !== original.text || bom !== original.bom || lineEnding !== original.lineEnding);
  const unavailable = !connected || lost;
  function accept(next: RemoteDocument) { const opened = openText(next.content); setDocument(next); setText(opened.text); setBom(opened.bom); setLineEnding(opened.lineEnding); setNotice(opened.mixed ? '文件使用混合换行；修改后保存将统一为所选换行格式。' : ''); }
  async function load() {
    if (inFlight.current || unavailable) return;
    inFlight.current = true; setBusy('read'); setError(''); setConfirm(null); setNotice('');
    try { const next = await api.readRemoteText(target.tabId, target.path); if (alive.current) accept(next); }
    catch (e) { if (alive.current) setError(String(e)); }
    finally { inFlight.current = false; if (alive.current) { setBusy(null); requestAnimationFrame(() => textarea.current?.focus()); } }
  }
  async function save() {
    if (!document || !dirty || inFlight.current || unavailable || bytes > MAX_TEXT_BYTES) return;
    inFlight.current = true; setBusy('save'); setError(''); setConfirm(null); setNotice('');
    try { const result = await api.saveRemoteText(target.tabId, target.path, content, document.revision); if (alive.current) { accept(result.document); setBackup(result.backupPath); setNotice('已保存到远端，原内容已备份。'); onSaved(); } }
    catch (e) { if (alive.current) setError(String(e)); }
    finally { inFlight.current = false; if (alive.current) setBusy(null); }
  }
  function request(action: 'close' | 'reload') { if (inFlight.current) return; if (dirty) setConfirm(action); else if (action === 'close') onClose(); else void load(); }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!connected) setLost(true); }, [connected]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (suspended) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (confirm) setConfirm(null); else request('close'); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); void save(); }
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  });
  return <Dialog title={`远程文件编辑${dirty ? ' · 未保存' : ''}`} wide closeDisabled={!!busy} onClose={() => request('close')}>
    <div className="editor-location"><strong>{target.sessionName}</strong><code>{target.path}</code></div>
    <div className="editor-options"><span>UTF-8{bom ? ' · BOM' : ''}</span><label>换行<select aria-label="换行格式" value={lineEnding} disabled={!document || !!busy} onChange={e => setLineEnding(e.target.value as LineEnding)}><option value="lf">LF</option><option value="crlf">CRLF</option></select></label><span>{text.split('\n').length} 行 · {bytes.toLocaleString()} B</span></div>
    {unavailable && <p className="notice">连接已断开，草稿保留在此窗口中。请复制草稿，重新连接后再打开文件。</p>}
    {notice && <p className="subtle" role="status">{notice}</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {bytes > MAX_TEXT_BYTES && <p className="error-message" role="alert">编辑内容超过 1 MiB，请缩减内容或下载后编辑。</p>}
    <textarea className="remote-editor-text" ref={textarea} aria-label="远程文件内容" value={text} onChange={e => setText(e.target.value)} disabled={!document || !!busy} spellCheck={false} wrap="off" placeholder={busy === 'read' ? '正在读取远端文件…' : 'UTF-8 文本'} onKeyDown={e => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const el = e.currentTarget, start = el.selectionStart, end = el.selectionEnd; setText(text.slice(0, start) + '  ' + text.slice(end)); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; }); } }} />
    {backup && <p className="editor-backup">上次备份：<code>{backup}</code></p>}
    {confirm && <div className="editor-confirm" role="alert"><span>{confirm === 'close' ? '关闭将丢弃未保存的修改。' : '重新读取将丢弃草稿并加载远端内容。'}</span><button onClick={() => setConfirm(null)}>保留草稿</button><button className="danger" onClick={() => { setConfirm(null); if (confirm === 'close') onClose(); else void load(); }}>{confirm === 'close' ? '丢弃并关闭' : '丢弃并重新读取'}</button></div>}
    <div className="dialog-actions"><button disabled={!document || !!busy} onClick={() => void navigator.clipboard.writeText(content).then(() => setNotice('草稿已复制。')).catch(() => setError('无法写入剪贴板，请手动选择内容复制'))}><Copy size={14} />复制草稿</button><button disabled={!!busy || unavailable} onClick={() => request('reload')}><RefreshCw size={14} />重新读取</button><button disabled={!!busy} onClick={() => request('close')}>关闭</button><button className="primary" disabled={!document || !dirty || !!busy || unavailable || bytes > MAX_TEXT_BYTES} onClick={() => void save()}><Save size={14} />{busy === 'save' ? '正在保存…' : '保存到远端'}</button></div>
  </Dialog>;
}
