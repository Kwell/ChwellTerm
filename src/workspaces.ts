import type { AppData, Layout, SavedWorkspace, Session, Tab, WorkspaceSnapshot } from './types';
import { gridPanels } from './panels';

export function parseSnapshot(raw: unknown): WorkspaceSnapshot {
  if (!raw || typeof raw !== 'object') throw new Error('工作空间格式无效');
  const v = raw as Record<string, unknown>, ids = new Set<string>();
  if (!Array.isArray(v.tabs) || v.tabs.length > 32 || typeof v.activeTabId !== 'string' ||
      !['single', 'horizontal', 'vertical', 'grid'].includes(String(v.layout)) || typeof v.splitRatio !== 'number' || !Number.isFinite(v.splitRatio) ||
      v.splitRatio < 20 || v.splitRatio > 80 || typeof v.filesOpen !== 'boolean') throw new Error('工作空间布局无效（最多 32 个标签）');
  const tabs = v.tabs.map(rawTab => {
    if (!rawTab || typeof rawTab !== 'object') throw new Error('工作空间标签无效');
    const t = rawTab as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id || t.id.length > 128 || ids.has(t.id) || typeof t.sessionId !== 'string' || !t.sessionId) throw new Error('工作空间标签无效或 ID 重复');
    ids.add(t.id); return { id: t.id, sessionId: t.sessionId };
  });
  if (tabs.length ? !ids.has(v.activeTabId) : v.activeTabId !== '') throw new Error('工作空间活动标签无效');
  if (v.secondaryTabId !== undefined && (typeof v.secondaryTabId !== 'string' || (v.secondaryTabId !== '' && (!ids.has(v.secondaryTabId) || v.secondaryTabId === v.activeTabId)))) throw new Error('工作空间第二面板无效');
  if (v.paneTabIds !== undefined && (!Array.isArray(v.paneTabIds) || v.paneTabIds.length > 4 || v.paneTabIds.some(id => typeof id !== 'string' || !ids.has(id)) || new Set(v.paneTabIds).size !== v.paneTabIds.length)) throw new Error('工作空间面板排列无效（最多 4 个且不可重复）');
  if (v.rowRatio !== undefined && (typeof v.rowRatio !== 'number' || !Number.isFinite(v.rowRatio) || v.rowRatio < 20 || v.rowRatio > 80)) throw new Error('工作空间上下比例无效');
  return { tabs, activeTabId: v.activeTabId, ...(v.secondaryTabId === undefined ? {} : { secondaryTabId: v.secondaryTabId as string }), layout: tabs.length < 2 ? 'single' : v.layout as Layout, splitRatio: v.splitRatio, filesOpen: v.filesOpen, ...(v.paneTabIds === undefined ? {} : { paneTabIds: [...v.paneTabIds as string[]] }), ...(v.rowRatio === undefined ? {} : { rowRatio: v.rowRatio as number }) };
}

export function parseWorkspaces(raw: unknown): SavedWorkspace[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) throw new Error('工作空间列表无效（最多 100 个）');
  const ids = new Set<string>();
  return raw.map(value => {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id || value.id.length > 128 || ids.has(value.id) ||
        typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) throw new Error('工作空间名称或 ID 无效');
    ids.add(value.id); return { id: value.id, name: value.name.trim(), ...parseSnapshot(value) };
  });
}

export function captureWorkspace(tabs: Tab[], active: string, layout: Layout, splitRatio: number, filesOpen: boolean, sessions: Session[], secondary?: string, paneTabIds: string[] = [], rowRatio = 50): WorkspaceSnapshot {
  const sessionIds = new Set(sessions.map(s => s.id));
  const savedTabs = tabs.filter(t => sessionIds.has(t.session.id)).map(t => ({ id: t.id, sessionId: t.session.id }));
  const activeTabId = savedTabs.some(t => t.id === active) ? active : savedTabs[0]?.id || '';
  const secondaryTabId = savedTabs.find(t => t.id === secondary && t.id !== activeTabId)?.id || savedTabs.find(t => t.id !== activeTabId)?.id || '';
  return { tabs: savedTabs, activeTabId, secondaryTabId, layout: savedTabs.length < 2 ? 'single' : layout, splitRatio, filesOpen, ...(layout === 'grid' ? { paneTabIds: gridPanels(savedTabs.map(t => t.id), paneTabIds, activeTabId), rowRatio } : {}) };
}

export function restoreWorkspace(snapshot: WorkspaceSnapshot, sessions: Session[], createId: () => string = () => crypto.randomUUID()) {
  const safe = parseSnapshot(snapshot), byId = new Map(sessions.map(s => [s.id, s])), mapping = new Map<string, string>();
  const tabs: Tab[] = [], missing: string[] = [];
  for (const entry of safe.tabs) {
    const session = byId.get(entry.sessionId);
    if (!session) { missing.push(entry.sessionId); continue; }
    const id = createId(); mapping.set(entry.id, id);
    tabs.push({ id, session: structuredClone(session), status: 'disconnected' });
  }
  const active = mapping.get(safe.activeTabId) || tabs[0]?.id || '';
  const paneTabIds = gridPanels(tabs.map(t => t.id), (safe.paneTabIds || []).map(id => mapping.get(id) || ''), active);
  return { tabs, active, secondary: safe.secondaryTabId ? mapping.get(safe.secondaryTabId) || '' : '', layout: tabs.length < 2 ? 'single' as const : safe.layout, splitRatio: safe.splitRatio, filesOpen: safe.filesOpen, paneTabIds, rowRatio: safe.rowRatio ?? 50, missing };
}

export function mergeWorkspaceConfig(current: AppData, incoming: AppData) {
  const sessionIds = new Set(current.sessions.map(s => s.id)), workspaceIds = new Set(current.workspaces.map(w => w.id));
  const sessions = [...current.sessions, ...incoming.sessions.filter(s => !sessionIds.has(s.id))];
  const names = new Set(current.workspaces.map(w => w.name));
  const added = incoming.workspaces.filter(w => !workspaceIds.has(w.id)).map(w => {
    let name = w.name, suffix = 2; while (names.has(name)) name = `${w.name} (${suffix++})`;
    names.add(name); return { ...w, name };
  });
  if (current.workspaces.length + added.length > 100) throw new Error('合并后工作空间超过 100 个');
  return { ...current, sessions, workspaces: [...current.workspaces, ...added] };
}
