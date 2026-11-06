# 同屏小屋 0.3.6 · Piik 原生媒体私网版

## 本次改变

- 保留同屏小屋前端、设备昵称头像、ZeroTier 审批、FSI1 邀请和 FSR1 房间号。继续使用原私网，没有 Cloudflare、域名、账号目录或公网隧道。
- 将屏幕/窗口媒体接入 Piik 2.5.3 原生采集、GPU H.264 编码、原生接收及压缩视频转发。麦克风仍由原有独立 WebRTC 音频链路承载。
- 分享者默认只向最多两名下游发送，其余观看者由房间成员继续转发。转发成员退出会重新排列。减少分享者重复发送的份数，但不消除真实上行带宽需求；上传较弱的转发成员仍可能成为瓶颈。
- 默认目标 1080p60、平衡自适应、每路码率上限 12 Mbps，可选 6/12/20 Mbps。提高上限不会增加宽带带宽。数字是目标和上限，实际尺寸/帧率/速率另行显示。
- 选择来源时可选择显卡硬件编码器。分享声音默认不勾选；窗口声音按进程采集，整屏声音按系统采集。显示器共享尽可能排除小屋本身进程的声音，实际效果依 Windows 支持。
- 增加 ZeroTier 底层路径诊断。DIRECT 表示对应节点存在活动直连路径；没有直连证据时显示未知/可能中继，不把已连接私网当作互联网直连。节点 ID 来自成员签名的声明，只用于诊断，不作为新授权依据。
- 原生操作按顺序执行；页面离开、刷新、崩溃、网络地址变化和程序退出会回收原生媒体资源。旧版与新版协议不混用，界面提示所有成员升级。

## 私网限制

Piik Go 媒体组件是基于官方源码的修改构建。原生 UDP 套接字仅绑定当前已验证的 ZeroTier IPv4；关闭 mDNS、网关映射、公网 STUN/TURN。WebRTC 信令在客户端和房主端按已认证成员地址过滤。不能自动回退到物理网卡或公网媒体。

原生组件的控制 HTTP/WebSocket 监听本机回环。小屋播放器连接本机自己的私网地址；这是本机进程之间的播放桥接，不需要朋友或平台中继。直接使用 127.0.0.1 UDP 的播放桥接在当前 Chromium 下不兼容，因此未采用。

安装器添加 Piik 进程专用的私有源/目标地址 UDP 防火墙规则。原有 ZeroTier 安装保持不降级；程序不更改 ZeroTier 网段、路由器设置或系统防护开关。

## 升级和回滚

所有成员退出旧版后覆盖安装 0.3.6。**不要点“退出当前设备”、删除身份、重建 ZeroTier 网络或改变地址池。**本版未改身份存储格式，设计上继续沿用原昵称头像、管理员身份、审批及邀请码；真实覆盖升级迁移尚未验证。房间需由新版重新创建。

桌面私网 0.3.5 备份位于：
`C:\Users\<用户名>\Desktop\同屏小屋-私网备份-0.3.5`

原始源码 Git 基线：`7c2ec84`。回滚使用备份安装器，保留原本机身份资料。此版本没有修改设备身份存储格式。

## 来源与重建

Piik v2.5.3，原始 revision `f2f9d27db66565f9234c16d46ddd10f4d143cc16`；MIT 许可和第三方 notices 随包保留。原生采集 helper 使用官方包文件，Go 主组件的修改源在 `vendor/piik-source`，具体改动见 `vendor/piik/FRIENDSCREEN-MODIFICATIONS.txt`。没有使用 Oopz 的代码、素材或服务。

工具链：Node 24.21.0、Electron 45.2.2、Go 1.27.3（CGO_ENABLED=0）。先在 Piik 源码目录运行 `npm ci` 和 `npm run build:web`，然后在小屋根目录运行：

```powershell
./scripts/build-private-media.ps1 -Go <go.exe绝对路径>
npm test
npm run test:network
npm run test:private-native
npm run build:installer
node scripts/verify-package.mjs
python scripts/create-delivery.py
```

需要更新本机网络桥时，用 .NET Framework 4 的 csc 编译 `native/OverlayBridge.cs`，引用 System.Web.Extensions.dll 和 System.Security.dll，目标 x64。不要把开发依赖、真实设备资料或密钥放进分发包。测试范围见同目录测试报告。
