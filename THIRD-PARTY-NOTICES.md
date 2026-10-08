# 第三方组件声明（THIRD-PARTY NOTICES）

DGO 封装并使用以下开源组件。各组件归其原作者所有，本文件按其许可证要求提供许可声明与源码链接。

| 组件 | 用途 | 许可证 | 源码 |
|---|---|---|---|
| yt-dlp | 视频/音频下载引擎 | The Unlicense | https://github.com/yt-dlp/yt-dlp |
| gallery-dl | 图站/媒体下载引擎 | **GPL-3.0** | https://github.com/mikf/gallery-dl |
| FFmpeg | 音视频合并/抽轨/转封装 | LGPL-2.1 / GPL（依构建分支） | https://ffmpeg.org/download.html |
| whisper.cpp | 本地语音转写 | MIT | https://github.com/ggml-org/whisper.cpp |
| Electron | 应用框架 | MIT | https://github.com/electron/electron |
| Node.js | 运行时 | MIT | https://github.com/nodejs/node |

## 分发方式说明

- **yt-dlp / whisper.cpp / bili-probe（本项目自研探针）**：随安装包分发。
- **gallery-dl（GPL-3.0）**：自 v0.9.1 起**不再随安装包内嵌**。首次使用图站类功能时，DGO 会在征得用户同意后，从 gallery-dl 官方 GitHub Release 直接下载原始二进制并校验后交由用户设备保存。该下载行为由用户发起，DGO 不修改、不捆绑、不镜像该组件。
- **FFmpeg**：安装包不含 FFmpeg；首次需要音视频合并/转写时按上述方式由用户从官方构建源下载。
- gallery-dl 与 FFmpeg 作为独立进程被调用，与 DGO 主程序之间仅有命令行参数级的数据交换，属于 GPL 认可的「聚合（mere aggregation）」关系；DGO 主程序源码不受 GPL 约束，但严格遵循上述组件各自的许可证义务（保留版权声明、提供源码链接）。

## 许可证全文链接

- GPL-3.0：https://www.gnu.org/licenses/gpl-3.0.html
- LGPL-2.1：https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html
- MIT / The Unlicense：随各组件源码仓库分发
