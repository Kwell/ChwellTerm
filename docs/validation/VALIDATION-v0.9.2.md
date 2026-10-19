# v0.9.2 验证记录

产品正式命名为 **ChwellTerm**。窗口标题、浏览器标题、设置页版本、Windows EXE 产品元数据 / 安装包、macOS 应用 / ZIP 和 CI 产物名称同步更新。沿用当前图标与布局。

为保留已有用户数据，应用标识 `dev.terminalworkbench.app`、系统凭据服务名 `terminal-workbench` 和浏览器存储键 `terminal-workbench-v1` 保持兼容。Rust 包 / 库内部名称保留，显式二进制目标改为 `chwellterm`。历史版本与归档保留原名。

## 验证结果

- Tauri 官方打包器起初发现既有 NPM / Rust 小版本不匹配，拒绝构建。将 `@tauri-apps/api` 固定为 2.11.1、`@tauri-apps/plugin-dialog` 固定为 2.7.2，匹配既有 Rust tauri 2.11.5 / dialog 2.7.2；没有升级 Rust 依赖或绕过版本检查。
- 对齐依赖后，`pnpm test`：6 个文件、46 项测试全部通过。
- `pnpm desktop:build --bundles nsis --ci -- --locked`：TypeScript、Vite 生产构建、Rust release 编译与 NSIS 安装包生成全部通过。官方 NSIS 工具下载时完成哈希验证。
- 核对生产 HTML 标题和 JS 设置页文案均为 ChwellTerm；前端、Tauri 和 Cargo 版本均为 0.9.2。
- 核对旧版应用标识、浏览器存储键及系统凭据读写服务名仍一致；没有读取用户配置内容、凭据或私钥，也没有连接用户服务器。
- Windows EXE 的 ProductName / FileDescription 均为 ChwellTerm，FileVersion / ProductVersion 均为 0.9.2。
- Windows 构建脚本 PowerShell 语法解析通过。macOS 脚本中的应用、二进制与 ZIP 名称已更新；本机没有实际构建或验证 macOS 应用。

此次为命名与打包配置修改，没有启动或安装新版本、关闭已有应用，未做新的原生界面或 SSH / SFTP 实机验收。旧版功能测试记录继续见前序验证文档。

## 交付文件

- 独立程序：`output/windows/ChwellTerm-v0.9.2.exe`
- 安装程序：`output/windows/ChwellTerm_0.9.2_x64-setup.exe`
- 程序、安装包、源码和文档归档：`output/releases/v0.9.2/`

SHA256：

```text
7E6B826A44A37E4CC178CDFE5B806C01C973954C13DD3C424D0D8DB589D07CBB  ChwellTerm-v0.9.2.exe
B0A783DA3DB2B51BA2841F6E3FC76284899159FDA874B94230B75F853C7660EF  ChwellTerm_0.9.2_x64-setup.exe
```

## 后续验收

在已有数据的本机环境手动打开新版本，检查窗口标题、设置页名称和旧会话显示。安装包可在隔离环境验收安装 / 卸载与快捷方式。macOS 继续按 `MACOS.md` 完成 Universal 构建及实机验收。
