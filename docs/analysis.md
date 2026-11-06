# Oopz 屏幕共享：核对记录与实现边界

检查日期：2026-11-04。仅作本机安装组件识别和官方公开资料核对。

## 已观察到的事实

- 本机安装目录：`C:\Users\<用户名>\AppData\Local\oopz`，入口版本资源显示 `0.88.41`。这是本机版本，不声称是最新版本。
- 存在 `flutter_windows.dll`、`agora_rtc_sdk.dll`、`libagora_screen_capture_extension.dll`、`tencent_trtc_cloud_plugin.dll` 和 `screenShare/screenshare_runner.exe`。
- 文件大小、版本与 SHA-256 见 `local-inventory.json`。该文件是普通文件系统检查记录，不是 REA 反编译证据。
- 官方隐私政策的第三方 SDK 表列出：声网视频 SDK 用于屏幕共享，腾讯云 TRTC SDK 用于实时音频通话。这与安装组件相符，但不等于对实际运行路径的验证。
- 官方用户服务协议第 3.6 条对反向工程、反编译、复制、未授权接入等设有限制，并保留法律允许或书面许可的例外。

## 采取的实现路线

为遵守用户“合法合规”的要求，没有解包其业务代码、反编译二进制、读账户数据、拦截会话、获取服务密钥或调用其后端。没有把 Oopz 的 DLL、图片、商标、界面或代码加入本项目。未修改 Oopz 的安装或配置。

独立实现常见屏幕共享功能，使用浏览器公开的 `getDisplayMedia` / `getUserMedia` / `RTCPeerConnection` 和自行编写的房间信令服务。它不是 Oopz 插件，也不能加入 Oopz 房间。项目名为“同屏小屋”。

REA CLI 的只读 doctor 可运行，但当前会话未连接 REA MCP，且没有原生反编译引擎。没有为此改动 Codex 配置或安装引擎。由于采用上述路线，后续开发不依赖这些工具。

## 尚未确定

没有确认 Oopz 的编码器选择、码率控制、服务器拓扑、具体采集 API、端到端延迟、不同功能档位的差异或运行时网络协议。不能仅从 DLL 名称推导这些结论。

本项目采用面向少数朋友的浏览器 P2P 网状连接。上传流量随观看人数增长；它没有实现大型商业平台的媒体分发、游戏注入式捕获、后台硬件优化或 QoS 服务。1080p60 是请求目标，不保证所有设备和网络达到。

## 公开资料

- Oopz 用户服务协议（页面标注更新日期 2026-04-25）：https://help.oopz.cn/agreement/service
- Oopz 隐私政策，第三方 SDK 表：https://help.oopz.cn/agreement/privacy
- MDN 屏幕采集 API：https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- WebRTC 官方 TURN 说明：https://webrtc.org/getting-started/turn-server
- coturn 官方配置说明：https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf

协议页面的实际适用性和法律例外取决于具体情况。本记录说明本次操作范围，不是对所有使用或部署情形的法律保证。
