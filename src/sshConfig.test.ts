import { describe, expect, it } from 'vitest';
import { mergeSshSessions, parseSshConfig } from './sshConfig';
describe('OpenSSH import', () => {
  it('imports interactive authentication independently on target and jump, flags unsupported fallback orders', () => {
    const result = parseSshConfig('Host target\nUser deploy\nPreferredAuthentications keyboard-interactive\nProxyJump gateway\nHost gateway\nUser jump\nPreferredAuthentications keyboard-interactive', 'local');
    expect(result.entries[0].session?.auth).toBe('keyboard-interactive');
    expect(result.entries[0].session?.jump?.auth).toBe('keyboard-interactive');
    expect(parseSshConfig('Host unsupported\nPreferredAuthentications keyboard-interactive,password', 'local').entries[0].session).toBeUndefined();
  });
  it('uses first value, wildcard defaults, negation and quoted paths', () => {
    const preview = parseSshConfig('Host api other\n HostName = %h.example.com\n Port 2222\n IdentityFile "~/.ssh/key name" # comment\nHost * !other\n User admin\n Port 22\nHost other\n User=tester', 'local');
    expect(preview.entries.map(e => [e.session?.host, e.session?.username, e.session?.port, e.session?.keyPath])).toEqual([
      ['api.example.com', 'admin', 2222, '~/.ssh/key name'], ['other.example.com', 'tester', 2222, '~/.ssh/key name'],
    ]);
  });
  it('does not import proxy or include hosts as direct connections', () => {
    const preview = parseSshConfig('Host jump\n ProxyJump bastion\nHost included\n Include extras\nHost direct\n ProxyCommand none', 'user');
    expect(preview.entries.filter(e => e.session).map(e => e.alias)).toEqual(['jump', 'direct']);
    expect(preview.entries[0].session?.jump?.host).toBe('bastion');
  });
  it('skips Match directives and reports incomplete credentials and invalid ports', () => {
    const preview = parseSshConfig('Host a\n Port 70000\nMatch exec "echo test"\nUser wrong\nHost b\nHostName b.example', '');
    expect(preview.entries.every(e => !e.session)).toBe(true);
    expect(preview.warnings.join()).toContain('Match');
    expect(() => parseSshConfig('Host "broken')).toThrow('引号');
    expect(parseSshConfig('Host a\nUser admin\nMatch host a\nProxyJump bastion', 'user').entries[0].session).toBeUndefined();
  });
  it('merges without replacing a saved session and disambiguates names', () => {
    const a = parseSshConfig('Host a\nHostName one', 'user').entries[0].session!;
    const b = parseSshConfig('Host a\nHostName two', 'user').entries[0].session!;
    const result = mergeSshSessions([a], [a, b]);
    expect(result.skipped).toBe(1); expect(result.added).toBe(1);
    expect(result.sessions[0]).toBe(a); expect(result.sessions[1].name).toBe('a (2)');
  });
  it('resolves a single ProxyJump alias and preserves its independent authentication', () => {
    const result = parseSshConfig('Host target\nHostName 10.0.0.2\nUser deploy\nProxyJump gateway\nHost gateway\nHostName gateway.example.com\nUser jumpuser\nPort 2222\nIdentityFile ~/.ssh/jump', 'local');
    expect(result.entries[0].session?.auth).toBe('agent');
    expect(result.entries[0].session?.jump).toEqual({ host: 'gateway.example.com', port: 2222, username: 'jumpuser', auth: 'key', keyPath: '~/.ssh/jump' });
    const ipv6 = parseSshConfig('Host target\nProxyJump other@[::1]:2222', 'local');
    expect(ipv6.entries[0].session?.jump).toMatchObject({ host: '::1', port: 2222, username: 'other' });
    expect(parseSshConfig('Host a\nUser target\nProxyJump jumpuser@gateway').entries[0].session?.jump?.username).toBe('jumpuser');
  });
  it('blocks multiple hops, nested routes and unsupported authentication semantics', () => {
    for (const config of ['Host a\nProxyJump b,c', 'Host a\nProxyJump b\nHost b\nProxyJump c', 'Host a\nIdentitiesOnly yes', 'Host a\nPreferredAuthentications keyboard-interactive,password', 'Host a\nProxyCommand ssh gateway', 'Host a\nIdentityAgent /custom/socket']) {
      expect(parseSshConfig(config, 'user').entries[0].session).toBeUndefined();
    }
    const direct = parseSshConfig('Host a\nPreferredAuthentications password', 'user');
    expect(direct.entries[0].session?.auth).toBe('password');
    expect(parseSshConfig('Host a\nIdentityFile ~/.ssh/id_ed25519\nPreferredAuthentications password', 'user').entries[0].session?.auth).toBe('password');
    const jump = parseSshConfig('Host a\nProxyJump b', 'user').entries[0].session!;
    const noJump = { ...jump, jump: undefined };
    expect(mergeSshSessions([jump], [noJump]).added).toBe(1);
  });
});
