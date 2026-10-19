import { describe, expect, it } from 'vitest';
import { exportConfig, parseAppData } from './config';
import { captureWorkspace, mergeWorkspaceConfig, parseSnapshot, restoreWorkspace } from './workspaces';
import { defaultData, type Tab, type WorkspaceSnapshot } from './types';

const snapshot: WorkspaceSnapshot = { tabs: [{ id: 'a', sessionId: 'local' }, { id: 'b', sessionId: 'local' }], activeTabId: 'b', secondaryTabId: 'a', layout: 'vertical', splitRatio: 35, filesOpen: false };
describe('workspace restoration and persistence', () => {
  it('loads old configuration with restoration disabled and no named layouts', () => {
    const old = JSON.parse(JSON.stringify(defaultData)); delete old.workspaces; delete old.settings.restoreWorkspace;
    expect(parseAppData(old)).toEqual(defaultData);
  });
  it('captures repeated sessions in order, with no credentials, transcript or commands', () => {
    const tabs: Tab[] = ['a', 'b'].map(id => ({ id, session: { ...defaultData.sessions[0] }, status: 'connected' }));
    Object.assign(tabs[0], { password: 'tab-secret', transcript: 'private-command' });
    const captured = captureWorkspace(tabs, 'b', 'vertical', 35, false, defaultData.sessions);
    expect(captured).toEqual(snapshot); expect(JSON.stringify(captured)).not.toMatch(/tab-secret|private-command/);
    const raw = { ...defaultData, workspaces: [{ id: 'daily', name: '日常', ...captured, responses: ['otp-secret'] }], lastWorkspace: captured };
    Object.assign(raw.workspaces[0].tabs[0], { session: { password: 'private-password' } });
    const exported = exportConfig(raw); expect(exported).not.toMatch(/otp-secret|private-password/);
    expect(parseAppData(JSON.parse(exported)).lastWorkspace).toEqual(snapshot);
  });
  it('restores as disconnected with fresh tab IDs and latest session settings', () => {
    let sequence = 0;
    const sessions = [{ ...defaultData.sessions[0], name: '最新名称' }];
    const restored = restoreWorkspace(snapshot, sessions, () => `new-${++sequence}`);
    expect(restored.tabs.map(t => [t.id, t.session.name, t.status])).toEqual([['new-1', '最新名称', 'disconnected'], ['new-2', '最新名称', 'disconnected']]);
    expect(restored.active).toBe('new-2'); expect(restored.layout).toBe('vertical'); expect(restored.filesOpen).toBe(false);
    restored.tabs[0].session.name = 'changed'; expect(sessions[0].name).toBe('最新名称');
  });
  it('skips deleted sessions and falls back to the first surviving tab and single layout', () => {
    const saved = { ...snapshot, tabs: [{ id: 'a', sessionId: 'deleted' }, { id: 'b', sessionId: 'local' }], activeTabId: 'a', secondaryTabId: 'b' };
    const restored = restoreWorkspace(saved, defaultData.sessions, () => 'new');
    expect(restored.missing).toEqual(['deleted']); expect(restored.active).toBe('new'); expect(restored.layout).toBe('single');
    expect(restoreWorkspace(saved, []).tabs).toEqual([]);
  });
  it('rejects malformed, oversized and duplicate layout data', () => {
    for (const invalid of [{ ...snapshot, splitRatio: NaN }, { ...snapshot, splitRatio: 81 }, { ...snapshot, activeTabId: 'absent' }, { ...snapshot, tabs: [snapshot.tabs[0], snapshot.tabs[0]] }, { ...snapshot, tabs: Array.from({ length: 33 }, (_, i) => ({ id: String(i), sessionId: 'local' })) }]) expect(() => parseSnapshot(invalid)).toThrow('工作空间');
    expect(() => parseAppData({ ...defaultData, workspaces: [{ id: 'bad', name: '', ...snapshot }] })).toThrow('工作空间');
    expect(() => parseAppData({ ...defaultData, workspaces: Array.from({ length: 101 }, (_, i) => ({ id: String(i), name: String(i), ...snapshot })) })).toThrow('100');
  });
  it('merges named workspaces without replacing local settings or existing records', () => {
    const current = { ...structuredClone(defaultData), workspaces: [{ id: 'first', name: 'daily', ...snapshot }] };
    const incoming = { ...structuredClone(defaultData), workspaces: [{ id: 'first', name: 'replacement', ...snapshot }, { id: 'second', name: 'daily', ...snapshot }], settings: { ...defaultData.settings, theme: 'light' as const } };
    const merged = mergeWorkspaceConfig(current, incoming);
    expect(merged.workspaces.map(w => w.name)).toEqual(['daily', 'daily (2)']); expect(merged.settings.theme).toBe('dark'); expect(merged.sessions).toHaveLength(1);
  });
  it('captures and restores all grid slots with fresh IDs, ratios and manual authentication', () => {
    const tabs: Tab[] = ['a','b','c','d','e'].map(id => ({id, session: defaultData.sessions[0], status:'connected'}));
    const saved = captureWorkspace(tabs,'c','grid',35,false,defaultData.sessions,'b',['e','c','b','d'],65);
    expect(saved.paneTabIds).toEqual(['e','c','b','d']); expect(saved.rowRatio).toBe(65);
    const config = parseAppData(JSON.parse(exportConfig({...defaultData, workspaces:[{id:'grid',name:'四宫格',...saved}]})));
    let sequence=0; const restored=restoreWorkspace(config.workspaces[0],defaultData.sessions,()=>`new-${++sequence}`);
    expect(restored.paneTabIds).toEqual(['new-5','new-3','new-2','new-4']); expect(restored.active).toBe('new-3');
    expect(restored.layout).toBe('grid'); expect(restored.rowRatio).toBe(65); expect(restored.splitRatio).toBe(35);
    expect(restored.tabs.every(tab=>tab.status==='disconnected')).toBe(true);
  });
  it('rejects duplicate, unknown and oversized panel lists and invalid row ratios', () => {
    for(const patch of [{paneTabIds:['a','a']},{paneTabIds:['unknown']},{paneTabIds:['a','b','a','b','a']},{paneTabIds:'a'},{rowRatio:19},{rowRatio:81},{rowRatio:NaN},{rowRatio:'50'}]) expect(()=>parseSnapshot({...snapshot,layout:'grid',...patch})).toThrow('工作空间');
  });
  it('fills missing grid slots and defaults old grid ratios without restoring credentials', () => {
    const saved={...snapshot,layout:'grid' as const,paneTabIds:['a','b'],tabs:[{id:'a',sessionId:'deleted'},{id:'b',sessionId:'local'},{id:'c',sessionId:'local'}]};
    let i=0;const restored=restoreWorkspace(saved,defaultData.sessions,()=>`new-${++i}`);
    expect(restored.paneTabIds).toEqual(['new-1','new-2']); expect(restored.layout).toBe('grid'); expect(restored.rowRatio).toBe(50);
    expect(restored.missing).toEqual(['deleted']);
  });
});
