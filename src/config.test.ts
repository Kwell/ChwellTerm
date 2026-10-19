import { describe, expect, it } from 'vitest';
import { exportConfig, parseAppData, remotePath, validateSession } from './config';
import { defaultData } from './types';

describe('session configuration boundary', () => {
  it('roundtrips interactive authentication on both hops without challenge answers', () => {
    const config = structuredClone(defaultData);
    config.sessions = [{ ...config.sessions[0], kind: 'ssh', host: 'internal', username: 'dev', auth: 'keyboard-interactive', jump: { host: 'gateway', port: 22, username: 'jump', auth: 'keyboard-interactive', keyPath: '' } }];
    Object.assign(config.sessions[0], { otp: '654321', responses: ['password-secret'] });
    Object.assign(config.sessions[0].jump!, { otp: 'jump-otp' });
    const exported = exportConfig(config);
    expect(exported).not.toMatch(/654321|password-secret|jump-otp/);
    expect(parseAppData(JSON.parse(exported)).sessions[0].jump?.auth).toBe('keyboard-interactive');
    expect(parseAppData(JSON.parse(exported)).sessions[0].auth).toBe('keyboard-interactive');
  });
  it('rejects invalid ports and missing key paths before connecting', () => {
    const session = { ...defaultData.sessions[0], kind: 'ssh' as const, host: 'localhost', username: 'dev', auth: 'password' as const };
    expect(validateSession({ ...session, port: 0 })).toContain('端口');
    expect(validateSession({ ...session, host: 'bad host' })).toContain('主机');
    expect(validateSession({ ...session, auth: 'key', keyPath: '' })).toContain('私钥');
    expect(validateSession({ ...session, port: 2222 })).toBeUndefined();
  });
  it('never exports passwords or private key contents from an imported object', () => {
    const config = structuredClone(defaultData);
    Object.assign(config.sessions[0], { password: 'do-not-export', privateKey: 'secret-key' });
    const exported = exportConfig(config);
    expect(exported).not.toContain('do-not-export'); expect(exported).not.toContain('secret-key');
    expect(parseAppData(JSON.parse(exported))).toEqual(defaultData);
  });
  it('rejects duplicate IDs and unsupported future schemas', () => {
    expect(() => parseAppData({ ...defaultData, sessions: [defaultData.sessions[0], defaultData.sessions[0]] })).toThrow('ID');
    expect(() => parseAppData({ ...defaultData, version: 99 })).toThrow('版本');
  });
  it('treats server file names as single path components', () => {
    expect(remotePath('/srv/api', '..')).toBe('/srv');
    expect(remotePath('/', '..')).toBe('/'); expect(remotePath('/', '测试.txt')).toBe('/测试.txt');
    expect(() => remotePath('/srv', '../../etc/passwd')).toThrow();
    expect(() => remotePath('/srv', 'a\0b')).toThrow();
  });
  it('keeps agent and jump settings while stripping jump secrets and rejecting invalid hops', () => {
    const config = structuredClone(defaultData);
    config.sessions = [{ ...config.sessions[0], kind: 'ssh', host: 'internal', username: 'dev', auth: 'agent', jump: { host: 'gateway', port: 22, username: 'jump', auth: 'password', keyPath: '' } }];
    Object.assign(config.sessions[0].jump!, { password: 'jump-secret', passphrase: 'phrase-secret' });
    const exported = exportConfig(config);
    expect(exported).not.toContain('secret');
    expect(parseAppData(JSON.parse(exported)).sessions[0].jump?.host).toBe('gateway');
    config.sessions[0].jump!.port = 0;
    expect(() => exportConfig(config)).toThrow('跳板机');
    config.sessions[0].jump!.port = 22;
    Object.assign(config.sessions[0].jump!, { jump: {} });
    expect(() => exportConfig(config)).toThrow('单跳');
  });
});
