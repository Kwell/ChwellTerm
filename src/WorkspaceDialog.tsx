import { useState } from 'react';
import { Pencil, Trash2, FolderOpen } from 'lucide-react';
import type { AppData, SavedWorkspace } from './types';

export function WorkspaceDialog({ data, tabCount, onSave, onOpen, onChange }: {
  data: AppData; tabCount: number; onSave(name: string, replaceId?: string): void;
  onOpen(workspace: SavedWorkspace): void; onChange(workspaces: SavedWorkspace[]): void;
}) {
  const [name, setName] = useState(''), [error, setError] = useState('');
  const [renameId, setRenameId] = useState(''), [rename, setRename] = useState(''), [deleteId, setDeleteId] = useState(''), [replaceId, setReplaceId] = useState('');
  function validate(value: string, id?: string) {
    if (!value.trim() || value.trim().length > 80) return '名称应为 1–80 个字符';
    if (data.workspaces.some(w => w.id !== id && w.name === value.trim())) return '工作空间名称已存在';
    return '';
  }
  return <>
    <p className="subtle">保存标签顺序、当前标签、分屏比例和文件面板。打开时添加待连接标签，保留当前终端；密码和验证码需重新认证。</p>
    <form onSubmit={e => { e.preventDefault(); const message = validate(name); setError(message); if (!message) { onSave(name.trim()); setName(''); } }}>
      <label>工作空间名称<input value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="例如：日常开发" /></label>
      <div className="dialog-actions"><span className="subtle push-left">当前 {tabCount} 个标签</span><button className="primary" type="submit" disabled={!tabCount || data.workspaces.length >= 100}>保存当前工作空间</button></div>
    </form>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="workspace-list">
      {!data.workspaces.length && <p className="subtle">暂无已保存工作空间。</p>}
      {data.workspaces.map(workspace => {
        const missing = workspace.tabs.filter(t => !data.sessions.some(s => s.id === t.sessionId)).length;
        return <article className="workspace-entry" key={workspace.id}>
          <div className="workspace-entry-heading"><strong>{workspace.name}</strong><button onClick={() => { setRenameId(workspace.id); setRename(workspace.name); setError(''); }} aria-label={`重命名工作空间 ${workspace.name}`}><Pencil size={14} /></button><button onClick={() => { setDeleteId(workspace.id); setReplaceId(''); }} aria-label={`删除工作空间 ${workspace.name}`}><Trash2 size={14} /></button></div>
          <p className="subtle">{workspace.tabs.length} 个标签 · {{ single: '单终端', horizontal: '左右分屏', vertical: '上下分屏', grid: '四宫格' }[workspace.layout]}{workspace.layout !== 'single' && ` · ${workspace.splitRatio}%`}{workspace.layout === 'grid' && ` / ${workspace.rowRatio ?? 50}%`}{missing > 0 && ` · ${missing} 个会话已删除，打开时跳过`}</p>
          {renameId === workspace.id && <form className="workspace-rename" onSubmit={e => { e.preventDefault(); const message = validate(rename, workspace.id); setError(message); if (!message) { onChange(data.workspaces.map(w => w.id === workspace.id ? { ...w, name: rename.trim() } : w)); setRenameId(''); } }}><input aria-label="新的工作空间名称" maxLength={80} value={rename} onChange={e => setRename(e.target.value)} /><button type="submit">保存名称</button><button type="button" onClick={() => setRenameId('')}>取消重命名</button></form>}
          {deleteId === workspace.id ? <div className="workspace-entry-actions"><span className="subtle">仅删除布局记录。</span><button className="danger" onClick={() => { onChange(data.workspaces.filter(w => w.id !== workspace.id)); setDeleteId(''); }}>确认删除工作空间</button><button onClick={() => setDeleteId('')}>取消删除</button></div>
          : replaceId === workspace.id ? <div className="workspace-entry-actions"><span className="subtle">用当前标签和布局覆盖？</span><button onClick={() => { onSave(workspace.name, workspace.id); setReplaceId(''); }}>确认更新布局</button><button onClick={() => setReplaceId('')}>取消更新</button></div>
          : <div className="workspace-entry-actions"><button disabled={workspace.tabs.length === missing} onClick={() => onOpen(workspace)}><FolderOpen size={14} />打开 {workspace.name}</button><button disabled={!tabCount} onClick={() => { setReplaceId(workspace.id); setDeleteId(''); }}>更新为当前布局</button></div>}
        </article>;
      })}
    </div>
  </>;
}
