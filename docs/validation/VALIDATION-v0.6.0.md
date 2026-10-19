# v0.6.0 验证记录

日期：2026-10-13，Windows。

## 新增行为

工具栏新增四宫格入口，最多同时显示 4 个独立终端，标签总数仍为 32。保留原有单终端、左右 / 上下双分屏。3 个标签时显示 3 个终端与空面板复制连接入口；切换面板焦点不改变排列，输入、命令、搜索、日志及文件面板按活动标签处理。面板下拉框可显示打开的任意标签：已显示时交换两个位置，隐藏时替换对应面板。

左右 / 上下分隔条分别调整两组比例（20%–80%）；支持鼠标、键盘、Home / End、双击复位。比例和窗口变化由 ResizeObserver 同步 xterm 尺寸与 PTY。终端组件保留，布局、面板选择与激活不触发重连。关闭标签后清理并补入隐藏标签，少于两个时使用单终端。

工作空间新增可选 paneTabIds 与 rowRatio 字段，保存四宫格位置、当前标签及两个比例，恢复映射到新标签 ID，缺失会话跳过，其余保持。恢复后手动连接，不保存终端内容、密码或 OTP。旧配置没有新字段时按旧方式工作。宽度不超过 700px 时四宫格按面板顺序纵向排列、滚动浏览，比例控制隐藏，回到宽屏恢复比例。

## 自动检查

- `pnpm test`：30 项通过。新增 5 项面板逻辑测试覆盖去重、保序、隐藏 / 新标签替换、显示标签互换和关闭补位；新增 3 项工作空间测试覆盖排列 / 活动标签 / 比例 / 新 ID 的保存恢复、非法引用 / 重复 / 超限 / 比例拒绝、删除会话与默认值。已有 22 项通过。
- `pnpm build`：TypeScript 与前端生产构建通过。
- `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml`：26 项通过。新增四宫格字段持久化、标签引用 / 去重 / 数量 / 比例验证；原有本地 PTY、SSH、Agent、OTP、单跳、SFTP、远程编辑及配置测试通过。
- `scripts/qa/grid-panels-smoke.cjs`：Edge、真实 React / xterm、模拟 Tauri IPC。验证不足两个时提示、3 / 4 面板、空面板独立复制、第五标签替换当前槽位、点击后位置不动及输入目标、下拉框交换、两条分隔条拖拽 / 键盘 / 复位、每终端尺寸同步、布局不重连、命名保存 / 追加打开 / 启动待连接恢复、深浅主题、600px 窄窗口顺序与连接按钮不截断、单 / 四宫格切换、手动仅连接对应标签、关闭清理及无运行时异常。
- `connection-ui-smoke.cjs`、`workspace-ui-smoke.cjs`、`remote-editor-smoke.cjs`、`terminal-background-smoke.cjs`：原有连接、分屏、认证、传输进度、工作空间、远程编辑和终端背景界面回归通过（模拟 IPC）。
- 人工查看：`artifacts/v060-grid-three.png`、`v060-grid-dark.png`、`v060-grid-light.png`、`v060-grid-restored.png`、`v060-grid-narrow.png`。

## 边界

首批多面板为四宫格，没有任意嵌套 / 超过四个同时显示的面板。同一 SSH 连接追加 shell 未实现；复制连接创建新的连接并单独认证。当前测试不等于四台用户服务器的实际登录验收。

v0.6.0 可读取旧配置；保存 grid 工作空间后，v0.5.0 及更早版本无法解析新布局，请使用新版。用户实际堡垒机和 macOS 双架构编译 / 实机验证仍待完成。传输队列、暂停 / 续传、高级 SSH、签名 / 公证和自动更新尚未实现。

## Windows 交付

`cargo build --release --features custom-protocol --locked --manifest-path src-tauri/Cargo.toml` 通过。停止预览服务器后独立程序正常打开，版本 0.6.0、已有会话加载；捕获窗口可见本地 PowerShell 提示符。DWM 深色标题栏属性 1，窗口实际图标源为 256×256。截图：`artifacts/v060-windows-desktop.png`。

程序：`output/windows/TerminalWorkbench-v0.6.0.exe`；SHA256：`1D628CD7477C8198903E269AC0BBB2DC8688898B1F8096E900EB3F16E4EA8C07`。源码 / 文档 / 程序和校验值归档于 `output/releases/v0.6.0/`，旧版保留。
