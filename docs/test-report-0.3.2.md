# 同屏小屋 0.3.2 · 测试报告

测试日期：2026-11-04。环境：单台 Windows 11 x64，Node.js 24.21.0、Edge/Chromium。浏览器媒体输入为合成 Canvas / oscillator；WebRTC 使用真实浏览器 `RTCPeerConnection`。

| 测试 | 结果 |
|---|---|
| `npm test` | 19 项通过 |
| `npm run test:network` | 11 项通过，私网候选策略未放宽 |
| `npm run test:browser` | 11 项通过，含候选诊断、SDP/ICE 乱序、接收视频帧和屏幕/麦克风 RTP |
| `FRIEND_SCREEN_LEGACY_TEST=1 npm run test:desktop` | 8 项通过，含 Windows 原生窗口采集与另一浏览器接收画面 |
| `node test/overlay-desktop.mjs`（针对打包程序） | 5 项通过，含首次设置、拒绝错误邀请码、safeStorage 加密和设备 ID 重启后保留；没有实际加入 ZeroTier |
| 真实两台电脑、不同网络下的 ZeroTier 音视频 | 未验证 |
| Windows 10 干净安装、UAC、升级和卸载 | 未验证 |
| 6–7 台真实设备同房 10 分钟 | 未验证 |

浏览器回归证明候选计数会在模拟房间中报告，且本机房间的 SDP/媒体连接正常。它不能证明两台 ZeroTier 设备已生成并互相送达可用的 UDP host 候选。0.3.2 新增诊断字段用于下一次实网复测；没有真实跨网通过结论。

发行包未签名，SmartScreen 或杀毒软件可能提示。请先核对管理员单独提供的 SHA-256；不要关闭杀毒软件、防火墙或驱动签名保护。安装网络服务及驱动需要 Windows UAC。
