# v0.4.1 验证记录

日期：2026-10-13，Windows。

## 修复

xterm 6 的实际滚动由 `.xterm-scrollable-element` 承担，但保留的旧 `.xterm-viewport` 被 vendor CSS 设为纯黑并拉伸至整个终端高度。文字区域按整行计算高度，末尾不足一行的空隙会露出旧层背景，同时旧层产生多余的原生滚动条。

修复前复现：终端高度 678.33px，文字区 672px，留下 6.33px 纯黑空隙。截图：`artifacts/v040-terminal-strip-before.png`。

应用样式覆盖旧层背景为当前主题，关闭旧层原生滚动；实际历史滚动层保留。终端创建时即设置主题，避免首次绘制使用默认背景。xterm CSS 在应用样式之前导入。

## 自动检查

- `pnpm build`：TypeScript 和前端生产构建通过。
- `pnpm test`：19 项配置 / OpenSSH 导入 / 工作空间测试通过。
- `scripts/qa/terminal-background-smoke.cjs`：Edge、真实 React/xterm、模拟 Tauri IPC。深浅主题 × 1440×903 / 1080×807 / 768×707 共 6 种组合通过；末尾 5.67–9.67px 空隙与主题背景一致，无旧原生滚动条。200 行测试输出可通过滚轮回看，实际滚动条位置向上移动。左右 / 上下分屏、比例调整后检查通过，页面无运行时异常。
- `scripts/qa/connection-ui-smoke.cjs`：连接、认证、OTP、跳板、Agent、配置导入、SFTP 进度、分屏和响应式布局界面回归通过（模拟 IPC）。
- `scripts/qa/workspace-ui-smoke.cjs`：工作空间保存、恢复、复制连接、更新、重命名、删除、启动恢复开关与深浅主题回归通过（模拟 IPC）。
- 人工检查：`artifacts/v041-terminal-dark-1440.png`、`v041-terminal-light-1440.png`、`v041-terminal-split-1.png`，底部背景连续。

本次没有修改 Rust 连接逻辑，未重新运行真实 SSH / SFTP 后端测试；这些行为此前验证见 `VALIDATION-v0.4.0.md`。

## 交付范围

`cargo build --release --features custom-protocol --locked --manifest-path src-tauri/Cargo.toml` 通过。Windows 独立 release 内嵌前端，停止预览服务器后原生窗口正常打开，显示版本 0.4.1，已有会话加载；DWM 深色标题栏属性为 1，实际窗口图标源为 256×256。截图：`artifacts/v041-windows-desktop.png`。

程序：`output/windows/TerminalWorkbench-v0.4.1.exe`，SHA256：`86117C8B05845DF8F5D99F9B7BEA61B61F9A3F2DED9E77DA394B0C79790D40FA`。源码及文档归档于 `output/releases/v0.4.1/`，旧程序及归档保留。macOS 共享同一前端修复，但本环境未完成 Mac 编译或实机验收；用户实际堡垒机验收仍待完成。
