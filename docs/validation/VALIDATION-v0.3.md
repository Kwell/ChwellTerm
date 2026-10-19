# v0.3 验证与验收记录

日期：2026-10-12。验证环境：Windows，本地 Rust 1.99、Tauri 2、React、xterm.js；界面自动化使用 Edge headless。

## 交付

- 最新程序：`output/windows/TerminalWorkbench-v0.3.exe`，文件版本与产品版本均为 0.3.0。
- 本阶段归档：`output/releases/v0.3/`，含程序、源码和 SHA256 校验；v0.2 程序和源码归档保留。
- 使用现有 v1 配置格式，新跳板字段可选。应用启动时确认能读取原有会话和主题。

## 已通过验证

| 验证 | 结果和范围 |
| --- | --- |
| `pnpm build` | TypeScript 检查和生产前端构建通过 |
| `pnpm test` | 11 项：配置兼容、Agent/跳板导出清洗、无效端口、多跳拒绝、ProxyJump 别名和 IPv6、跳板独立认证、去重等 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 10 项：真实本地 SSH/PTY/SFTP、密码/私钥、指纹变化拒绝、跳板、Agent 和传输取消清理 |
| 真实跳板连接 | 两台独立 russh SSH 测试服务器；分别确认跳板与目标指纹，中文终端数据和 SFTP 目录经 direct-tcpip 隧道传输 |
| 跳板异常 | 跳板密码错误、转发拒绝、拒绝目标指纹、等待跳板指纹时取消，均停止连接且不初始化 SFTP、清理待确认请求 |
| 真实 Agent 签名 | 隔离 Windows 命名管道运行测试 Agent，加载随机临时密钥，完成真正 SSH 公钥签名认证；空 Agent 和错误用户均拒绝。未启用/修改系统服务，未读取用户私钥 |
| 界面交互 | 模拟 Tauri IPC，真实 React/xterm：跳板表单、两侧凭据、逐跳指纹地址、诊断阶段、Agent 免凭据窗、失败与取消、持久化恢复、ProxyJump 导入和禁用跳板 |
| v0.2 回归 | 导入勾选、重复和未支持代理提示、分屏拖拽/键盘/尺寸同步、传输跨标签与文件面板取消、响应式布局、长会话名无溢出 |
| 独立 Windows 构建 | `cargo build --release --features custom-protocol --manifest-path src-tauri/Cargo.toml` 成功，直接启动程序显示 0.3，无需开发服务器 |
| 原生外观 | 实际窗口深色标题栏 DWM 属性为 1，运行中的任务栏图标源为 256×256，保留上一阶段清晰图标修复 |

## 可复现界面测试

脚本：`scripts/qa/connection-ui-smoke.cjs`。启动 `pnpm preview --port 1421`，安装或指定 Playwright 模块，使用 Edge 浏览器：

```powershell
$env:PLAYWRIGHT_MODULE = '本机 Playwright 模块绝对路径'
node scripts/qa/connection-ui-smoke.cjs
```

可用 `WORKBENCH_PREVIEW_URL` 指定预览地址。截图生成到 `artifacts/`；`v03-jump-editor.png`、`v03-target-fingerprint.png`、`v03-diagnostics.png` 来自模拟 IPC 的交互测试，不作为真实网络连接截图。

## 用户验收建议

1. 编辑会话选择 Agent，确认系统 Agent 中已用 ssh-add 加载密钥，再连接服务器。
2. 为内网主机勾选跳板机，分别设置地址、用户名和密码/私钥/Agent；核对每台主机的指纹。
3. 经跳板操作终端、浏览及传输文件；查看连接诊断，尝试取消连接和失败后的重连。
4. 导入含单跳 ProxyJump 的 OpenSSH config，确认预览中的跳板和认证方式；导出 JSON 应不包含密码和私钥口令。

## 已知范围

- 支持单跳、普通公钥 Agent；尚无多跳、Agent 转发、证书 Agent 认证、Pageant 或自定义 Agent 路径。最多尝试 Agent 前 6 个身份，60 秒总认证超时。
- Windows 生产代码使用 OpenSSH 标准命名管道；本次签名测试在隔离管道进行，未操作用户系统 Agent 服务。
- macOS / Linux 使用 SSH_AUTH_SOCK，源码已接入，尚未在 macOS 编译或实机验证。Universal CI 保留但未运行；签名、公证、安装包和自动更新仍待发布阶段。
- OpenSSH 导入支持的范围及限制见 README；工具不会执行 ProxyCommand / Match exec，也不会自动读取 Include。
- 诊断仅记录连接阶段和失败原因，不记录终端输入、密码或私钥口令；按标签在内存保留，重连重置，关闭标签清除。
