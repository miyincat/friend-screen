# 客户端更新发布说明

在自己的 GitHub 公开仓库创建 Release，标签填写 v0.4.6 等对应版本。上传同一次构建产生的安装器、同名 .exe.blockmap 和 latest.yml，再发布 Release。

首次给朋友安装带更新功能的版本。打开「分享设置」右上角的圆形按钮，填写 GitHub 仓库主页链接并保存。之后点击圆形按钮可直接检查。找到新版后点「下载更新」，共享结束后点「重启并更新」。整机安装可能触发 Windows 管理员授权。

后续构建使用 npm run build:installer。通过 FRIEND_SCREEN_UPDATE_REPOSITORY 设置仓库主页链接，可把默认更新仓库写入安装包，省去朋友首次填写。

首次构建在 %LOCALAPPDATA%\FriendScreen-Release\update-signing-key.pem 创建 Ed25519 私钥。使用 FRIEND_SCREEN_UPDATE_KEY_FILE 可指定源码目录外的私钥路径。后续更新必须复用同一把私钥。备份私钥并限制访问，发布文件只需要安装器、块映射和签名后的清单。安装包只包含公钥。
