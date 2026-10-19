import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { parseAppData, exportConfig } from './config';
import { defaultData } from './types';
import type { AppData, Credentials, RemoteFile, Session, TerminalEvent, TransferProgress } from './types';

export const desktop = isTauri();
export async function setWindowTheme(theme: AppData['settings']['theme']) {
  if (desktop) await getCurrentWindow().setTheme(theme);
}
export async function loadData(): Promise<AppData> {
  const raw = desktop ? await invoke<string | null>('load_config') : localStorage.getItem('terminal-workbench-v1');
  return raw ? parseAppData(JSON.parse(raw)) : structuredClone(defaultData);
}
export async function saveData(data: AppData) {
  const json = exportConfig(data);
  if (desktop) await invoke('save_config', { json }); else localStorage.setItem('terminal-workbench-v1', json);
}
export async function connectTerminal(id: string, session: Session, credentials: Credentials, cols: number, rows: number, onEvent: (event: TerminalEvent) => void) {
  if (!desktop) throw new Error('真实终端需要在桌面版本中运行');
  const channel = new Channel<TerminalEvent>(); channel.onmessage = onEvent;
  await invoke('start_terminal', { id, session, credentials, cols, rows, channel });
}
export const terminalInput = (id: string, data: string) => invoke('terminal_input', { id, data });
export const terminalResize = (id: string, cols: number, rows: number) => invoke('terminal_resize', { id, cols, rows });
export const terminalClose = (id: string) => invoke('terminal_close', { id });
export const trustHost = (requestId: string, accept: boolean) => invoke('trust_host', { requestId, accept });
export async function pickKey() { return desktop ? await open({ multiple: false, directory: false, title: '选择 SSH 私钥' }) : null; }
export const listRemote = (id: string, path: string) => invoke<RemoteFile[]>('list_remote', { id, path });
export const readRemoteText = (id: string, path: string) => invoke<import('./types').RemoteDocument>('read_remote_text', { id, path });
export const saveRemoteText = (id: string, path: string, content: string, revision: string) => invoke<import('./types').RemoteSaveResult>('save_remote_text', { id, path, content, revision });
export async function pickUploads(): Promise<string[]> {
  const paths = await open({ multiple: true, directory: false, title: '选择上传文件（可多选）' });
  return paths == null ? [] : typeof paths === 'string' ? [paths] : paths;
}
export const pickDownloadPath = (name: string) => save({ defaultPath: name, title: '保存远程文件' });
export const pickDownloadDirectory = () => open({ multiple: false, directory: true, title: '选择批量下载目录（同名文件不会覆盖）' });
export async function uploadRemote(id: string, transferId: string, localPath: string, remoteDir: string, onProgress: (progress: TransferProgress) => void) {
  const channel = new Channel<TransferProgress>(); channel.onmessage = onProgress;
  return invoke<string>('upload_remote', { id, transferId, localPath, remoteDir, resumable: true, channel });
}
export async function downloadRemote(id: string, transferId: string, localPath: string, remotePath: string, batch: boolean, onProgress: (progress: TransferProgress) => void) {
  const channel = new Channel<TransferProgress>(); channel.onmessage = onProgress;
  if (batch) await invoke('download_remote_batch', { id, transferId, targetDir: localPath, remotePath, resumable: true, channel });
  else await invoke('download_remote', { id, transferId, localPath, remotePath, resumable: true, channel });
}
export const cancelTransfer = (transferId: string) => invoke('cancel_transfer', { transferId });
export const pauseTransfer = (transferId: string) => invoke('pause_transfer', { transferId });
export async function pickSshConfig(): Promise<{ text: string; username: string; home: string } | null> {
  if (!desktop) return null;
  const path = await open({ multiple: false, title: '选择 OpenSSH config 文件' });
  return typeof path === 'string' ? invoke('read_ssh_config', { path }) : null;
}
export const forgetCredential = (sessionId: string) => invoke('forget_credential', { sessionId });

export const respondAuth = (tabId: string, requestId: string, responses: string[] | null) => invoke('respond_auth', { tabId, requestId, responses });
