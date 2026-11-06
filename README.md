# 同屏小屋 0.4.6 · 私网流畅观看测试版

保留原前端、ZeroTier 入网和房间号，接入 Piik 2.5.3 原生采集、硬件 H.264 和压缩媒体转发。默认 8 人房间、同时一人共享，目标 1080p60；头像昵称、麦克风、自己和朋友音量仍保留。

这是私网测试版，不使用公网隧道、在线目录或付费服务器。全员升级到 0.4.6，保留原本机身份，不要重新建网。实际性能受显卡、采集内容、上行、丢包和 ZeroTier 底层路径影响。

- 使用：docs/friends-guide.md
- 管理：docs/administrator-guide.md
- 变更与构建：docs/release-0.4.6.md
- 已验证范围：docs/test-report-0.4.6.md
- Piik 修改说明：vendor/piik/FRIENDSCREEN-MODIFICATIONS.txt

开发入口 npm run desktop，安装器构建 npm run build:installer。Piik 源码及修改保留在 vendor/piik-source；依赖与许可证随包提供。

0.3.5 发行备份在桌面“同屏小屋-私网备份-0.3.5”，源码 Git 基线 7c2ec84。没有复制、反编译或使用 Oopz 代码、素材或私有服务。

新增可开关的诊断窗口：菜单“小屋 → 诊断记录窗口”或 Ctrl+Shift+D。停止后在桌面生成 ZIP；双方同时记录后分别发送便于排障。使用步骤见 docs/diagnostics-guide.md。默认关闭，不记录屏幕/声音内容，不自动上传。

0.3.10 增加可切换的观看缓冲，按下游人数分配编码预算；默认单路目标 6 Mbps、上传预算 8 Mbps、保持分辨率。明确选择保持分辨率时，低码率表示也保留目标尺寸；码率不足仍会模糊或降帧。本版保留 0.3.9 的本机直通和内置 H.264 乱序组帧修复。它没有 CDN，也不会把一条 11 Mbps 上行变成更大的带宽。
