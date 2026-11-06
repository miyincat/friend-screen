# 同屏小屋 0.3.3 · 测试报告

日期：2026-11-04。环境：本台 Windows x64，Node.js 24.21.0，Electron 45.2.2，已启用且有已分配 IPv4 的真实 ZeroTier 网卡。没有操作朋友的电脑。

## 根因复现

在独立临时配置目录启动真实 Electron，不采集桌面或麦克风，仅创建 RTCPeerConnection 并收集候选。旧权限逻辑下仅产生普通网卡的 UDP host 候选，指定私网候选为零。显式设置默认 IPHandlingPolicy 仍为零。修复音频状态检查后，出现 ZeroTier UDP host 候选，私网过滤规则原样保留。

## 回归结果

| 测试 | 结果 |
|---|---|
| npm test | 19 项通过 |
| npm run test:network | 11 项通过 |
| npm run test:browser | 11 项通过，真实 WebRTC、合成音视频 |
| npm run test:profile | 6 项通过，包含麦克风增益、独立朋友音量和本地静音的接收信号幅度检查 |
| npm run test:desktop-ice | 5 项通过：指定私网候选、拒绝麦克风、拒绝摄像头、返回启动页、单机私网合成音视频/数据 |
| FRIEND_SCREEN_LEGACY_TEST=1 npm run test:desktop | 8 项通过，Windows 测试窗口捕获与浏览器接收 |
| 发行包一致性、包内私网回归和首次启动 | 见 dist/0.3.3/package-verification.json 及 artifacts/desktop-ice-packaged/results.json、artifacts/overlay-tests-0.3.3/packaged-desktop-results.json；若结果文件不存在则未验证 |
| 两台真实电脑、不同网络的画面/系统声音/麦克风 | 未验证 |
| 6–7 台真实电脑稳定运行 10 分钟 | 未验证 |
| 干净 Windows 10/11 安装、UAC、升级和卸载 | 未验证 |

候选探针结果只记录协议、候选类型和地址分类，不记录实际 IP、邀请码、长期密钥或令牌。旧版源码回滚副本在 artifacts/rollback-0.3.2。

本轮候选/权限结果：artifacts/desktop-ice/results.json。单机私网双端各发送并接受 1 个候选（各收集 8 个），verifiedPair 均为 true，接收解码视频及合成音频 RTP。此结果不能证明真实跨网链路已通过。
