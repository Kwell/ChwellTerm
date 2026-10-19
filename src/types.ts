export type Environment = 'production' | 'development' | 'personal';
export type AuthMethod = 'password' | 'key' | 'agent' | 'keyboard-interactive';
export interface JumpHost { host: string; port: number; username: string; auth: AuthMethod; keyPath: string; }
export interface Session {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  environment: Environment;
  auth: AuthMethod;
  keyPath: string;
  kind: 'ssh' | 'local';
  jump?: JumpHost;
}
export type Layout = 'single' | 'horizontal' | 'vertical' | 'grid';
export interface WorkspaceSnapshot { tabs: { id: string; sessionId: string }[]; activeTabId: string; secondaryTabId?: string; layout: Layout; splitRatio: number; filesOpen: boolean; paneTabIds?: string[]; rowRatio?: number; }
export interface SavedWorkspace extends WorkspaceSnapshot { id: string; name: string; }
export interface Settings { theme: 'dark' | 'light'; fontSize: number; fontFamily: string; scrollback: number; restoreWorkspace: boolean; }
export interface AppData { version: 1; sessions: Session[]; settings: Settings; snippets: { name: string; command: string }[]; workspaces: SavedWorkspace[]; lastWorkspace?: WorkspaceSnapshot; }
export interface Tab { id: string; session: Session; status: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'; error?: string; }
export interface Credentials { password: string; passphrase: string; remember: boolean; jump?: Omit<Credentials, 'jump'>; }
export interface TerminalEvent { type: 'data' | 'connected' | 'closed' | 'error' | 'fingerprint' | 'diagnostic' | 'auth-challenge'; data?: string; host?: string; fingerprint?: string; previous?: string; requestId?: string; challenge?: { role: string; username: string; name: string; instructions: string; prompts: { prompt: string; echo: boolean }[] }; }
export interface RemoteFile { name: string; size: number; isDir: boolean; }
export interface RemoteDocument { content: string; revision: string; }
export interface RemoteSaveResult { document: RemoteDocument; backupPath: string; }
export interface TransferProgress {
  temporaryPath?: string; transferred: number; total: number | null; name: string; stage?: 'verifying'; }
export const defaultData: AppData = {
  version: 1,
  sessions: [{ id: 'local', name: '本地终端', host: '', port: 22, username: '', environment: 'personal', auth: 'key', keyPath: '', kind: 'local' }],
  settings: { theme: 'dark', fontSize: 13, fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', scrollback: 10000, restoreWorkspace: false },
  workspaces: [],
  snippets: [{ name: '容器状态', command: 'docker ps' }, { name: '磁盘空间', command: 'df -h' }, { name: '运行时间', command: 'uptime' }],
};
