# v0.3.1 验证记录

日期：2026-10-12，Windows 开发环境。

## 自动验证

- `pnpm test`：13 项通过，包含目标 / 跳板交互认证配置与导入、导出剔除 OTP / 回答、未支持回退顺序拒绝导入。
- `pnpm build`：TypeScript 和生产构建通过。
- `cargo test --lib --manifest-path src-tauri/Cargo.toml`：14 项通过。
- 本地随机端口 russh 测试服务器：零输入项 → 用户名 / 密码（echo 各异）→ OTP 三轮；单独 OTP；跳板与目标独立认证；认证后终端和 SFTP 可用。
- 错误 OTP、取消、连接 future 被丢弃、用户回答超时均清理 pending_auth；请求不能跨标签、重复消费或提交错误数量。
- 第二因子续接：russh 0.63 测试服务器在密码 / 公钥 Reject 分支会强制重置 partial_success=false，故通过构造 AuthResult 验证决策，再通过真实加密 SSH 完成 OTP 与会话开通。此用例不等同于实际 OpenSSH / 堡垒机完整 MFA 实测。
- `scripts/qa/connection-ui-smoke.cjs`：Edge + 真实 React/xterm + 模拟 Tauri IPC；原有导入、分屏、传输、跳板、Agent 回归以及新增 OTP 多轮、零提示、echo、显示内容、Enter、Escape、取消、重连、回答清空、配置 / 诊断无回答、深浅主题均通过。
- 深浅认证截图已人工检查：`artifacts/v031-otp-dark.png`、`artifacts/v031-otp-light.png`。

## 构建及原生检查

Windows 独立 release 使用 custom-protocol，内嵌生产资源，不依赖开发服务器。原生启动通过：窗口显示 v0.3.1、已有会话正常加载；DWM 深色标题栏属性为 1，任务栏图标源尺寸 256×256。截图：artifacts/v031-windows-desktop.png。

## 实测范围

未连接用户真实跳板机，未访问用户私钥，未改动系统 SSH Agent 服务。macOS Unix 认证逻辑复用，但当前 Windows 环境未进行 macOS 编译或实机验收。

## 使用验收

1. 编辑堡垒机会话，选择“交互式认证 / OTP”，按服务器提示填写验证码。
2. 多轮认证每轮输入 / 显示状态重置；失败或取消可重新连接。
3. 若设置跳板，弹窗明确显示当前跳板 / 目标地址和用户名。
4. 验证成功后使用终端与 SFTP；诊断和导出配置均不包含认证回答。

`output/releases/v0.3.1/` 保留程序、源码 ZIP、文档和 SHA256；v0.3 归档保留。
