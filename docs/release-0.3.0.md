# 同屏小屋 0.3.0 私网测试版

本版是独立实现，没有复制、反编译、抓取或使用 Oopz 的代码、资源、私有协议和服务。未连接 Oopz。

新增每台设备内置的私网房间服务、可解析房间号、默认 8 人、房主退出关房、Ed25519 设备身份、签名邀请、成员证书、房主挑战握手、请求重放限制和撤销列表。新桌面入口用设备身份替代账号密码；旧账号模块保留用于回归和源码回滚，不作为新版发布入口。

保留原有前端布局、原生屏幕/窗口选择器、系统声音、麦克风、头像和 WebAudio 音量控制。默认 720p30 每条视频目标 1.5 Mbps，7 人时分享者 6 份视频约 9 Mbps，8 人约 10.5 Mbps，均未计音频、加密封装与重传；仅为估算。其他画质目标为 1080p30 / 5 Mbps、1080p60 / 8 Mbps，慢速中继不宜选择高档。

媒体不使用 STUN/TURN，信令过滤非 overlay 候选；音视频发送轨道先保持空，选中双方 overlay UDP host 路径后才附加真实轨道。房主或成员断线停止采集，成员可以重新加入。底层 ZeroTier 可能 UDP 直连，也可能免费中继，客户端“私有网卡”诊断不能区分其底层路径。

安装包包含应用、官方签名 ZeroTier 1.14.2 MSI、本机授权桥、许可证、组件源码与使用说明。驱动/服务需 UAC；无商业代码签名。预先已有网络组件不降级，共享组件卸载时受保护。安装失败不会被当作连接成功。

源码主要修改：`network/*`、`native/OverlayBridge.cs`、`server.mjs`、`desktop/*`、`public/app.js`、新增 `public/device-profile.js`、`scripts/*overlay.ps1`、`build/installer.nsh`、`electron-builder.json` 及新增测试。版本固定依赖在 package-lock.json；没有使用 audit fix --force。

回滚：改动前源码在 `artifacts/network-audit-2026-11-04/source-before-overlay.zip`，校验清单在同目录。v0.2.0 便携目录和旧桌面快捷方式保留。新版数据文件与旧账号文件分开；卸载新版后可用旧版，但旧版不具备本次跨网功能。

开发验证：`npm test`、`npm run test:network`、`node test/overlay-desktop.mjs`、`npm run test:profile`。旧采集回归使用环境变量 `FRIEND_SCREEN_LEGACY_TEST=1` 运行 `npm run test:desktop`，只在源码开发运行有效，打包应用不接受该开发开关。`node test/mesh-soak.mjs` 是单机 7 个合成媒体浏览器的 10 分钟基线，不是跨网络验收。

重建：Windows 上 `npm ci`，使用 .NET Framework 4 的 csc 编译 `native/OverlayBridge.cs` 为 `native/bin/OverlayBridge.exe`（引用 System.Web.Extensions.dll、System.Security.dll，目标 x64）；核对 vendor 中官方 MSI SHA-256 和签名后，运行 `npm run build:installer`。所需输入均保留在源码目录，不含长期平台密钥。该版本不是“跨网络全部验收通过”的正式发布，实际结果以测试报告为准。
