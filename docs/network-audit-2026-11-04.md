# 选型补充（2026-11-04，替代下方初始构建方案）

最终采用受官方支持的 ZeroTier 1.14.2 原始签名 MSI 随包，SHA-256 为 45A7C031E4D003512D6C08710E89BA57D9E5A0AEB6AF1D26326AD3C0B2A1755D，11,052,032 字节。该标签 LICENSE.txt 明确 Change Date 为 2026-01-01，Change License 为 Apache 2.0；当前已过转换日期。TAP 驱动仍单独遵循 GPL v2，DesktopUI 遵循 MPL 2.0，均保留通知和源码。本版不分发 1.16.2 整包，不再使用缺少编译环境的纯 MPL 自编译方向。

支持分支依据 https://docs.zerotier.com/start/ 的 1.16.x、1.14.x、1.12.x 列表。旧分支不等于最新或无风险，升级前必须重新核查许可、安全和兼容性。已新增应用代码、原生授权桥、安装器和回归测试。下方是最初审计记录，其中尚未改代码和先自行构建的描述不再代表当前状态。最终交付状态和未验证事项以 release-0.3.2.md、test-report-0.3.2.md 为准。

---

# 跨网络版本初始审计记录

日期：2026-11-04。状态：审计完成，组件构建验证中；不是发布完成报告。

## 现有版本与本机限制

- 项目为 Electron 45.2.2、Node.js ESM、ws 8.22.1 和普通 HTML/CSS/JavaScript。桌面入口为 `desktop/main.cjs`，房间服务为 `server.mjs`，媒体为浏览器 WebRTC。
- 本机模式在 Electron 主进程中创建服务，明确监听 `127.0.0.1` 的随机端口，其他电脑不能访问。
- 房间存储在单个服务进程的内存 Map。房间号只在这台服务内有效，没有跨主机寻址。
- WebRTC 采用 P2P mesh，屏幕视频、屏幕音频、麦克风各一条 transceiver。现有 ICE 没有限定 overlay；仅增加 VPN 状态 UI 不足以实现要求。
- 默认房间人数为 6；目前房主离开不会立即结束房间，需要调整生命周期和上限至 8。
- `userData/connection.json` 保存连接方式；Electron 持久 partition 为 `persist:friend-screen-client`。本机账号数据在 `userData/local-accounts`，当前为 scrypt 密码摘要和 HttpOnly Cookie 会话；目标设备身份必须替代这一登录流程。
- 已有原生屏幕/窗口选择、系统音频、头像和真实 WebAudio 音量控制，应保留。不得破坏现有采集权限流程及三条 transceiver 的顺序。
- `scripts/package-windows.mjs` 使用 `@electron/packager` 生成便携目录；现有 ZIP 不是含卸载器的安装包。v0.2.0 ZIP 为 158,064,059 字节。
- 当前项目不是 Git 仓库。改动前的应用文件 SHA-256 清单在 `artifacts/network-audit-2026-11-04/baseline-manifest.json`。验证阶段不修改应用代码。

## 官方资料核查

以下页面于审计日期通过 HTTPS 读取。网页文本副本保存于 `artifacts/network-audit-2026-11-04`，用于避免沿用旧额度。没有登录任何云平台、创建账号、填写付款信息或开通付费功能。

| 方案 | 额度与朋友登录 | Windows / 权限 / 媒体 | 维护与分发判断 |
| --- | --- | --- | --- |
| Tailscale Personal + tailscaled / tsnet | 当前页面为最多 6 用户、用户设备不限；无法据此承诺覆盖 7 位真实用户。tsnet 可用 auth key 免交互登录，但需安全的首次凭证交付，不能将长期 key 打包 | tailscaled 系统网卡通常需要安装权限；tsnet 是 Go 用户态网络栈，不能直接给现有 Chromium WebRTC 提供网卡，需额外媒体桥接 | 官方有持续维护；没有构建实际随包程序，因此增量体积未测。不能以把真实用户全部记到一个人名下的方式规避额度 |
| ZeroTier Central Personal + 原生 agent | 当前免费为 10 设备、1 网络、1 管理员；个人非商业用途。朋友可按网络 ID 发起待批准请求，不需要平台账号。免费列表没有 Central 管理 API，审批使用后台 | Windows 原生 TAP 驱动和系统服务需要 UAC。自带 UDP 穿透与回退中继；官方明确 TCP 中继较慢。系统虚拟网卡适合现有 WebRTC，但仍须限制候选地址 | 官方 1.16.2 MSI 的 HTTP Content-Length 为 12,003,840 字节，仅为官方原包大小，不是最终增量。官方 Release 项目包含 nonfree 控制器，不能把其当成全 MPL 程序直接随包；选择独立构建纯 MPL agent，并履行源码和通知义务 |
| ZeroTier libzt | 平台额度仍受网络计划约束；无需每个朋友平台账号 | 用户态 socket，可免网卡驱动，但 Chromium 不能直接使用这些 socket，需本机 TURN/媒体桥接；本机 TURN 不等于购买公网 TURN | NuGet 可用版本列表最新为 1.8.4，不能据此当成当前维护版本。仓库有较新提交，但当前未确认一个适合直接交付的最新 Windows 二进制。旧 SDK 不作为绕过构建和许可审计的捷径 |
| 自建 Headscale | 无 SaaS 人数月费，但必须运行控制服务；授权可通过预授权 key / 管理命令 | 官方要求可访问的公网 IP、HTTPS，主服务平台为 Linux/BSD。Windows 依赖 Tailscale 客户端；中继也需要可用基础设施 | 当前没有已验证的公网服务、域名或常驻主机。只有一台不保证公网入站的 Windows 电脑，不能承诺满足跨网及任意房主要求，不选 |

### ZeroTier 许可边界

官方标签 1.16.2 的 `LICENSE.txt` 将 node、osdep、service 等标为 MPL 2.0；`nonfree/LICENSE.md` 对控制器等另设许可，其中把纳入收费或免费产品、平台、分发或服务列入 Commercial Use。官方 Windows Release 项目显式设置 `ZT_NONFREE_CONTROLLER=1` 并编译 nonfree 源码。因此不将官方整包直接嵌入本产品，也不把“个人免费使用”推导为任意打包许可。

备选路径是自行构建仅 MPL 的 agent，禁用控制器、SSO、遥测和自动升级，保留 ZeroTier 的版权和组件标识。TAP 驱动源码另有 GPL v2 许可，若分发签名驱动还需提供对应源码和通知；不能用测试签名、关闭驱动签名验证或要求朋友降低 Windows 安全设置替代正式驱动。

这份记录是工程分发边界核对，不是笼统的法律合规保证。若无法构建并确认所需组件的分发条件，则不产出假装可用的安装包。

## 选定实现方向与验收门槛

1. 首先验证纯 MPL agent 能在 Windows x64 构建与运行，再改应用。当前机器没有 MSVC/Windows SDK，先使用隔离的便携工具链验证，不做系统安装。
2. 管理员创建免费私有网络，平台后台授权设备；朋友端由客户端内置组件申请，不要求朋友浏览器登录。
3. 邀请码包含网络定位信息和应用邀请材料，绝不是永久网络授权 key。首次网络批准后，由管理员电脑内的私网服务校验邀请版本并签发绑定设备公钥的应用凭证。首次入群需要管理员在线。
4. 管理员可轮换邀请；旧邀请不再签发新凭证。已批准设备撤销须同时处理应用凭证和平台成员授权，不能只隐藏 UI。普通成员不得持有管理员签名私钥。
5. 每个客户端内置房间服务，绑定 overlay 地址；本地 UI 使用 localhost。房间码携带私网地址、随机令牌等必要信息；房主离开关闭房间。
6. 禁用公网 STUN/TURN，并在 SDP 与 ICE 信令两层限制私网候选，检查实际选择的媒体路径；不能仅删除 STUN 配置就声称媒体走私网。
7. 默认上限 8。保留单路屏幕共享、系统声音和麦克风处理。7 人时现有 720p 档 2.5 Mbps × 6 观看者约需 15 Mbps 分享者上行，尚未计语音、封装和重传；这是估算，不是性能测试结果。
8. 使用一个安装器部署应用及所需合法组件，明确说明 UAC。测试签名版需说明 SmartScreen；不关闭防火墙、不开放公网房间端口。

## 当前验证边界

- 当前机器：Windows 11 Pro 10.0.26200 x64；当前 shell 非管理员；剩余磁盘约 89 GB（采样值）。
- 未验证：纯 MPL 组件构建、安装与卸载、干净 Windows 10/11、两台不同网络互通、真实系统声音/麦克风跨网、任意成员开房、7 人 10 分钟、仅 overlay 媒体路径。
- 之前 v0.2.0 的本机测试不能计作以上通过。
- 尚未修改应用逻辑，尚未安装网络服务/驱动，尚未创建平台账号或网络。当前没有新版安装包。

## 官方来源

- ZeroTier 价格：https://www.zerotier.com/pricing/
- ZeroTier 1.16.2：https://github.com/zerotier/ZeroTierOne/releases/tag/1.16.2
- 许可证划分：https://github.com/zerotier/ZeroTierOne/blob/1.16.2/LICENSE.txt
- nonfree 条款：https://github.com/zerotier/ZeroTierOne/blob/1.16.2/nonfree/LICENSE.md
- Windows 项目：https://github.com/zerotier/ZeroTierOne/blob/1.16.2/windows/ZeroTierOne/ZeroTierOne.vcxproj
- TAP 驱动源码：https://github.com/zerotier/ZeroTierOne/tree/1.16.2/windows/TapDriver6
- ZeroTier 中继：https://docs.zerotier.com/relay/
- ZeroTier 用户态 SDK：https://github.com/zerotier/libzt
- NuGet 版本列表：https://api.nuget.org/v3-flatcontainer/zerotier.sockets/index.json
- Tailscale 价格：https://tailscale.com/pricing
- tsnet：https://tailscale.com/kb/1244/tsnet
- Headscale 要求：https://headscale.net/stable/setup/requirements/
