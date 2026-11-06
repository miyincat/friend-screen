# 让异地朋友加入

当前交付默认是本机运行，没有对外部署。以下是后续使用你自己的基础设施的说明；本次没有执行其中的安装、防火墙、DNS 或公网配置。

## 需要准备

1. 一个你管理的服务器，以及指向它的域名，例如 `screen.your-domain.example`。
2. 可信 HTTPS 证书或自动申请证书的反向代理。直接用公网 IP + HTTP 不能在正常浏览器中采集屏幕。
3. 可从双方网络访问的 TURN 服务。仅让网页能访问不代表媒体就能穿过双方 NAT/防火墙。
4. 服务器/中继带宽和可能的流量费用。最多 6 人采用 P2P 网状连接，分享者会为多位观看者分别发送媒体；多人 1080p60 可能需要很高上行。

可先在同一电脑多个浏览器窗口验证产品行为，再安排你和朋友从两个真实网络验收。不要把本机地址发给朋友当作公网邀请。

## 应用服务

将这个项目复制到服务器，不上传 `.env`、私钥或 `node_modules`。安装 Node.js 22+，在项目目录运行：

```text
npm ci --omit=dev
```

把 `.env.example` 复制为 `.env`，至少设置：

```dotenv
HOST=127.0.0.1
PORT=8787
PUBLIC_ORIGIN=https://screen.your-domain.example
SITE_ACCESS_KEY=在这里填写至少16字符的随机站点口令
STUN_URLS=stun:turn.your-domain.example:3478
TURN_URLS=turn:turn.your-domain.example:3478?transport=udp,turn:turn.your-domain.example:3478?transport=tcp
TURN_SECRET=在这里填写至少32字符的随机中继共享秘密
ICE_RELAY_ONLY=false
```

用密码管理器或 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 分别生成不同的站点口令与 TURN 密钥。上面的中文值只是说明，不能直接当正式口令。`TURN_SECRET` 不要发给朋友，浏览器只收到服务端按 HMAC-SHA1 签发的 24 小时临时凭据；长期超过一天的会话需要重新加入获取新凭据。站点口令则私发给受邀朋友，房间口令每个房间另设。

运行 `npm start`，并用系统服务管理器保持运行。应用日志没有账号和媒体，但你还需要自行配置代理日志保留期限。

## HTTPS 反向代理示例

例如，已安装 Caddy 且正确配置 DNS 时使用以下 Caddyfile：

```text
screen.your-domain.example {
    reverse_proxy 127.0.0.1:8787
}
```

域名必须与 `PUBLIC_ORIGIN` 一致，保留浏览器的 `Host` 和 `Origin`，代理应支持 WebSocket。应用不信任客户端伪造的转发 IP；代理场景下限流会按代理地址共享，小范围朋友使用通常足够。

如不用代理，可用 `TLS_CERT` 与 `TLS_KEY` 指向你自己的有效证书，并调整监听地址和防火墙。不要为方便而让朋友关闭浏览器证书校验。

## coturn 配置要点

使用你自己管理的 coturn 实例。以下是配置起点，需按实际服务器、版本和网络补齐：

```ini
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=与应用TURN_SECRET完全相同的随机密钥
realm=turn.your-domain.example
min-port=49160
max-port=49200
user-quota=16
total-quota=128
no-multicast-peers
no-cli

# 避免经中继访问内网或回环地址；按你实际网络继续收紧。
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
```

防火墙放行 TCP/UDP 3478 与选定 UDP 中继端口段；如果服务器位于 NAT 后，需要按 coturn 文档配置 `external-ip` 映射。需要 TURN over TLS 时，另行配好证书和 5349（或独立 IP 上的 443）监听，并将对应 `turns:` URL 加入应用配置。不能只在 URL 中写 `turns:` 就认为 TLS 已可用。

配置文件中没有生成任何真实密钥，也没有测试这个示例在你的公网环境能否工作。正式启动前请核对所用 coturn 版本的官方配置说明和认证选项。不要开启匿名中继。

## 验收标准

- 从各自网络访问 HTTPS 页面，正确站点口令和房间口令可以加入，错误口令不能加入。
- 观看者确实能看到持续更新的画面，按需听到屏幕声音与麦克风；本地预览不回放自己的声音。
- 先设 `ICE_RELAY_ONLY=true` 验证中继，诊断应显示“TURN 中继”，确保不是仅在同一网络直连成功。之后可按需求改回直连优先。
- 第三位朋友中途加入、停止后重开、浏览器原生停止共享、退出房间、断网后清理均正常。
- 持续共享至少 15 分钟，检查画面流畅度、实际分辨率、CPU/GPU 使用率、上行流量及服务端费用。
- 不同操作系统/浏览器的窗口音频支持不一致；测试你们实际要共享的游戏和浏览器版本。受保护的内容可能显示黑屏，本项目不绕过此类限制。

## 官方参考

- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- https://webrtc.org/getting-started/turn-server
- https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy


## 账号数据持久化（0.2.0）

设置 `ACCOUNT_DATA_DIR=/var/lib/friend-screen/accounts`（示例），由服务进程专用用户拥有该目录并定期备份。默认位置为工作目录下 `data/`。不要把它放入 Web 静态目录或版本控制。账号数据不能随发布目录替换而丢失。只运行一个写入此目录的服务器实例；多进程部署前需要改用支持事务的数据库。

公网注册/登录也需要 `SITE_ACCESS_KEY`。反向代理必须保留正确 Host，提供 HTTPS 并允许同源 `/api/account`、`/api/account/*` 的 GET/POST，限制请求体大小，同时为 `/ws` 转发 WebSocket。登录状态最长 30 天，Cookie 使用 HttpOnly、SameSite=Strict，公网使用 Secure。不要缓存账号接口或记录请求体和 Cookie。域名购买不等于已部署这套账号与媒体服务。
