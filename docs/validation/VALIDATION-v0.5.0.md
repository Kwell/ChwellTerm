# v0.5.0 验证记录

日期：2026-10-13，Windows。

## 新增行为

SFTP 文件列表选中文件点击“编辑”或双击打开 UTF-8 普通文件。独立编辑窗口显示会话 / 路径、字节 / 行数、LF / CRLF 选择、BOM 状态，支持 Ctrl S / Command S 保存。未经修改不能保存。关闭编辑窗口或重新读取会确认未保存修改；保存失败 / 远端冲突保留草稿。连接断开后禁止保存，允许复制草稿；其他会话出现指纹 / 交互认证弹窗时保持编辑器挂载，草稿不会被重建。

编辑 SFTP 通道按需从原已认证 SSH 连接打开，沿用已有单跳链路，无需再次读取凭据或执行远端命令。同一连接的编辑读写串行处理，每次协议响应超时 10 秒，通道建立限时 10 秒。编辑任务参与现有终端关闭 / 取消登记。

保存检查原文件写入权限，比较远端内容 SHA256 与 size / permissions / uid / gid / mtime；临时文件和备份完成后再次检查。临时文件以排他创建和 0600 权限开始，逐块确认写入，再恢复普通权限、属主 / 属组并核对大小 / 属性。原内容备份放在同目录 `.twb-<UUID>.bak`，保留并显示路径。提交使用 `posix-rename@openssh.com`；不删除或截断原文件作为回退。写入、属性和替换失败时清理临时文件，清理失败显示路径；完整备份保留供核对 / 恢复。

## 自动检查

- `pnpm test`：22 项通过。新增 3 项覆盖 UTF-8 中文字节数、BOM、CRLF、末尾换行、空文件、混合换行识别和转换。
- `pnpm build`：TypeScript 与 Vite 生产构建通过。
- `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml`：25 项通过。新增 6 项编辑验证覆盖 SFTP 协议读写、BOM / CRLF、精确原内容备份、连续保存 / 空文件、过期版本拒绝、保存过程中外部修改、非 UTF-8 / 二进制 / 过大 / 链接 / 目录拒绝、写入 / 权限 / 替换 / 备份失败及临时文件清理、不支持原子替换扩展、写入中途取消。另通过本地真实 SSH 单跳链路按需打开编辑 SFTP 通道，保存后继续终端数据交互。既有 PTY、SSH、OTP、Agent、SFTP、单跳与配置测试均通过。
- 编辑文件系统为隔离的内存测试服务器，SSH 集成使用随机本地回环端口与随机测试密钥；没有连接用户服务器或读取用户私钥。协议验证不代替用户服务器的权限 / 扩展支持验收。
- `scripts/qa/remote-editor-smoke.cjs`：Edge、真实 React/xterm、模拟 Tauri IPC。通过编辑入口、目标标签 / 路径绑定、BOM / CRLF、Ctrl S / Command S、备份路径、未保存关闭 / 重读确认、其他会话指纹弹窗后的草稿保持、冲突 / 写入失败草稿保持、二进制 / 大文件拒绝、UTF-8 字节上限、读取中关闭按钮禁用、断开后草稿、配置不含草稿、深浅主题、768px 窗口及运行时异常检查。
- `scripts/qa/connection-ui-smoke.cjs`、`workspace-ui-smoke.cjs`、`terminal-background-smoke.cjs`：已有连接、工作空间、分屏、认证、SFTP 进度及黑条修复的界面回归通过（模拟 IPC）。
- 人工检查：`artifacts/v050-editor-dark-conflict.png`、`v050-editor-light.png`、`v050-editor-narrow.png`。

## 边界及后续

首批为单文件基础文本编辑器，限 1 MiB UTF-8 普通文件。特殊权限文件拒绝编辑保存，混合换行修改后统一为所选格式并提示。服务器需支持 POSIX rename 扩展、原文件写入及同目录临时 / 备份创建，并允许保留普通权限和 UID / GID。

SFTP v3 缺少跨客户端 compare-and-swap；两次检查无法消除最后检查到替换之间的外部写入竞争。不保证扩展 ACL / xattr、硬链接关系或断电持久性。没有多文件标签、语法高亮、更多编码或草稿持久化；关闭整个应用会丢失未保存内容。备份需用户按需清理。

用户实际堡垒机验收、Mac Universal 编译和双架构实机验收仍待完成；多面板、同一 SSH 连接追加 shell、批量传输队列及续传、签名 / 公证 / 自动更新尚未实现。

## Windows 交付

`cargo build --release --features custom-protocol --locked --manifest-path src-tauri/Cargo.toml` 通过。停止预览服务器后独立程序正常启动，窗口显示 0.5.0，已有会话加载；DWM 深色标题栏属性 1，窗口实际图标源 256×256。截图：`artifacts/v050-windows-desktop.png`。

程序：`output/windows/TerminalWorkbench-v0.5.0.exe`；SHA256：`3FC654B369A04CF0CBB6B53DAFDF200A62A6D254002ED40DDFB9E69909F50822`。程序、源码和文档归档在 `output/releases/v0.5.0/`，旧版归档保留。
