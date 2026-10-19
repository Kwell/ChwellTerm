# macOS 构建与验收

当前 Windows 环境已准备 macOS 构建入口，尚未生成或验证 Mac 应用。仓库未配置 Git 远程地址，GitHub Actions 也尚未运行。

## 本地构建

需要 macOS、Xcode Command Line Tools、Node.js 22+、pnpm 11.25.0、Rust stable。先安装工具，再在源码目录执行：

```sh
bash scripts/build-macos.sh --check
bash scripts/build-macos.sh
```

脚本会运行配置 / 工作空间 / 面板 / 传输队列 / 远程文本测试、Rust 本地 PTY / SSH / SFTP / 编辑 / Agent / OTP 测试，构建包含 arm64 和 x86_64 的 Universal 应用，并用 lipo 验证两个架构。应用名为 `ChwellTerm.app`，产物为 `ChwellTerm-v0.9.2-universal.zip`、`.dmg` 和 SHA256，位于 `output/macos/v0.9.2/`（目录与 ZIP 名跟随 package.json 版本）。

脚本不设置 Developer ID 签名或公证参数；正式签名、公证与发布尚未配置。

## 自动构建

`.github/workflows/build.yml` 的 macOS 作业运行上述同一脚本，并上传校验后的 ZIP、DMG 和 SHA256。Windows 作业生成 NSIS 安装包。需要把源码提交到自己的 GitHub 仓库后，通过 Desktop build 的 workflow_dispatch 执行。

## 实机验收

分别在 Apple Silicon 和 Intel Mac 上完成以下项目；Universal 架构检查不能代替实机验收。

1. 从 DMG 安装并启动，断开开发服务器后仍能打开；深浅主题、图标与字体正常。
2. 本地终端默认启动系统登录 shell，输入、中文、缩放和关闭正常。
3. SSH 密码 / 加密私钥 / OTP 登录；主机指纹确认和取消、诊断、重连正常。
4. 从图形界面启动时验证 SSH Agent。应用进程需能获得 `SSH_AUTH_SOCK`，工具不代为添加私钥或开启服务。
5. 密码勾选保存后重连，验证 macOS Keychain 存取；OTP 不保存。
6. 单跳终端与 SFTP、多选上传、复选框多选下载、目录选择、串行队列和各项取消正常；同名本地文件 / 大小写冲突不得覆盖，关闭源会话取消关联项，其他会话继续。
7. 工作空间保存、启动恢复、分屏与重复连接正常；恢复后的 SSH 等待手动连接和认证。
8. Command F / Command K、文件选择和窗口主题正常。
9. 双击 SFTP 文本文件编辑，Command S 保存；BOM / CRLF、远端冲突、原内容备份、未保存关闭和断开后草稿复制正常。
10. 四宫格中 3 / 4 个终端分别输入、切换焦点和选择标签；两方向比例、PTY 尺寸、启动待连接恢复、窄窗口滚动及关闭回到单终端正常。

11. 下载暂停、队列继续其他项、原标签重新认证后手动续传、取消 / 关闭清理临时文件；远端内容 / 本地目标改变时拒绝提交，深浅主题与窄窗口正常。

12. 运行上传暂停 / 继续、断网后原标签手动续传、源文件变化 / 临时文件篡改 / 同名目标保护；取消删除远端临时文件，删除失败时保留任务与原标签，重连后重试清理。退出应用后不恢复断点，先取消或记录临时文件路径。

将设备架构、macOS 版本、应用版本及结果记录到验证文档。签名、公证与升级另行验收。
