# 同屏小屋 0.3.7 · 可开关的诊断记录

新增独立诊断窗口，入口为「小屋 → 诊断记录窗口」、Ctrl+Shift+D，以及房间页面按钮。支持开始/停止记录、实时统计、问题标记、桌面 ZIP 导出和异常结束记录的再次打包。

记录默认关闭。启用后每 3 秒采样，并按事件记录媒体状态变化；停止、关闭窗口或正常退出会保存。数据先逐条落盘，容量上限 20 MiB、时间上限 2 小时，写入队列有限；采集或文件写入失败不会结束房间。

报告区分语音网络统计、本机播放桥接统计和原生输出预算，明确缺失指标；不会把语音 RTT 或本机丢包误报为异地视频路径。原始身份/地址等敏感字段不进入文件，双方可通过摘要匹配房间和转发链路。

媒体编码器、私网绑定规则、房间寻址和设备身份格式延续 0.3.6，没有重编译或改动 Piik 媒体二进制。0.3.6 与 0.3.7 的媒体协议兼容，但需要双方升级 0.3.7 才能取得双端诊断。保留原资料，若出现解密错误不要退出设备或重建小屋；真实旧身份覆盖迁移仍未验证。

新增 ZIP 依赖 fflate 0.8.3（MIT），随包保留其许可证。导出完全在本机完成，不新增网络服务、遥测或付费项目。

开发与测试：

```powershell
npm ci
npm run test:diagnostics
npm run test:diagnostics-media
npm test
npm run test:network
npm run build:installer
node scripts/verify-package.mjs
python scripts/create-delivery.py
```

基线：0.3.6 Git 提交 7fb8b7a；桌面旧安装包与源码归档保留，可回滚。详见 diagnostics-guide.md 和 test-report-0.3.7.md。
