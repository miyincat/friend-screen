# 同屏小屋：内部接口约定

原创的小规模 WebRTC 屏幕共享，最多 6 人。独立服务，不接入 Oopz。默认一次一人分享屏幕，所有人可开麦。

## HTTP

- 静态页面 `/`、`/app.js`、`/styles.css`。
- `GET /api/config` → `{maxParticipants:6, publicOrigin:null|string, hasTurn:boolean, icePolicy:"all"|"relay"}`。
- `GET /healthz` → `{ok:true}`。
- WebSocket `/ws`，JSON 消息，无二进制。

## 入房

客户端：`{type:"create",name,password}` 或 `{type:"join",roomId,name,password}`。昵称 1–24 字符，口令 8–128 字符。前端为创建房间生成强随机口令（可修改）。roomId 服务端生成，12 位大写十六进制。邀请链接仅含 `#room=房间号`，口令单独复制。不保存到 localStorage。

成功：`{type:"joined",selfId,roomId,peers:[{id,name,mic:false}],presenterId:null|string,iceServers:[],iceTransportPolicy:"all"|"relay",maxParticipants:6}`。已在房间的人收 `{type:"peer-joined",peer:{id,name,mic:false}}`。离开时其他人收 `{type:"peer-left",peerId}`。错误 `{type:"error",code,message}`，入房失败后仍可重试。服务端不会转发跨房间信令。

## 信令与媒体

客户端发送 `{type:"signal",to,payload:{description:{type:"offer"|"answer",sdp}}}` 或 `{type:"signal",to,payload:{candidate:RTCIceCandidateInit|null}}`。
目标收到 `{type:"signal",from,payload}`。使用 WebRTC perfect negotiation（id 字典序确定 polite，一律固定 video/audio/audio transceivers，分别屏幕视频、屏幕音频、麦克风）。浏览器自身选择分享源并授权；默认不开麦。

客户端 `{type:"present",active:true}`，如无人分享则所有人收到 `{type:"presenter",peerId:selfId}`。已有人分享返回错误 `PRESENTER_BUSY`。客户端收到自己获分享权后才能 getDisplayMedia；但为保留用户手势，建议先在按钮处理器立即调用 getDisplayMedia，获取流后申请分享权，失败立即 stop 所有轨道。停止 `{type:"present",active:false}` → 广播 `{type:"presenter",peerId:null}`，断线自动释放。

客户端 `{type:"mic",active:boolean}` → 所有人收到 `{type:"peer-state",peerId,mic:active}`。
客户端 `{type:"leave"}` 从房间移除但不关 socket，允许重新进入。服务端 ping/pong 保活，最后一人离开删除房间。没有静默自动重连入房；连接断开关闭本地媒体并给出重新加入提示。

## 产品要求

中文，原创深色安静界面。创建/加入、昵称、口令、邀请链接、在线成员、共享/停止、麦克风、质量档位720p30/1080p30/1080p60、远端声音播放按钮、全屏、连接诊断、离开。本地预览永远 muted；远端屏幕音频与各麦克风避免重复播放。

公网需要 HTTPS 与可用 TURN。默认不连接任何第三方 STUN；公网配置在服务端环境变量中，joined 后给出。页面须明显说明仅 localhost 免 HTTPS。分享画质为目标并非保证。没有源选择授权时不得自动捕获。不能把 synthetic/canvas 测试描述成真实桌面捕获实测。
