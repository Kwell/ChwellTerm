import type { AppData, Session } from './types';
import { defaultData } from './types';
import { parseSnapshot, parseWorkspaces } from './workspaces';

export function validateSession(s: Session): string | undefined {
  if (!s.name.trim()) return '请输入会话名称';
  if (s.kind === 'local') return;
  if (!s.host.trim() || /[\s\x00-\x1f]/.test(s.host)) return '请输入有效主机地址';
  if (!s.username.trim() || /[\x00-\x1f]/.test(s.username)) return '请输入用户名';
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return '端口应为 1–65535';
  if (s.auth === 'key' && !s.keyPath.trim()) return '请选择 SSH 私钥文件';
  if (s.jump) {
    const error = validateSession({ ...s, ...s.jump, name: '跳板机', jump: undefined });
    if (error) return '跳板机：' + error;
  }
}

export function parseAppData(raw: unknown): AppData {
  if (!raw || typeof raw !== 'object' || (raw as {version?: number}).version !== 1) throw new Error('无法读取配置版本');
  const v = raw as Record<string, unknown>;
  if (!Array.isArray(v.sessions) || !Array.isArray(v.snippets)) throw new Error('配置缺少会话或命令片段');
  const ids = new Set<string>();
  const sessions = v.sessions.map((s: unknown) => {
    if (!s || typeof s !== 'object') throw new Error('会话格式无效');
    const x = s as Record<string, unknown>;
    if (typeof x.id !== 'string' || !x.id || ids.has(x.id) || typeof x.name !== 'string' ||
      typeof x.host !== 'string' || typeof x.username !== 'string' || typeof x.keyPath !== 'string' ||
      typeof x.port !== 'number' || !['ssh', 'local'].includes(String(x.kind)) ||
      !['production', 'development', 'personal'].includes(String(x.environment)) || !['key', 'password', 'agent', 'keyboard-interactive'].includes(String(x.auth))) throw new Error('会话字段无效或 ID 重复');
    const clean: Session = { id: x.id, name: x.name, host: x.host, username: x.username, keyPath: x.keyPath, port: x.port, kind: x.kind as Session['kind'], environment: x.environment as Session['environment'], auth: x.auth as Session['auth'] };
    if (x.jump != null) {
      const j = x.jump as Record<string, unknown>;
      if (typeof j !== 'object' || typeof j.host !== 'string' || typeof j.username !== 'string' || typeof j.keyPath !== 'string' || typeof j.port !== 'number' || !['key', 'password', 'agent', 'keyboard-interactive'].includes(String(j.auth)) || j.jump != null) throw new Error('跳板机字段无效，仅支持单跳');
      clean.jump = { host: j.host, port: j.port, username: j.username, keyPath: j.keyPath, auth: j.auth as Session['auth'] };
    }
    const error = validateSession(clean); if (error) throw new Error(error); ids.add(clean.id); return clean;
  });
  const settings = typeof v.settings === 'object' && v.settings ? v.settings as Record<string, unknown> : {};
  const snippets = v.snippets.map((s: unknown) => {
    if (!s || typeof s !== 'object' || typeof (s as {name?: unknown}).name !== 'string' || typeof (s as {command?: unknown}).command !== 'string') throw new Error('命令片段格式无效');
    return { name: (s as {name: string}).name, command: (s as {command: string}).command };
  });
  return { version: 1, sessions, snippets, workspaces: parseWorkspaces(v.workspaces), ...(v.lastWorkspace === undefined ? {} : { lastWorkspace: parseSnapshot(v.lastWorkspace) }), settings: {
    theme: settings.theme === 'light' ? 'light' : 'dark',
    fontSize: typeof settings.fontSize === 'number' ? Math.max(11, Math.min(24, settings.fontSize)) : defaultData.settings.fontSize,
    fontFamily: typeof settings.fontFamily === 'string' ? settings.fontFamily : defaultData.settings.fontFamily,
    scrollback: typeof settings.scrollback === 'number' ? Math.max(1000, Math.min(100000, settings.scrollback)) : defaultData.settings.scrollback,
    restoreWorkspace: settings.restoreWorkspace === true,
  }};
}

export function exportConfig(data: AppData): string {
  // Reconstruct the allowlisted schema, stripping credentials and unknown fields even from runtime objects.
  return JSON.stringify(parseAppData(data), null, 2);
}

export function remotePath(parent: string, child: string): string {
  if (child === '..') return parent.slice(0, parent.lastIndexOf('/')) || '/';
  if (child.includes('/') || child.includes('\\') || child === '.' || child.includes('\0')) throw new Error('无效远程文件名');
  return (parent === '/' ? '' : parent.replace(/\/$/, '')) + '/' + child;
}
