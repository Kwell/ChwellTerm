import { useEffect, useRef, useState } from 'react';
import { Server, Terminal as TerminalIcon, Plus, Search, Settings as SettingsIcon, FolderOpen, Folder, FileText, Code, X, Upload, Download, RefreshCw, Columns2, PanelRight, ShieldCheck, LockKeyhole, Pencil, Trash2, ChevronDown, Laptop, Check, Radio, Copy, PanelsTopLeft, LayoutGrid } from 'lucide-react';
import { ConnectionFields, CredentialFields } from './ConnectionFields';
import { SshImportDialog } from './SshImportDialog';
import { mergeSshSessions } from './sshConfig';
import { WorkspaceDialog } from './WorkspaceDialog';
import { captureWorkspace, restoreWorkspace, mergeWorkspaceConfig } from './workspaces';
import { SplitHandle } from './SplitHandle';
import { TransferStatus } from './TransferStatus';
import { TransferQueue, type TransferJob } from './transferQueue';
import { TerminalPane, type TerminalController } from './TerminalPane';
import { Dialog } from './Dialog';
import { RemoteEditor, type EditorTarget } from './RemoteEditor';
import { gridPanels, activatePanel, assignPanel } from './panels';
import * as api from './bridge';
import { exportConfig, parseAppData, remotePath, validateSession } from './config';
import { defaultData, type AppData, type Credentials, type Session, type Tab, type TerminalEvent, type RemoteFile, type SavedWorkspace, type WorkspaceSnapshot, type Layout } from './types';

type Modal = 'session' | 'credentials' | 'settings' | 'snippets' | 'import' | 'search' | 'log' | 'paste' | 'broadcast' | 'delete' | 'sshImport' | 'diagnostics' | 'workspaces' | null;
const emptyCredentials = (): Credentials => ({ password: '', passphrase: '', remember: false });
const environmentNames = { production: '生产环境', development: '开发 / 测试', personal: '个人 / 本机' };
const uid = () => crypto.randomUUID();
const newSession = (): Session => ({ id: uid(), name: '', host: '', port: 22, username: '', environment: 'development', auth: 'password', keyPath: '', kind: 'ssh' });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function App() {
  const [data, setData] = useState<AppData>(structuredClone(defaultData));
  const [loaded, setLoaded] = useState(false), [tabs, setTabs] = useState<Tab[]>([]), [active, setActive] = useState('');
  const [modal, setModal] = useState<Modal>(null), [draft, setDraft] = useState<Session>(newSession), [credentials, setCredentials] = useState<Credentials>(emptyCredentials);
  const [diagnostics, setDiagnostics] = useState<Record<string, { time: string; text: string }[]>>({});
  const [authChallenges, setAuthChallenges] = useState<(TerminalEvent & { tabId: string })[]>([]);
  const [query, setQuery] = useState(''), [filesOpen, setFilesOpen] = useState(true), [layout, setLayout] = useState<Layout>('single');
  const [paneIds, setPaneIds] = useState<string[]>([]), [rowRatio, setRowRatio] = useState(50);
  const [secondary, setSecondary] = useState('');
  const [splitRatio, setSplitRatio] = useState(50);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<Session['environment'], boolean>>({ production: false, development: false, personal: false });
  const [message, setMessage] = useState(''), [formError, setFormError] = useState(''), [fingerprints, setFingerprints] = useState<(TerminalEvent & { tabId: string })[]>([]);
  const [path, setPath] = useState('/'), [files, setFiles] = useState<RemoteFile[]>([]), [filesBusy, setFilesBusy] = useState(false), [fileError, setFileError] = useState('');
  const [configText, setConfigText] = useState(''), [search, setSearch] = useState(''), [paste, setPaste] = useState({ id: '', text: '' });
  const [snippetDraft, setSnippetDraft] = useState({ name: '', command: '' }), [broadcast, setBroadcast] = useState<string[]>([]), [broadcastSelection, setBroadcastSelection] = useState<string[]>([]);
  const [transfers, setTransfers] = useState<TransferJob[]>([]), [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [pickingTransfer, setPickingTransfer] = useState(false), pickingRef = useRef(false);
  const selectedFile = selectedFiles.length === 1 ? selectedFiles[0] : null;
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const terminalRefs = useRef(new Map<string, TerminalController>()), pendingCredentials = useRef(new Map<string, Credentials>());
  const latestData = useRef(data); latestData.current = data;
  const lastCapturedWorkspace = useRef<string | null>(null);
  const latestTabs = useRef(tabs); latestTabs.current = tabs;
  const latestActive = useRef(active); latestActive.current = active;
  const latestPath = useRef(path); latestPath.current = path;
  const activeTab = tabs.find(t => t.id === active), fingerprint = fingerprints[0], authChallenge = authChallenges[0];
  const credentialsTarget = useRef<{ session: Session; tabId?: string } | null>(null);
  const saveQueue = useRef(Promise.resolve()), fileGeneration = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const refreshRef = useRef(refreshFiles); refreshRef.current = refreshFiles;
  const queueRef = useRef<TransferQueue | null>(null);
  if (!queueRef.current) queueRef.current = new TransferQueue(
    (job, progress) => job.direction === 'upload'
      ? api.uploadRemote(job.tabId, job.id, job.localPath, job.remotePath, progress)
      : api.downloadRemote(job.tabId, job.id, job.localPath, job.remotePath, job.batch, progress),
    api.cancelTransfer, setTransfers,
    job => { if (job.direction === 'upload' && latestActive.current === job.tabId && latestPath.current === job.remotePath) void refreshRef.current(); },
    text => notify(text),
    api.pauseTransfer,
  );
  const queue = queueRef.current;
  function notify(text: string) { setMessage(text); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setMessage(''), 5000); }
  function updateData(next: AppData) {
    latestData.current = next; setData(next);
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => api.saveData(next)).catch(error => notify('保存失败：' + errorText(error)));
  }
  useEffect(() => {
    let live = true;
    api.loadData().then(loadedData => { if (live) { latestData.current = loadedData; setData(loadedData);
      if (loadedData.settings.restoreWorkspace && loadedData.lastWorkspace) {
        const restored = restoreWorkspace(loadedData.lastWorkspace, loadedData.sessions);
        setTabs(restored.tabs); setActive(restored.active); setSecondary(restored.secondary || restored.tabs.find(t => t.id !== restored.active)?.id || ''); setLayout(restored.layout); setPaneIds(restored.paneTabIds); setRowRatio(restored.rowRatio); setSplitRatio(restored.splitRatio); setFilesOpen(restored.filesOpen);
        if (restored.tabs.length) notify(`已恢复 ${restored.tabs.length} 个待连接标签，请逐个连接${restored.missing.length ? `；跳过 ${restored.missing.length} 个已删除会话` : ''}`);
      }
      setLoaded(true); } }).catch(error => { if (live) { notify('配置读取失败：' + errorText(error)); setLoaded(true); } });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const snapshot = captureWorkspace(tabs, active, layout, splitRatio, filesOpen, latestData.current.sessions, secondary, paneIds, rowRatio);
    const signature = JSON.stringify(snapshot);
    if (lastCapturedWorkspace.current === null) { lastCapturedWorkspace.current = signature; return; }
    if (lastCapturedWorkspace.current === signature) return;
    lastCapturedWorkspace.current = signature;
    updateData({ ...latestData.current, lastWorkspace: snapshot });
  }, [loaded, tabs, active, secondary, layout, splitRatio, filesOpen, paneIds, rowRatio]);
  useEffect(() => {
    document.documentElement.dataset.theme = data.settings.theme;
    if (loaded) void api.setWindowTheme(data.settings.theme).catch(error => notify('窗口主题更新失败：' + errorText(error)));
  }, [data.settings.theme, loaded]);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (fingerprint || authChallenge || editor) return;
      if (e.key === 'Escape') { if (!fingerprint) closeModal(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setModal('search'); setFormError(''); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.querySelector<HTMLInputElement>('.session-search input')?.focus(); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [fingerprint, authChallenge, editor]);
  useEffect(() => {
    setFiles([]); setFilesBusy(false); setSelectedFiles([]); setPath('/'); setFileError(''); ++fileGeneration.current;
  }, [active]);
  useEffect(() => { setSelectedFiles([]); setFiles([]); setFileError(''); ++fileGeneration.current; }, [active, path]);
  useEffect(() => { if (activeTab?.status === 'connected' && activeTab.session.kind === 'ssh' && filesOpen) void refreshFiles(); }, [active, activeTab?.status, filesOpen, path]);
  function closeModal() { setModal(null); setFormError(''); setCredentials(emptyCredentials()); }
  function editSession(s?: Session) { setDraft(s ? { ...s } : newSession()); setFormError(''); setModal('session'); }
  function requestConnection(session: Session, tabId?: string) {
    if (!api.desktop) { notify('浏览器仅供界面预览，请使用桌面版本连接真实终端'); return; }
    if (session.kind === 'local' || (['agent', 'keyboard-interactive'].includes(session.auth) && (!session.jump || ['agent', 'keyboard-interactive'].includes(session.jump.auth)))) { if (tabId) void connectTab(tabId, session, emptyCredentials()); else openTab(session, emptyCredentials()); return; }
    credentialsTarget.current = { session, tabId }; setCredentials(emptyCredentials()); setFormError(''); setModal('credentials');
  }
  function openTab(session: Session, secret: Credentials) {
    if (latestTabs.current.length >= 32) { notify('最多打开 32 个终端标签'); return; }
    const id = uid(); pendingCredentials.current.set(id, secret); setTabs(prev => [...prev, { id, session: { ...session }, status: 'idle' }]); activateTab(id);
  }
  async function connectTab(id: string, session: Session, secret: Credentials) {
    const controller = terminalRefs.current.get(id); if (!controller) { pendingCredentials.current.set(id, secret); return; }
    setDiagnostics(prev => ({ ...prev, [id]: [] }));
    setTabs(prev => prev.map(t => t.id === id ? { ...t, session: structuredClone(session), status: 'connecting', error: undefined } : t));
    const { cols, rows } = controller.size();
    try {
      await api.connectTerminal(id, session, secret, cols, rows, event => {
        if (event.type === 'diagnostic' || event.type === 'error' || event.type === 'closed') {
          setDiagnostics(prev => ({ ...prev, [id]: [...(prev[id] || []), { time: new Date().toLocaleTimeString(), text: event.data || '连接已结束' }].slice(-100) }));
          if (event.type === 'diagnostic') return;
        }
        if (event.type === 'auth-challenge') { if (latestTabs.current.some(t => t.id === id)) setAuthChallenges(prev => [...prev, { ...event, tabId: id }]); return; }
        if (event.type === 'fingerprint') { setFingerprints(prev => [...prev, { ...event, tabId: id }]); return; }
        terminalRefs.current.get(id)?.write(event);
        if (event.type === 'connected') {
          queue.allowTab(id);
          setTabs(prev => prev.map(t => t.id === id ? { ...t, status: 'connected' } : t));
          const size = terminalRefs.current.get(id)?.size(); if (size) void api.terminalResize(id, size.cols, size.rows).catch(() => {});
        }
        if (event.type === 'closed' || event.type === 'error') {
          queue.stopTab(id, true);
          setTabs(prev => prev.map(t => t.id === id ? { ...t, status: event.type === 'error' ? 'error' : 'disconnected', error: event.type === 'error' ? event.data : undefined } : t));
          setFingerprints(prev => prev.filter(f => f.tabId !== id)); setAuthChallenges(prev => prev.filter(f => f.tabId !== id));
        }
      });
    } catch (error) { setDiagnostics(prev => ({ ...prev, [id]: [...(prev[id] || []), { time: new Date().toLocaleTimeString(), text: errorText(error) }] })); setTabs(prev => prev.map(t => t.id === id ? { ...t, status: 'error', error: errorText(error) } : t)); notify(errorText(error)); }
  }
  function onReady(id: string, controller: TerminalController) {
    terminalRefs.current.set(id, controller); const tab = latestTabs.current.find(t => t.id === id);
    const secret = pendingCredentials.current.get(id); pendingCredentials.current.delete(id);
    if (tab && secret) void connectTab(id, tab.session, secret);
  }
  function onInput(id: string, input: string) {
    const targets = broadcast.includes(id) ? broadcast : [id];
    targets.forEach(target => { if (latestTabs.current.find(t => t.id === target)?.status === 'connected') void api.terminalInput(target, input).catch(error => notify(errorText(error))); });
  }
  function resizeTerminal(id: string, cols: number, rows: number) {
    const previous = resizeTimers.current.get(id); if (previous) clearTimeout(previous);
    resizeTimers.current.set(id, setTimeout(() => { resizeTimers.current.delete(id); if (latestTabs.current.find(t => t.id === id)?.status === 'connected') void api.terminalResize(id, cols, rows).catch(() => {}); }, 50));
  }
  async function closeTab(id: string) {
    if (!await queue.discardTab(id)) {
      if (latestTabs.current.find(t => t.id === id)?.status === 'connected') queue.allowTab(id);
      notify('上传临时文件尚未清理，已保留原标签；请重连后再次取消传输，再关闭标签'); return false;
    }
    try { if (api.desktop) await disconnectTab(id); } catch (error) { notify(errorText(error)); }
    setDiagnostics(prev => { const next = { ...prev }; delete next[id]; return next; });
    pendingCredentials.current.delete(id); setFingerprints(prev => prev.filter(f => f.tabId !== id)); setAuthChallenges(prev => prev.filter(f => f.tabId !== id)); setBroadcast(prev => prev.filter(t => t !== id));
    const next = latestTabs.current.filter(t => t.id !== id);
    const survivingPanes = gridPanels(next.map(t => t.id), paneIds.filter(p => p !== id), next.find(t => t.id === active)?.id || '');
    setPaneIds(survivingPanes); setTabs(next);
    if (active === id) setActive((layout === 'grid' ? survivingPanes[0] : next[0]?.id) || '');
    if (next.length < 2) setLayout('single');
    return true;
  }
  async function disconnectTab(id: string) {
    queue.stopTab(id, true);
    await api.terminalClose(id);
  }
  function saveSession(connect: boolean) {
    const error = validateSession(draft); if (error) { setFormError(error); return; }
    const s = { ...draft, name: draft.name.trim(), host: draft.host.trim(), username: draft.username.trim() };
    const next = [...data.sessions.filter(x => x.id !== s.id), s]; updateData({ ...data, sessions: next }); closeModal(); if (connect) requestConnection(s);
  }
  async function refreshFiles() {
    if (!activeTab || activeTab.status !== 'connected' || activeTab.session.kind !== 'ssh') return;
    const generation = ++fileGeneration.current; setFilesBusy(true); setFileError('');
    try { const entries = await api.listRemote(activeTab.id, path); if (generation === fileGeneration.current) { setFiles(entries); setSelectedFiles(previous => previous.filter(name => entries.some(f => !f.isDir && f.name === name))); } }
    catch (error) { if (generation === fileGeneration.current) setFileError(errorText(error)); }
    finally { if (generation === fileGeneration.current) setFilesBusy(false); }
  }
  function editRemoteFile(name: string) {
    if (!activeTab || activeTab.status !== 'connected' || activeTab.session.kind !== 'ssh') return;
    setEditor({ tabId: activeTab.id, sessionName: activeTab.session.name, path: remotePath(path, name) });
  }
  async function transferFile(direction: 'upload' | 'download') {
    if (!activeTab || activeTab.status !== 'connected' || activeTab.session.kind !== 'ssh' || pickingRef.current) return;
    const targetTab = activeTab.id, targetPath = path, sessionName = activeTab.session.name;
    const epoch = queue.epoch(targetTab), chosen = files.filter(f => !f.isDir && selectedFiles.includes(f.name)).map(f => f.name);
    if (direction === 'download' && !chosen.length) { notify('先选择文件'); return; }
    pickingRef.current = true; setPickingTransfer(true);
    try {
      const common = { tabId: targetTab, sessionName, direction };
      if (direction === 'upload') {
        const paths = await api.pickUploads(); if (!paths.length) return;
        if (!queue.available(targetTab, epoch) || latestTabs.current.find(t => t.id === targetTab)?.status !== 'connected') throw Error('选择文件期间源会话已断开，请重新选择');
        queue.enqueue([...new Set(paths)].map(localPath => ({ ...common, id: uid(), name: localPath.split(/[\\/]/).pop() || localPath, localPath, remotePath: targetPath, batch: false })));
      } else {
        const batch = chosen.length > 1;
        const destination = batch ? await api.pickDownloadDirectory() : await api.pickDownloadPath(chosen[0]);
        if (typeof destination !== 'string') return;
        if (!queue.available(targetTab, epoch) || latestTabs.current.find(t => t.id === targetTab)?.status !== 'connected') throw Error('选择目录期间源会话已断开，请重新选择');
        queue.enqueue(chosen.map(name => ({ ...common, id: uid(), name, localPath: destination, remotePath: remotePath(targetPath, name), batch })));
      }
    } catch (error) { notify(errorText(error)); }
    finally { pickingRef.current = false; setPickingTransfer(false); }
  }
  async function fingerprintDecision(accept: boolean) {
    if (!fingerprint?.requestId) return;
    try { await api.trustHost(fingerprint.requestId, accept); } catch (error) { notify(errorText(error)); }
    setFingerprints(prev => prev.slice(1));
  }
  async function deleteSession() {
    for (const t of tabs.filter(t => t.session.id === draft.id)) if (!await closeTab(t.id)) return;
    if (api.desktop) await api.forgetCredential(draft.id).catch(() => {});
    if (api.desktop) await api.forgetCredential(draft.id + ':jump').catch(() => {});
    updateData({ ...data, sessions: data.sessions.filter(s => s.id !== draft.id) }); closeModal();
  }
  function splitTerminal(nextLayout: typeof layout) {
    if (nextLayout !== 'single' && tabs.length < 2) { notify('先打开至少两个终端，再进行分屏'); return; }
    if (nextLayout === 'grid') setPaneIds(gridPanels(tabs.map(t => t.id), paneIds.length ? paneIds : [active, secondary], active));
    setLayout(nextLayout);
  }
  function activateTab(id: string) {
    if (layout === 'grid') setPaneIds(previous => activatePanel(gridPanels(latestTabs.current.map(t => t.id), previous, active), active, id));
    setActive(id);
  }
  function choosePanel(index: number, id: string) { setPaneIds(assignPanel(gridIds, index, id)); setActive(id); }
  function saveWorkspace(name: string, replaceId?: string) {
    const snapshot = captureWorkspace(tabs, active, layout, splitRatio, filesOpen, data.sessions, secondary, paneIds, rowRatio);
    if (!snapshot.tabs.length) { notify('先打开终端标签，再保存工作空间'); return; }
    const workspace: SavedWorkspace = { id: replaceId || uid(), name, ...snapshot };
    updateData({ ...data, workspaces: replaceId ? data.workspaces.map(w => w.id === replaceId ? workspace : w) : [...data.workspaces, workspace] });
    notify(replaceId ? '工作空间布局已更新' : '工作空间已保存');
  }
  function openWorkspace(snapshot: WorkspaceSnapshot) {
    const restored = restoreWorkspace(snapshot, data.sessions);
    if (!restored.tabs.length) { notify('没有可恢复的会话，请先添加会话'); return; }
    if (tabs.length + restored.tabs.length > 32) { notify('恢复后超过 32 个标签，请先关闭一些终端'); return; }
    setTabs(previous => [...previous, ...restored.tabs]); setActive(restored.active); setSecondary(restored.secondary || restored.tabs.find(t => t.id !== restored.active)?.id || ''); setLayout(restored.layout); setPaneIds(restored.paneTabIds); setRowRatio(restored.rowRatio); setSplitRatio(restored.splitRatio); setFilesOpen(restored.filesOpen);
    closeModal(); notify(`已打开 ${restored.tabs.length} 个待连接标签${restored.missing.length ? `；跳过 ${restored.missing.length} 个已删除会话` : ''}`);
  }
  const secondId = tabs.find(t => t.id === secondary && t.id !== active)?.id || tabs.find(t => t.id !== active)?.id;
  const gridIds = gridPanels(tabs.map(t => t.id), paneIds, active);
  const visible = new Set(layout === 'grid' ? gridIds : [active, ...(layout !== 'single' && secondId ? [secondId] : [])]);
  return <div className="app-shell">
    <div className={`workspace ${filesOpen ? '' : 'files-hidden'}`}>
      <aside className="sidebar">
        <div className="sidebar-heading"><strong>会话</strong><button onClick={() => editSession()} aria-label="新建连接"><Plus size={18} /></button></div>
        <label className="session-search"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索会话…" aria-label="搜索会话" /><kbd>⌘ / Ctrl K</kbd></label>
        {(['production', 'development', 'personal'] as const).map(environment => <section className="session-group" key={environment}>
          <button type="button" className="group-heading" aria-expanded={!collapsedGroups[environment]} aria-controls={`session-group-${environment}`} onClick={() => setCollapsedGroups(previous => ({ ...previous, [environment]: !previous[environment] }))}><ChevronDown size={13} />{environmentNames[environment]}<span>{data.sessions.filter(s => s.environment === environment).length}</span></button>
          <div id={`session-group-${environment}`} hidden={collapsedGroups[environment]}>
          {data.sessions.filter(s => s.environment === environment && (s.name + s.host).toLowerCase().includes(query.toLowerCase())).map(s => <div className={`session-row ${activeTab?.session.id === s.id ? 'selected' : ''}`} key={s.id}>
            <button className="session-open" onClick={() => requestConnection(s)}>{s.kind === 'local' ? <Laptop size={17} /> : <Server size={17} />}<span><span>{s.name}</span><small>{s.kind === 'local' ? '系统默认 shell' : `${s.host}:${s.port}`}</small></span><i className={`status-dot ${tabs.some(t => t.session.id === s.id && t.status === 'connected') ? '' : 'offline'}`} /></button>
            {s.kind === 'ssh' && <button className="session-edit" onClick={() => editSession(s)} aria-label={`编辑 ${s.name}`}><Pencil size={12} /></button>}
          </div>)}
          </div>
        </section>)}
        {!loaded && <p className="subtle">正在读取配置…</p>}
        <div className="sidebar-bottom"><button onClick={() => setModal('workspaces')}><PanelsTopLeft size={17} />工作空间<span>{data.workspaces.length}</span></button><button onClick={() => { setFormError(''); setModal('snippets'); }}><Code size={17} />命令片段<span>{data.snippets.length}</span></button><button onClick={() => { setConfigText(exportConfig(data)); setFormError(''); setModal('import'); }}><Upload size={17} />导入 / 导出</button><button onClick={() => setModal('settings')}><SettingsIcon size={17} />设置</button></div>
      </aside>
      <main className="main-area">
        <div className="tabs-bar"><div className="tabs" role="tablist" aria-label="终端标签">{tabs.map(t => <div className={`tab ${t.id === active ? 'active' : ''}`} key={t.id}><button role="tab" aria-selected={t.id === active} onClick={() => activateTab(t.id)}><span className={`status-dot ${t.status === 'connected' ? '' : 'offline'}`} />{t.session.name}{t.status === 'connecting' && <small>连接中</small>}</button><button onClick={() => void closeTab(t.id)} aria-label={`关闭 ${t.session.name}`}><X size={13} /></button></div>)}</div><div className="tab-tools"><button onClick={() => setModal('workspaces')} aria-label="管理工作空间"><PanelsTopLeft size={16} /></button><button disabled={!activeTab} onClick={() => { if (activeTab) requestConnection(data.sessions.find(s => s.id === activeTab.session.id) || activeTab.session); }} aria-label="复制连接"><Copy size={16} /></button><button onClick={() => setModal('search')} aria-label="查找终端"><Search size={16} /></button><button onClick={() => { setBroadcastSelection(tabs.filter(t => t.status === 'connected').map(t => t.id)); setModal('broadcast'); }} aria-label="多会话广播"><Radio size={16} /></button><button onClick={() => splitTerminal(layout === 'single' ? 'horizontal' : layout === 'horizontal' ? 'vertical' : 'single')} aria-label="切换分屏"><Columns2 size={16} /></button><button aria-label="四宫格布局" aria-pressed={layout === 'grid'} onClick={() => splitTerminal(layout === 'grid' ? 'single' : 'grid')}><LayoutGrid size={16} /></button><button onClick={() => setFilesOpen(!filesOpen)} aria-label="显示或隐藏文件面板"><PanelRight size={16} /></button></div></div>
        {activeTab && <div className="connection-bar"><span className={`env-badge ${activeTab.session.environment}`}>{environmentNames[activeTab.session.environment]}</span><LockKeyhole size={13} /><span>{activeTab.session.kind === 'local' ? '本地终端' : `${activeTab.session.username}@${activeTab.session.host}:${activeTab.session.port}`}</span><div className="connection-actions"><button onClick={() => setModal('diagnostics')}>连接诊断</button><span>{activeTab.status === 'connected' ? '已连接' : activeTab.status === 'connecting' ? '正在连接…' : '已断开'}</span>{['error', 'disconnected'].includes(activeTab.status) && activeTab.session.kind === 'ssh' && <button onClick={() => editSession(data.sessions.find(s => s.id === activeTab.session.id) || activeTab.session)}>编辑连接</button>}{['error', 'disconnected'].includes(activeTab.status) && <button onClick={() => requestConnection(data.sessions.find(s => s.id === activeTab.session.id) || activeTab.session, activeTab.id)}>重新连接</button>}{activeTab.status === 'connecting' && <button onClick={() => void disconnectTab(activeTab.id).catch(e => notify(errorText(e)))}>取消连接</button>}{activeTab.status === 'connected' && <button onClick={() => void disconnectTab(activeTab.id).catch(e => notify(errorText(e)))}>断开</button>}</div></div>}
        {broadcast.length > 0 && <div className="broadcast-banner"><Radio size={14} />广播模式：{tabs.filter(t => broadcast.includes(t.id)).map(t => t.session.name).join('、')}<button onClick={() => setBroadcast([])}>停止广播</button></div>}
        <div className={`terminals ${layout}`} style={layout === 'grid' ? { gridTemplateColumns: `${splitRatio}fr 7px ${100-splitRatio}fr`, gridTemplateRows: `${rowRatio}fr 7px ${100-rowRatio}fr` } : undefined}>
          {tabs.map(t => <section className={`terminal-pane ${visible.has(t.id) ? 'visible' : ''}`} key={t.id} data-tab-id={t.id} onPointerDown={layout === 'grid' ? () => { if (t.id !== active) activateTab(t.id); } : undefined} onFocusCapture={layout === 'grid' ? () => { if (t.id !== active) activateTab(t.id); } : undefined} style={layout === 'grid' ? { order: gridIds.indexOf(t.id), gridColumn: gridIds.indexOf(t.id) % 2 * 2 + 1, gridRow: Math.floor(gridIds.indexOf(t.id) / 2) * 2 + 1 } : layout !== 'single' ? { order: t.id === active ? 0 : 2, flex: t.id === active ? `0 0 calc((100% - 7px) * ${splitRatio / 100})` : '1 1 0' } : undefined}>
            {layout !== 'single' && visible.has(t.id) && <div className={`pane-label ${t.id === active ? 'pane-active' : ''}`}><TerminalIcon size={13} />{layout === 'grid' ? <select aria-label={`面板 ${gridIds.indexOf(t.id) + 1} 的终端`} value={t.id} onChange={e => choosePanel(gridIds.indexOf(t.id), e.target.value)}>{tabs.map((tab, index) => <option value={tab.id} key={tab.id}>{index + 1}. {tab.session.name}</option>)}</select> : t.session.name}<button onClick={() => activateTab(t.id)}>{layout === 'grid' ? t.id === active ? '当前' : '聚焦' : '设为主终端'}</button></div>}
            {t.status === 'disconnected' && !diagnostics[t.id]?.length && <div className="restored-terminal"><PanelsTopLeft size={28} /><strong>{t.session.name}</strong><p>工作空间已恢复，连接后开始使用。</p><button className="primary" onClick={() => requestConnection(data.sessions.find(s => s.id === t.session.id) || t.session, t.id)}>连接 {t.session.name}</button></div>}
            <TerminalPane id={t.id} active={t.id === active} settings={data.settings} onReady={onReady} onDispose={id => terminalRefs.current.delete(id)} onInput={onInput} onResize={resizeTerminal} onPaste={(id, text) => { setPaste({ id, text }); setModal('paste'); }} />
          </section>)}
          {(layout === 'horizontal' || layout === 'vertical') && secondId && <SplitHandle layout={layout} ratio={splitRatio} onChange={setSplitRatio} />}
          {layout === 'grid' && <><SplitHandle grid layout="horizontal" ratio={splitRatio} onChange={setSplitRatio} /><SplitHandle grid layout="vertical" ratio={rowRatio} onChange={setRowRatio} />{Array.from({ length: 4 - gridIds.length }, (_, n) => { const index = gridIds.length + n; return <div className="grid-empty" key={`empty-${index}`} style={{order: index, gridColumn: index % 2 * 2 + 1, gridRow: Math.floor(index / 2) * 2 + 1}}><LayoutGrid size={24} /><span>面板 {index + 1}</span><button disabled={!activeTab || tabs.length >= 32} onClick={() => { if (activeTab) requestConnection(data.sessions.find(s => s.id === activeTab.session.id) || activeTab.session); }}>复制当前连接</button></div>; })}</>}
          {tabs.length === 0 && <div className="empty-state"><TerminalIcon size={44} strokeWidth={1.2} /><h1>你的服务器工作台</h1><p>连接远程服务器，或打开本地终端开始工作。</p><div><button className="primary" onClick={() => editSession()}><Plus size={16} />新建 SSH 连接</button><button onClick={() => requestConnection(data.sessions.find(s => s.kind === 'local') || defaultData.sessions[0])}><TerminalIcon size={16} />本地终端</button></div>{!api.desktop && <small>当前是浏览器界面预览；真实连接请启动桌面版。</small>}</div>}
        </div>
        <div className="commandbar"><Code size={14} /><span>常用命令</span>{data.snippets.slice(0, 3).map((s, i) => <button key={i} disabled={!activeTab || activeTab.status !== 'connected'} onClick={() => { terminalRefs.current.get(active)?.paste(s.command); terminalRefs.current.get(active)?.focus(); }}>{s.command}</button>)}<button className="log-button" onClick={() => setModal('log')} disabled={!activeTab}>会话日志</button></div>
      </main>
      {filesOpen && <aside className="files-panel"><div className="files-heading"><FolderOpen size={17} /><strong>文件</strong><button onClick={() => setFilesOpen(false)} aria-label="关闭文件面板"><PanelRight size={16} /></button></div><form className="pathbar" onSubmit={e => { e.preventDefault(); void refreshFiles(); }}><button type="button" onClick={() => setPath(remotePath(path, '..'))} aria-label="上级目录">↑</button><input value={path} onChange={e => setPath(e.target.value)} aria-label="远程目录" /></form><div className="file-toolbar"><button disabled={pickingTransfer || activeTab?.status !== 'connected' || activeTab.session.kind !== 'ssh'} onClick={() => void transferFile('upload')}><Upload size={14} />上传</button><button disabled={pickingTransfer || !selectedFiles.length || activeTab?.status !== 'connected'} onClick={() => void transferFile('download')}><Download size={14} />下载</button><button disabled={!selectedFile || activeTab?.status !== 'connected' || activeTab.session.kind !== 'ssh'} onClick={() => { if (selectedFile) editRemoteFile(selectedFile); }}><Pencil size={14} />编辑</button><button disabled={filesBusy || activeTab?.status !== 'connected' || activeTab.session.kind !== 'ssh'} onClick={() => void refreshFiles()} aria-label="刷新文件"><RefreshCw size={14} /></button></div><div className="file-list-head"><label className="file-select-all"><input type="checkbox" aria-label="全选当前目录文件" disabled={!files.some(f => !f.isDir)} checked={files.some(f => !f.isDir) && files.filter(f => !f.isDir).every(f => selectedFiles.includes(f.name))} onChange={e => setSelectedFiles(e.target.checked ? files.filter(f => !f.isDir).map(f => f.name) : [])} />名称</label><span>大小</span></div>{selectedFiles.length > 0 && <p className="file-selection">已选择 {selectedFiles.length} 个文件</p>}<div className="file-list">{files.map(f => <div className={`file-entry ${selectedFiles.includes(f.name) ? 'selected' : ''}`} key={f.name}>{!f.isDir && <input type="checkbox" aria-label={`选择 ${f.name}`} checked={selectedFiles.includes(f.name)} onChange={e => setSelectedFiles(previous => e.target.checked ? [...previous, f.name] : previous.filter(name => name !== f.name))} />}<button className="file-row" onClick={() => f.isDir ? setPath(remotePath(path, f.name)) : setSelectedFiles([f.name])} onDoubleClick={() => { if (!f.isDir) editRemoteFile(f.name); }}>{f.isDir ? <Folder size={16} className="folder-icon" /> : <FileText size={16} />}<span>{f.name}</span><small>{f.isDir ? '—' : f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}</small></button></div>)}{filesBusy && <p className="subtle">读取中…</p>}{fileError && <p className="error-message">{fileError}</p>}{!filesBusy && !files.length && !fileError && <p className="subtle">{activeTab?.session.kind === 'ssh' && activeTab.status === 'connected' ? '目录为空' : '连接 SSH 后浏览远程文件'}</p>}</div></aside>}
    </div>
    {transfers.length > 0 && <TransferStatus jobs={transfers} onCancel={id => void queue.cancel(id)} onPause={id => void queue.pause(id)} onResume={id => queue.resume(id)} canResume={id => queue.available(id) && tabs.some(tab => tab.id === id && tab.status === 'connected')} onCancelAll={() => queue.cancelAll()} onDismiss={() => queue.clearFinished()} />}
    <footer className="statusbar"><span><span className={`status-dot ${activeTab?.status === 'connected' ? '' : 'offline'}`} />{api.desktop ? '桌面版' : '浏览器预览'}</span><span>{tabs.filter(t => t.status === 'connected').length} 个连接</span><span>UTF-8</span><span>xterm-256color</span><span className="status-right"><ShieldCheck size={13} />{activeTab?.session.kind === 'ssh' && activeTab.status === 'connected' ? '主机指纹已验证' : '本地配置'}</span></footer>
    {message && <div className="toast" role="status">{message}</div>}
    {editor && <div hidden={!!fingerprint || !!authChallenge}><RemoteEditor key={`${editor.tabId}:${editor.path}`} target={editor} connected={tabs.find(t => t.id === editor.tabId)?.status === 'connected'} suspended={!!fingerprint || !!authChallenge} onClose={() => setEditor(null)} onSaved={() => { if (latestActive.current === editor.tabId) void refreshFiles(); }} /></div>}
    {fingerprint && <Dialog title={fingerprint.previous ? '服务器指纹发生变化' : '首次连接 · 确认服务器身份'}>
      <p>{fingerprint.host || tabs.find(t => t.id === fingerprint.tabId)?.session.host}</p><div className="notice">{fingerprint.previous ? '当前指纹与已保存记录不同，请先核实服务器身份。' : '请核对管理员提供的主机指纹。'}</div><label>SHA256 指纹<code className="fingerprint">{fingerprint.fingerprint}</code></label>{fingerprint.previous && <label>原指纹<code className="fingerprint">{fingerprint.previous}</code></label>}<div className="dialog-actions"><button onClick={() => void fingerprintDecision(false)}>取消连接</button><button className="primary" onClick={() => void fingerprintDecision(true)}>{fingerprint.previous ? '已核实，更新并连接' : '信任并连接'}</button></div>
    </Dialog>}
    {authChallenge && !fingerprint && <AuthDialog key={authChallenge.requestId} event={authChallenge} sessionName={tabs.find(t => t.id === authChallenge.tabId)?.session.name || "SSH 会话"} onRespond={async answers => { await api.respondAuth(authChallenge.tabId, authChallenge.requestId!, answers); setAuthChallenges(prev => prev.filter(c => c.requestId !== authChallenge.requestId)); }} />}
    {modal && !fingerprint && !authChallenge && <Dialog title={{ session: data.sessions.some(s => s.id === draft.id) ? '编辑会话' : '新建 SSH 连接', credentials: '连接认证', settings: '设置', snippets: '命令片段', import: '导入 / 导出配置', search: '查找终端内容', log: '会话日志', paste: '多行粘贴预览', broadcast: '多会话广播', delete: '删除会话', sshImport: '导入 OpenSSH 会话', diagnostics: '连接诊断', workspaces: '工作空间' }[modal]} onClose={closeModal}>
      {modal === 'session' && <form onSubmit={e => { e.preventDefault(); saveSession(true); }}>
        <label>会话名称<input autoFocus value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如 api-prod-01" /></label>
        <ConnectionFields value={draft} onChange={value => setDraft({ ...draft, ...value })} onError={notify} />
        <label>环境分组<select value={draft.environment} onChange={e => setDraft({ ...draft, environment: e.target.value as Session['environment'] })}>{Object.entries(environmentNames).map(([v, l]) => <option value={v} key={v}>{l}</option>)}</select></label>
        <label className="check-row"><input type="checkbox" checked={!!draft.jump} onChange={e => setDraft({ ...draft, jump: e.target.checked ? { host: '', port: 22, username: draft.username, auth: 'agent', keyPath: '' } : undefined })} />通过跳板机连接</label>
        {draft.jump && <fieldset className="jump-fields"><legend>跳板机 · 单跳</legend><ConnectionFields value={draft.jump} prefix="跳板机" onChange={jump => setDraft({ ...draft, jump })} onError={notify} /></fieldset>}
        {formError && <p className="error-message" role="alert">{formError}</p>}<div className="dialog-actions">{data.sessions.some(s => s.id === draft.id) && <button className="danger push-left" type="button" onClick={() => setModal('delete')}><Trash2 size={14} />删除</button>}<button type="button" onClick={() => saveSession(false)}>仅保存</button><button className="primary" type="submit">保存并连接</button></div>
      </form>}
      {modal === 'credentials' && <form onSubmit={e => { e.preventDefault(); const target = credentialsTarget.current; if (!target) return; const secret = structuredClone(credentials); closeModal(); if (target.tabId) void connectTab(target.tabId, target.session, secret); else openTab(target.session, secret); }}>
        <p className="subtle">目标：{credentialsTarget.current?.session.username}@{credentialsTarget.current?.session.host}</p>
        <CredentialFields auth={credentialsTarget.current?.session.auth || 'password'} value={credentials} onChange={setCredentials} />
        {credentialsTarget.current?.session.jump && <fieldset className="jump-fields"><legend>跳板机：{credentialsTarget.current.session.jump.username}@{credentialsTarget.current.session.jump.host}</legend><CredentialFields auth={credentialsTarget.current.session.jump.auth} prefix="跳板机" value={credentials.jump || emptyCredentials()} onChange={jump => setCredentials({ ...credentials, jump })} /></fieldset>}
        <div className="dialog-actions"><button type="button" onClick={closeModal}>取消</button><button className="primary" type="submit">连接</button></div></form>}
      {modal === 'workspaces' && <WorkspaceDialog data={data} tabCount={tabs.length} onSave={saveWorkspace} onOpen={openWorkspace} onChange={workspaces => updateData({ ...data, workspaces })} />}
      {modal === 'diagnostics' && <><p className="subtle">{activeTab?.session.name || '尚未选择连接'} · 本次连接过程</p><ol className="diagnostic-list" aria-label="连接阶段">{(diagnostics[active] || []).map((entry, i) => <li key={i}><time>{entry.time}</time><span>{entry.text}</span></li>)}</ol>{!diagnostics[active]?.length && <p className="subtle">暂无连接诊断。</p>}<div className="dialog-actions"><button onClick={() => void navigator.clipboard.writeText((diagnostics[active] || []).map(e => `${e.time} ${e.text}`).join('\n')).then(() => notify('诊断已复制')).catch(() => notify('请手动选择诊断内容复制'))}>复制诊断</button><button onClick={closeModal}>关闭</button></div></>}
      {modal === 'settings' && <><p className="subtle">ChwellTerm · v0.9.2</p><label className="check-row"><input type="checkbox" checked={data.settings.restoreWorkspace} onChange={e => updateData({ ...data, settings: { ...data.settings, restoreWorkspace: e.target.checked } })} />启动时恢复上次工作空间</label><p className="subtle">恢复标签和布局，点击连接后重新认证。</p><label>主题<select value={data.settings.theme} onChange={e => updateData({ ...data, settings: { ...data.settings, theme: e.target.value as 'dark' | 'light' } })}><option value="dark">深色</option><option value="light">浅色</option></select></label><div className="form-grid"><label>字号<input type="number" min={11} max={24} value={data.settings.fontSize} onChange={e => updateData({ ...data, settings: { ...data.settings, fontSize: Math.max(11, Math.min(24, Number(e.target.value) || 13)) } })} /></label><label>滚动历史<select value={data.settings.scrollback} onChange={e => updateData({ ...data, settings: { ...data.settings, scrollback: Number(e.target.value) } })}>{[1000, 10000, 50000].map(v => <option key={v} value={v}>{v} 行</option>)}</select></label></div><label>终端字体<input value={data.settings.fontFamily} onChange={e => updateData({ ...data, settings: { ...data.settings, fontFamily: e.target.value } })} /></label><p className="subtle">查找：Cmd F / Ctrl F<br />搜索会话：Cmd K / Ctrl K<br />多行粘贴会先显示预览。</p><div className="dialog-actions"><button onClick={closeModal}><Check size={14} />完成</button></div></>}
      {modal === 'snippets' && <><div className="snippet-list">{data.snippets.map((s, i) => <div className="snippet" key={i}><button disabled={activeTab?.status !== 'connected'} onClick={() => { terminalRefs.current.get(active)?.paste(s.command); closeModal(); terminalRefs.current.get(active)?.focus(); }}><span>{s.name}</span><code>{s.command}</code></button><button aria-label={`删除 ${s.name}`} onClick={() => updateData({ ...data, snippets: data.snippets.filter((_, j) => i !== j) })}><X size={14} /></button></div>)}</div><form onSubmit={e => { e.preventDefault(); if (!snippetDraft.name.trim() || !snippetDraft.command.trim()) return; updateData({ ...data, snippets: [...data.snippets, snippetDraft] }); setSnippetDraft({ name: '', command: '' }); }}><label>片段名称<input value={snippetDraft.name} onChange={e => setSnippetDraft({ ...snippetDraft, name: e.target.value })} /></label><label>命令<input value={snippetDraft.command} onChange={e => setSnippetDraft({ ...snippetDraft, command: e.target.value })} /></label><div className="dialog-actions"><button className="primary" type="submit">新增片段</button></div></form></>}
      {modal === 'sshImport' && <SshImportDialog onImport={sessions => { const result = mergeSshSessions(data.sessions, sessions); updateData({ ...data, sessions: result.sessions }); closeModal(); notify(`新增 ${result.added} 个会话，跳过 ${result.skipped} 个重复连接`); }} />}
      {modal === 'import' && <><button className="import-file-button" onClick={() => setModal('sshImport')}>导入 OpenSSH config</button><label>配置 JSON<textarea rows={10} value={configText} onChange={e => setConfigText(e.target.value)} /></label><p className="subtle">配置包含会话、设置、片段和工作空间；密码和私钥内容不会导出。导入合并会话和已命名工作空间，保留本机设置。</p>{formError && <p className="error-message">{formError}</p>}<div className="dialog-actions"><button onClick={() => { void navigator.clipboard.writeText(configText).then(() => notify('配置已复制')).catch(() => notify('请手动选中配置文本复制')); }}>复制配置</button><button className="primary" onClick={() => { try { const imported = parseAppData(JSON.parse(configText)); updateData(mergeWorkspaceConfig(data, imported)); closeModal(); notify('会话和工作空间已导入，已有 ID 已跳过'); } catch (error) { setFormError(errorText(error)); } }}>导入配置</button></div></>}
      {modal === 'search' && <form onSubmit={e => { e.preventDefault(); setFormError(terminalRefs.current.get(active)?.search(search) ? '找到匹配内容' : '没有找到匹配内容'); }}><label>查找文本<input autoFocus value={search} onChange={e => setSearch(e.target.value)} /></label><p className="subtle" role="status">{formError}</p><div className="dialog-actions"><button type="submit" className="primary">查找下一处</button></div></form>}
      {modal === 'log' && <><label>当前终端记录<textarea rows={14} readOnly value={terminalRefs.current.get(active)?.log() || '暂无终端内容'} /></label><div className="dialog-actions"><button onClick={closeModal}>关闭</button></div></>}
      {modal === 'paste' && <><label>待粘贴内容<textarea rows={8} value={paste.text} onChange={e => setPaste({ ...paste, text: e.target.value })} /></label><p className="notice">换行可能立即执行命令，请检查内容。{broadcast.includes(paste.id) && '当前正在广播，内容会发送到多个会话。'}</p><div className="dialog-actions"><button onClick={closeModal}>取消</button><button className="primary" onClick={() => { terminalRefs.current.get(paste.id)?.paste(paste.text); closeModal(); }}>确认粘贴</button></div></>}
      {modal === 'broadcast' && <><p className="notice">启用后，在所选终端输入的每个字符都会发送到所有目标，包括生产环境。</p>{tabs.filter(t => t.status === 'connected').map(t => <label className="check-row" key={t.id}><input type="checkbox" checked={broadcastSelection.includes(t.id)} onChange={e => setBroadcastSelection(e.target.checked ? [...broadcastSelection, t.id] : broadcastSelection.filter(id => id !== t.id))} />{t.session.name}<span className="subtle">{environmentNames[t.session.environment]}</span></label>)}<div className="dialog-actions"><button onClick={() => { setBroadcast([]); closeModal(); }}>关闭广播</button><button className="primary" disabled={broadcastSelection.length < 2} onClick={() => { setBroadcast(broadcastSelection); closeModal(); }}>确认启用广播</button></div></>}
      {modal === 'delete' && <><p className="notice">删除 {draft.name} 的配置及已保存凭据，并关闭它的终端。</p><div className="dialog-actions"><button onClick={closeModal}>取消</button><button className="danger" onClick={() => void deleteSession()}>确认删除</button></div></>}
    </Dialog>}
  </div>;
}

function AuthDialog({ event, sessionName, onRespond }: { event: TerminalEvent; sessionName: string; onRespond(answers: string[] | null): Promise<void> }) {
  const challenge = event.challenge!;
  const [answers, setAnswers] = useState(() => challenge.prompts.map(() => ''));
  const [show, setShow] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function respond(cancel: boolean) {
    if (busy) return;
    setBusy(true); setError('');
    const submitted = cancel ? null : [...answers]; setAnswers(challenge.prompts.map(() => '')); setShow(false);
    try { await onRespond(submitted); } catch (e) { setError(errorText(e)); setBusy(false); }
    finally { submitted?.fill(''); }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); void respond(true); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [busy]);
  return <Dialog title="SSH 交互式认证">
    <form onSubmit={e => { e.preventDefault(); void respond(false); }}>
      <p className="auth-context">{sessionName} · {challenge.role}<br /><strong>{challenge.username}@{event.host}</strong></p>
      {challenge.name && <p className="auth-server-text">{challenge.name}</p>}
      {challenge.instructions && <div className="notice auth-server-text">{challenge.instructions}</div>}
      {challenge.prompts.map((prompt, index) => <label key={index} className="auth-server-text">{prompt.prompt || `认证回答 ${index + 1}`}<input aria-label={prompt.prompt || `认证回答 ${index + 1}`} type={prompt.echo || show ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={4096} value={answers[index]} disabled={busy} onChange={e => setAnswers(prev => prev.map((value, i) => i === index ? e.target.value : value))} /></label>)}
      {!challenge.prompts.length && <p className="subtle">服务器本轮没有输入项，确认后继续认证。</p>}
      {challenge.prompts.some(p => !p.echo) && <label className="check-row"><input type="checkbox" checked={show} disabled={busy} onChange={e => setShow(e.target.checked)} />显示输入内容</label>}
      <p className="subtle">回答仅用于本次认证，不保存到配置或会话日志。请在 5 分钟内完成。</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => void respond(true)}>取消连接</button><button className="primary" type="submit" disabled={busy}>{busy ? '正在提交…' : '确认并继续'}</button></div>
    </form>
  </Dialog>;
}

