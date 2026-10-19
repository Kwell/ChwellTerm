# v0.4.0 验证记录

日期：2026-10-13，Windows。

## 新增行为

命名工作空间记录标签顺序（允许重复会话）、活动标签、第二分屏标签、双分屏方向和比例、文件面板开关。保存、打开、重命名、确认更新和确认删除均有真实入口。打开布局会添加待连接标签，保留已有连接；启动恢复默认关闭，开启后恢复上次布局。恢复引用最新已保存会话，删除的会话跳过并提示。复制连接通过现有认证流程建立独立终端。

工作空间仅保存会话 ID 和布局；不保存凭据、OTP、终端文本、广播状态、远端进程或命令执行状态。JSON 导入合并命名工作空间及会话，已有 ID 不覆盖，保留本机设置及上次布局。新增字段兼容旧 v1 配置；旧版程序回写配置会丢弃工作空间字段。

## 自动检查

- `pnpm test`：19 项通过（配置 6、OpenSSH 7、工作空间 6）。覆盖旧配置默认值、重复会话顺序、秘密字段剔除、最新会话设置、删除会话跳过、活动标签回退、布局范围 / 数量 / ID 校验、导入合并。
- `pnpm build`：TypeScript 与生产构建通过，无 CSS 语法警告。
- `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml`：19 项通过。新增 Rust 配置持久化、布局验证、旧配置加载和秘密字段剔除；既有本地 PTY / SSH / SFTP / OTP / 单跳 / Agent 测试通过。
- `scripts/qa/workspace-ui-smoke.cjs`：Edge + 真实 React/xterm + 模拟 IPC，通过命名保存、启动恢复、比例 / 文件面板 / 活动标签恢复、打开保留原标签、第二面板正确恢复、用户重新认证、复制独立连接、更新 / 重命名、重复标签重启保持、缺失会话、删除确认 / 取消、恢复开关、深浅主题、运行时错误检查。恢复过程中 start_terminal 调用为零，配置无密码 / 终端内容。
- `scripts/qa/connection-ui-smoke.cjs`：原有连接、认证修复、OTP、跳板、Agent、配置导入、SFTP 进度、分屏与响应式布局回归通过。
- 人工检查：`artifacts/v040-workspace-dark.png`、`v040-workspace-restored.png`、`v040-workspace-light.png`。

## macOS 进度

新增 `scripts/build-macos.sh`、`MACOS.md`，CI macOS 作业使用同一本地脚本。脚本检查依赖，运行测试，构建 arm64 + x86_64 Universal 应用，验证 lipo 架构，输出 APP ZIP、DMG 和 SHA256。shell 语法检查通过；用隔离临时目录和模拟命令验证正常流程、仅检查依赖、非 Mac 拒绝执行、架构校验失败、缺失 DMG 共 5 个分支。模拟不替代 Mac 编译。

本工作区未配置 Git 远程仓库，未运行 Actions，未生成 macOS 应用，未实机验证或配置正式签名 / 公证。

## Windows 交付

使用 custom-protocol 的独立 release 内嵌前端资源。原生启动检查通过：窗口显示 0.4.0、已有会话加载；DWM 深色标题栏属性 1，任务栏图标源尺寸 256×256。截图：artifacts/v040-windows-desktop.png。旧程序与归档保留。

## 未完成项目

真实用户堡垒机验收、Mac 构建与双架构实机验收；更多分屏、远程编辑、传输队列和续传；高级 SSH、签名 / 公证 / 自动更新。未访问用户私钥或连接真实用户服务器。
