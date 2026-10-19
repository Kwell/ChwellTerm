# v0.3.2 验证记录

2026-10-12，Windows。

## 问题与修改

截图报“跳板机：读取私钥失败：Could not read key”，说明连接正在使用跳板机私钥认证。用户确认实际登录方式为账号 / 密码 + OTP，应改用交互式认证；若直接登录堡垒机菜单，则不额外配置 TCP 转发跳板。没有读取用户私钥，也没有改动用户会话或连接真实服务器。

修复重连使用标签旧配置的行为：保存会话后，原标签重新连接读取最新会话配置并更新连接信息。新增断开状态“编辑连接”入口与私钥 / OTP 使用说明。

私钥加载在 TCP 连接前进行，检查路径、目录、文件大小、编码、公钥误选、SSH2 / XShell 专用格式、解析和解密错误；中文消息标明目标或跳板。兼容路径外层引号和 UTF-8 BOM。文件缓冲与口令副本使用 Zeroizing；错误不包含私钥正文或口令。保留 russh 既有 OpenSSH / PEM / PPK 解析能力，不增加专用格式转换。

## 验证

- `pnpm test`：13 项通过。
- `pnpm build`：通过。
- `cargo test --lib --manifest-path src-tauri/Cargo.toml`：18 项通过。
- 新增私钥测试：缺失路径、目录、空文件、公钥、SSH2 专用格式、损坏内容、大小限制、编码、UTF-8 BOM、中文空格与引号路径、加密私钥缺少 / 错误 / 正确口令。仅使用测试生成密钥。
- 新增真实 SSH 测试：目标和跳板分别使用加密 Ed25519 私钥，两个指纹确认后终端及 SFTP 就绪；坏私钥在任何 TCP 操作前失败，OTP 忽略遗留私钥路径。
- Edge UI 回归（真实 React/xterm + 模拟 Tauri IPC）：原有功能和 OTP 测试通过；增加原标签认证由 OTP 改成私钥，再编辑保存为 OTP，重连使用最新设置且标签 ID 保持一致。
- 操作截图：`artifacts/v032-auth-guidance.png`。
- Windows custom-protocol 独立 release 构建，原生启动通过：窗口显示 0.3.2、已有会话加载，DWM 深色标题栏属性 1，任务栏图标源 256×256。截图：artifacts/v032-windows-desktop.png。

## 验证范围

尚未连接用户实际堡垒机；macOS 尚未编译或实机验证。MFA partial-success 续接验证的测试库限制见 `VALIDATION-v0.3.1.md`。

程序、源码 ZIP、文档与 SHA256 归档到 `output/releases/v0.3.2/`；旧版本保留。
