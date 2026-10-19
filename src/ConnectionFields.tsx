import type { Credentials, JumpHost } from './types';
import { pickKey } from './bridge';

export function ConnectionFields({ value, onChange, prefix = '', onError }: { value: JumpHost; onChange(value: JumpHost): void; prefix?: string; onError(message: string): void }) {
  return <>
    <div className="form-grid"><label>{prefix}主机地址<input value={value.host} onChange={e => onChange({ ...value, host: e.target.value })} placeholder="IP 或域名" /></label><label>{prefix}端口<input type="number" min={1} max={65535} value={value.port} onChange={e => onChange({ ...value, port: Number(e.target.value) })} /></label></div>
    <div className="form-grid"><label>{prefix}用户名<input value={value.username} onChange={e => onChange({ ...value, username: e.target.value })} /></label><label>{prefix}认证方式<select aria-label={`${prefix}认证方式`} value={value.auth} onChange={e => onChange({ ...value, auth: e.target.value as JumpHost['auth'] })}><option value="password">密码</option><option value="key">SSH 私钥</option><option value="agent">SSH Agent</option><option value="keyboard-interactive">交互式认证 / OTP</option></select></label></div>
    {value.auth === 'key' && <label>{prefix}私钥文件<div className="input-action"><input aria-label={`${prefix}私钥文件`} value={value.keyPath} onChange={e => onChange({ ...value, keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" /><button type="button" onClick={() => void pickKey().then(p => { if (typeof p === 'string') onChange({ ...value, keyPath: p }); }).catch(e => onError(String(e)))}>选择</button></div></label>}
    {value.auth === 'key' && <p className="subtle">选择私钥文件，而非 .pub 公钥。若使用账号、密码和 OTP 登录，请改选“交互式认证 / OTP”。XShell 专用密钥格式需先导出为 OpenSSH。</p>}
    {value.auth === 'keyboard-interactive' && <p className="subtle">适用于堡垒机、OTP 和动态口令。连接后显示服务器认证提示。</p>}
    {value.auth === 'agent' && <p className="subtle">使用本机 SSH Agent 中的密钥完成签名。Windows 使用 OpenSSH Agent；macOS / Linux 使用 SSH_AUTH_SOCK。</p>}
  </>;
}

export function CredentialFields({ auth, value, onChange, prefix = '' }: { auth: JumpHost['auth']; value: Credentials; onChange(value: Credentials): void; prefix?: string }) {
  if (auth === 'keyboard-interactive') return <p className="subtle">{prefix}连接后按服务器提示输入密码或验证码，每轮回答仅用于本次认证。</p>;
  if (auth === 'agent') return <p className="subtle">{prefix}使用本机 SSH Agent，无需输入密码或私钥口令。</p>;
  if (auth === 'key') return <label>{prefix}私钥口令<input type="password" value={value.passphrase} onChange={e => onChange({ ...value, passphrase: e.target.value })} placeholder="未加密的私钥可留空" /></label>;
  return <><label>{prefix}密码<input type="password" value={value.password} onChange={e => onChange({ ...value, password: e.target.value })} placeholder="留空使用已保存的密码" /></label><label className="check-row"><input type="checkbox" checked={value.remember} onChange={e => onChange({ ...value, remember: e.target.checked })} />{prefix}保存到系统凭据存储</label></>;
}
