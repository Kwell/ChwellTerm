import { validateSession } from './config';
import type { Session } from './types';

export interface SshImportEntry { alias: string; session?: Session; warnings: string[]; }
export interface SshImportPreview { entries: SshImportEntry[]; warnings: string[]; }
type Directive = { key: string; values: string[]; line: number };
type Block = { patterns: string[]; directives: Directive[] };

function tokens(line: string): string[] {
  line = line.replace(/^(\s*\S+?)\s*=\s*/, '$1 ');
  const output: string[] = []; let word = '', quote = '', started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!quote && ch === '#') break;
    if (ch === '\\' && i + 1 < line.length && /[\s"'\\#]/.test(line[i + 1])) { word += line[++i]; started = true; continue; }
    if (quote) { if (ch === quote) quote = ''; else word += ch; started = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch) || (ch === '=' && output.length === 0)) { if (started) { output.push(word); word = ''; started = false; } continue; }
    word += ch; started = true;
  }
  if (quote) throw new Error('引号没有闭合');
  if (started) output.push(word);
  return output;
}
function matches(patterns: string[], alias: string) {
  const test = (pattern: string) => new RegExp('^' + [...pattern].map(ch => ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'i').test(alias);
  return patterns.some(p => !p.startsWith('!') && test(p)) && !patterns.some(p => p.startsWith('!') && test(p.slice(1)));
}
function expand(value: string, replacements: Record<string, string>): string {
  return value.replace(/%([%hnrd])/g, (_, key: string) => replacements[key] ?? `%${key}`);
}

export function parseSshConfig(text: string, defaultUser = '', home = ''): SshImportPreview {
  if (text.length > 1_000_000) throw new Error('配置文件过大');
  const blocks: Block[] = [{ patterns: ['*'], directives: [] }];
  const aliases = new Map<string, string>(), warnings: string[] = [];
  let block = blocks[0], conditional = false, hasMatch = false;
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
    let parts: string[];
    try { parts = tokens(line); } catch (error) { throw new Error(`第 ${index + 1} 行：${(error as Error).message}`); }
    if (!parts.length) return;
    const key = parts[0].toLowerCase(), values = parts.slice(1);
    if (!values.length) throw new Error(`第 ${index + 1} 行：${parts[0]} 缺少值`);
    if (key === 'match') { conditional = true; hasMatch = true; warnings.push(`第 ${index + 1} 行：暂不支持 Match 条件，本文件不能直接导入；请先移除条件段后预览。`); return; }
    if (key === 'host') {
      conditional = false; block = { patterns: values, directives: [] }; blocks.push(block);
      for (const alias of values.filter(v => !/[*!?]/.test(v))) if (!aliases.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), alias);
      return;
    }
    if (!conditional) block.directives.push({ key, values, line: index + 1 });
  });
  const supported = new Set(['hostname', 'user', 'port', 'identityfile', 'proxyjump', 'preferredauthentications', 'identitiesonly']);
  const build = (alias: string, allowJump = true, userOverride?: string, portOverride?: number): SshImportEntry => {
    const options = new Map<string, Directive>(), notes: string[] = [];
    for (const candidate of blocks.filter(b => matches(b.patterns, alias))) {
      for (const directive of candidate.directives) {
        if (!options.has(directive.key)) options.set(directive.key, directive);
        else if (directive.key === 'identityfile') notes.push('配置指定多个 IdentityFile，本版只导入第一个。');
      }
    }
    let blocked = hasMatch;
    if (hasMatch) notes.push('文件含未支持的 Match 条件，无法确定实际连接设置。');
    for (const directive of options.values()) {
      if (supported.has(directive.key)) {
        if (directive.values.length !== 1) { blocked = true; notes.push(`第 ${directive.line} 行：${directive.key} 需要单个值，路径含空格时请加引号。`); }
        continue;
      }
      const disabled = directive.values.join(' ').toLowerCase() === 'none';
      if (['proxycommand', 'include', 'canonicalizehostname', 'identityagent', 'certificatefile', 'pkcs11provider'].includes(directive.key) && !(disabled && directive.key !== 'include') && !(directive.key === 'canonicalizehostname' && directive.values[0] === 'no')) {
        blocked = true; notes.push(`第 ${directive.line} 行：${directive.key} 暂不支持，该主机不可导入。`);
      } else notes.push(`第 ${directive.line} 行：${directive.key} 未导入。`);
    }
    const first = (key: string) => options.get(key)?.values[0];
    const host = expand(first('hostname') || alias, { '%': '%', h: alias, n: alias });
    const username = userOverride || first('user') || defaultUser;
    let keyPath = expand(first('identityfile') || '', { '%': '%', h: host, n: alias, r: username, d: home || '%d' });
    if (keyPath.toLowerCase() === 'none') keyPath = '';
    if (keyPath && ((!/^(~[\/\\]|\/|[A-Za-z]:[\/\\]|\\\\)/.test(keyPath)) || /%[A-Za-z]|\$\{/.test(keyPath))) {
      blocked = true; notes.push('私钥路径含相对路径或未支持的变量，请改为绝对路径后导入。');
    }
    if (host.includes('%') || host.includes('$')) { blocked = true; notes.push('主机地址含未支持的变量。'); }
    if (first('identityagent')?.toLowerCase() === 'none' && !keyPath) notes.push('IdentityAgent none：使用密码认证。');
    const session: Session = { id: crypto.randomUUID(), name: alias, host, port: portOverride ?? Number(first('port') || 22), username, auth: first('preferredauthentications')?.toLowerCase() === 'keyboard-interactive' ? 'keyboard-interactive' : first('preferredauthentications')?.toLowerCase() === 'password' ? 'password' : keyPath ? 'key' : first('identityagent')?.toLowerCase() === 'none' ? 'password' : 'agent', keyPath, kind: 'ssh', environment: 'development' };
    const jump = first('proxyjump');
    if (jump && jump.toLowerCase() !== 'none') {
      if (!allowJump || jump.includes(',')) { blocked = true; notes.push('本版仅支持单跳 ProxyJump，不能导入多跳或嵌套跳板。'); }
      else {
        const match = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:@]+)(?::(\d+))?$/.exec(jump);
        if (!match) { blocked = true; notes.push('ProxyJump 地址无效，请使用 user@host:port 或 Host 别名。'); }
        else {
          const jumpAlias = match[2].replace(/^\[|\]$/g, '');
          const resolved = build(jumpAlias, false, match[1], match[3] ? Number(match[3]) : undefined);
          if (!resolved.session) { blocked = true; notes.push('跳板机配置不可导入：' + resolved.warnings.join('；')); }
          else {
            const j = resolved.session;
            session.jump = { host: j.host, port: match[3] ? Number(match[3]) : j.port, username: match[1] || j.username, auth: j.auth, keyPath: j.keyPath };
            notes.push(...resolved.warnings.map(n => '跳板机：' + n));
          }
        }
      }
    }
    const preferred = first('preferredauthentications');
    if (preferred?.toLowerCase() === 'publickey,password') notes.push('使用公钥认证；本版不会自动回退密码，失败后可在会话编辑中切换。');
    if (preferred && !['password', 'publickey', 'publickey,password', 'keyboard-interactive'].includes(preferred.toLowerCase())) { blocked = true; notes.push('PreferredAuthentications 包含未支持的认证流程。'); }
    if (first('identitiesonly')?.toLowerCase() === 'yes' && !keyPath) { blocked = true; notes.push('IdentitiesOnly yes 需要显式 IdentityFile，本版不能按默认密钥路径筛选 Agent。'); }
    const error = validateSession(session); if (error) { blocked = true; notes.push(error); }
    if (session.auth === 'agent') notes.push('未指定私钥，使用本机 SSH Agent；可在会话编辑中改用密码。');
    return { alias, session: blocked ? undefined : session, warnings: [...new Set(notes)] };
  };
  const entries = [...aliases.values()].map(alias => build(alias));
  if (!entries.length) warnings.push('未发现具体 Host 别名；通配符配置只作为已有别名的默认值。');
  return { entries, warnings };
}

export function mergeSshSessions(existing: Session[], incoming: Session[]) {
  const signature = (s: Session) => JSON.stringify([s.kind, s.host.toLowerCase(), s.port, s.username, s.auth, s.keyPath, s.jump ? [s.jump.host.toLowerCase(), s.jump.port, s.jump.username, s.jump.auth, s.jump.keyPath] : null]);
  const names = new Set(existing.map(s => s.name));
  const signatures = new Set(existing.map(signature));
  const added: Session[] = []; let skipped = 0;
  for (const session of incoming) {
    if (signatures.has(signature(session))) { skipped++; continue; }
    signatures.add(signature(session));
    let name = session.name, suffix = 2;
    while (names.has(name)) name = `${session.name} (${suffix++})`;
    names.add(name); added.push({ ...session, name });
  }
  return { sessions: [...existing, ...added], added: added.length, skipped };
}
