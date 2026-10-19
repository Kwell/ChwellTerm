# v0.9.1 验证记录

移除应用内部重复的图标、名称与版本标题行，保留系统原生标题栏。工作区增加 48px 高度；连接数量移至底部状态栏，版本号在设置查看。删除不再使用的标题 CSS。

- `pnpm build`：TypeScript 与生产前端构建通过。
- Edge 界面检查：工作区从内容顶部开始，无重复标题；设置能查看 v0.9.1，浏览器预览提示仍显示；深浅主题、760px 窄窗口无横向溢出。已查看 `artifacts/v091-clean-header-dark.png`、`light.png`、`narrow.png`。
- `terminal-background-smoke.cjs`：深浅主题、三种窗口大小、实际滚动历史、上下 / 左右分屏通过（模拟 IPC）。
- `grid-panels-smoke.cjs`：四宫格布局、焦点、比例、PTY resize、工作空间恢复、窄窗口与关闭操作通过（模拟 IPC）。

本轮为布局修改，未改动 SSH / SFTP 后端功能。macOS 实机仍待验收。

`cargo build --release --features custom-protocol --locked --manifest-path src-tauri/Cargo.toml` 通过。关闭预览服务并确认 1421 无监听后，独立启动 `output/windows/TerminalWorkbench-v0.9.1.exe`；已查看原生窗口截图 `artifacts/v091-windows-desktop.png`，仅系统原生标题栏显示名称与图标，下方直接进入会话 / 工作区。已有会话正常加载，未连接用户服务器。深色标题栏属性 1，窗口图标源 256×256。

程序 SHA256：`FB9342FBDFB4E9504993C54547AA3AF83CAB48B90C9FD46BD9138663167EFDE8`。

程序、源码、文档与校验值归档：`output/releases/v0.9.1/`。历史程序与归档保留。
