# v0.9.0 验证记录

日期：2026-10-15，Windows。

## 本轮功能

上传支持运行中暂停与继续，后端确认当前写入块、保存内存断点后，串行队列才启动其他文件。断开后在原标签重新认证，再手动继续；切换活动会话或远端目录不会改变已捕获的任务目标，继续不重新弹出文件选择框。

使用同目录独立 `.twb-upload-<随机 ID>.part`，完成前不创建最终目标。初次及每次继续核对本地完整 SHA256；实际目标 / 跳板主机、端口、用户名、接受的指纹、原标签及文件路径绑定断点。续传读取远端临时文件，与本地原始内容前缀校验，再定位续写；网络写入确认失败留下的尾部只有与已校验源文件匹配时才采纳。发布前核对传输摘要、远端完整读回摘要及重新打开的本地源文件摘要。使用 SFTP v3 标准 RENAME，拒绝覆盖现有目标，不使用 POSIX rename。

取消时核对临时文件类型、大小、已确认内容 SHA256 后删除，不依赖本地源文件仍存在。清理失败或远端临时文件改变时，保留断点及具体路径，重连后可重试取消；关闭标签等待取消完成，上传清理失败时保留原标签，避免丢失操作入口。未开始的等待 / 暂停任务可以直接取消。暂停项不被“清除已结束”移除。

## 检查结果

- `pnpm test`：46 项通过，新增 4 项覆盖运行上传暂停 / 队列释放、重连续传、重试失败仍保留断点、清理失败拒绝关闭、清理完成才关闭。
- `pnpm build`：TypeScript 与生产前端构建通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：42 项通过。新增 9 项使用真实 SFTP 数据包的隔离服务，覆盖暂停 / 精确续传、新连接恢复、身份 / 路径保护、同大小本地变化、源路径重读、远端临时文件篡改、取消清理不依赖本地源、同名目标和最终发布竞争、空文件、发布失败、清理拒绝及重连重试、未确认尾部校验。原 SSH / OTP / Agent / 跳板 / 编辑 / 下载回归通过。
- `scripts/qa/upload-resume-smoke.cjs`：Edge、真实 React / xterm、模拟 Tauri IPC。验证上传暂停释放队列、原 ID / 原标签 / 原路径继续、临时路径展示、断开禁用继续、清理失败保留标签 / 任务、手动重连后继续、源文件变化错误、取消与关闭等待清理、主题 / 窄窗口、无运行异常 / 重叠传输、断点不持久化。
- `download-resume-smoke.cjs`、`transfer-queue-smoke.cjs`、`connection-ui-smoke.cjs`、`workspace-ui-smoke.cjs`、`remote-editor-smoke.cjs`、`grid-panels-smoke.cjs`、`terminal-background-smoke.cjs`：7 组已有界面回归通过（模拟 IPC）。下载续传脚本同步允许运行上传暂停入口。
- 已查看截图：`artifacts/v090-upload-dark.png`、`v090-upload-light.png`、`v090-upload-narrow.png`。

## 边界

断点仅本次应用运行有效，退出后不能恢复。暂停 / 中断上传占远端空间，退出整个应用不保证异步删除，退出前应取消任务；强制终止 / 崩溃或创建响应丢失时可能遗留临时文件，可按显示路径手动检查。关闭单个标签与退出整个应用是不同流程，前者等待清理并保留失败入口。

服务器需允许同目录创建 / 读取 / 写入 / 删除临时文件及标准 RENAME，并提供普通文件类型与大小。完整 SHA256 校验增加本地读取和网络读回成本，速度仅统计本轮传输，校验时单独显示状态。当前写入块等待确认或网络超时后响应暂停，避免不受控的后台写入。若最终 RENAME 已执行但网络响应丢失，界面无法确认完成，需检查目标和临时路径；不会自动覆盖重试。最终检查和删除之间仍有外部修改窗口；依赖服务器遵循 SFTP v3 不覆盖 RENAME 语义，不承诺断电持久性。

未连接用户实际堡垒机。macOS Universal 编译、Intel / Apple Silicon 实机仍待验收，远程 CI 未运行。

## Windows 交付

程序：`output/windows/TerminalWorkbench-v0.9.0.exe`；源码、程序、文档和校验值归档：`output/releases/v0.9.0/`。旧版保留。

`cargo build --release --features custom-protocol --locked --manifest-path src-tauri/Cargo.toml` 通过。停止预览服务器并确认 1421 无监听后独立启动，原生窗口显示 0.9.0，已有保存会话加载且未连接服务器。DWM 深色标题栏属性为 1，实际窗口图标源 256×256；已查看 `artifacts/v090-windows-desktop.png` 和 `artifacts/taskbar-v090.png`。

Windows 程序 SHA256：`1FA25AFA5637FAC41B2885E8783E523376A7DBB739DB0EAEAE9286FE9B3DE8DF`。
