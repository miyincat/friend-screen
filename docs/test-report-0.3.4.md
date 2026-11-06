# 同屏小屋 0.3.4 · 测试报告

日期：2026-11-04。环境：本台 Windows x64、Node.js 24.21.0、Edge、Electron 45.2.2，现有 ZeroTier IPv4 网卡。没有操作朋友电脑。

| 项目 | 结果及证据 |
|---|---|
| npm test | 19 项通过，房间、账号与信令队列 |
| npm run test:network | 28 项通过（原11项及新增17项路径状态边界） |
| npm run test:browser | 11 项通过，artifacts/media-regression-0.3.4/browser-results.json |
| npm run test:profile | 6 项通过，合成接收音量/静音幅度测量 |
| npm run test:desktop-ice | 5 项通过，真实本机 ZeroTier 候选、麦克风拒绝和单机私网合成媒体 |
| npm run test:media-quality | 6 项通过，artifacts/media-quality-0.3.4/results.json |
| 发行包源码一致性 | 构建后以 dist/0.3.4/package-verification.json 为准，结果文件不存在则未验证 |
| 包内私网候选及采集授权回归 | 构建后以 artifacts/desktop-ice-packaged-0.3.4/results.json 为准，结果文件不存在则未验证 |
| 实际打包程序首次启动 | 构建后以 artifacts/overlay-tests-0.3.4/packaged-desktop-results.json 为准，结果文件不存在则未验证 |
| 两台真实电脑跨网、真实麦克风/系统声音 | 未验证 |
| 6–7台真实设备稳定10分钟 | 未验证 |
| 干净 Windows 10/11 安装、UAC、升级、卸载 | 未验证 |

## 清晰度及恢复场景

两隔离浏览器页面使用真实 RTCPeerConnection，仅交换实际本机 ZeroTier 网卡地址的 UDP host 候选。信令服务在 localhost，入网身份消息由测试显式模拟。媒体使用合成 1920×1080 细文字/动画 Canvas 和 oscillator，不采集用户屏幕或麦克风。

- 编码与解码均为 1920×1080，发送30fps；contentHint=detail、degradationPreference=maintain-resolution、缩放比例1、5Mbps/30fps上限均生效。
- 一次样本房主发送/接收1.76/0.03Mbps；观看者0.03/1.61Mbps。这是单机样本，不代表跨网带宽保证。
- 注入选中pair统计缺失超过3秒：发送轨道暂停、接收画面隐藏，成员仍2且媒体连接未关闭；恢复真实统计后新帧继续解码。
- 注入精确私网地址的remote prflx统计：继续传输。注入明确公网地址：拒绝并关闭媒体连接。
- 画质切换、停止和重新共享通过；没有未捕获页面异常。

截图位于 artifacts/media-quality-0.3.4/1080p-viewer.png、pending-paused.png、invalid-address-rejected.png。注入场景证明代码行为，不能证明用户此前断开的具体候选类型；旧版本没有保存足够的路径失败细节。

安装器未签名。安装网络驱动和服务需要 Windows UAC。不会修改用户的 ZeroTier 网络或停用防火墙。
