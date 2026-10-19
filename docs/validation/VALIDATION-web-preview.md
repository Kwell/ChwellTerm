# ChwellTerm 网页预览修复 · 2026-10-15

用户报告 ChwellTerm 网站卡片打开为空白；截图未包含卡片的实际目标 URL，因此无法确定旧卡片具体打开了哪个入口。

## 已确认的问题和修改

- 旧开发服务日志记录 EBUSY 错误：Vite 监听到 `src-tauri/target/.../WebView2LoaderStatic.lib`，遇到 Windows 构建文件占用后进程退出。检查时 1420 / 1421 均没有网页服务监听。
- Vite 排除 `src-tauri`、`.tools`、`output`、`artifacts`，避免监听构建、归档和日志目录；已重新启动开发服务。
- Vite 使用相对资源基路径，使普通静态构建可以部署到子目录。
- 增加 `pnpm web:build`：生成包含 JavaScript、CSS 与 favicon 的 `output/web/ChwellTerm.html`，避免直接打开项目源码 HTML 时依赖 TSX 和外部资源。普通静态部署仍使用完整 `dist/`。

## 验证

- `pnpm web:build` 通过；生成的单文件约 711 KB，已静态检查无外链脚本或构建 CSS，图标为 data URL。
- `pnpm build` 通过 TypeScript 和 Vite 生产构建。
- 实际浏览器访问开发入口 `http://127.0.0.1:1420/` 和生产预览 `http://127.0.0.1:1421/` 均显示完整工作台。
- 生产构建重新加载后，打开设置可见 `ChwellTerm · v0.9.2`，关闭设置恢复工作台；浏览器错误日志为空。
- 构建完成后两个 HTTP 入口仍返回 200；开发服务错误日志为空，未再次发生原监听崩溃。
- 截图：`artifacts/chwellterm-web-fixed.jpg`。
- 浏览器工具不允许 `file://` URL，故没有在该工具中完成独立 HTML 的直接双击验证；没有尝试绕过该限制。上述实际界面验证针对正常 HTTP 开发及生产入口。

保留本地预览服务供用户打开。此次未改变 SSH / SFTP 或桌面程序，不重新生成 Windows 安装包。
