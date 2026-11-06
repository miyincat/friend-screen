!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "同屏小屋 0.4.6 · 私网测试版"
  !define MUI_WELCOMEPAGE_TEXT "此安装包包含应用、Piik 原生媒体组件和 ZeroTier 网络服务及签名驱动。安装需要 Windows 管理员权限（UAC）。首次打开还需一次 Windows 用户授权。$\r$\n$\r$\n朋友无需单独下载或登录 ZeroTier。管理员需先创建免费私有网络。$\r$\n$\r$\n这是未签名测试版，异地和 7 人性能尚需验证。已有 ZeroTier 将被保留，不会降级。"
  !insertmacro MUI_PAGE_WELCOME
!macroend
!macro customInstall
  DetailPrint "正在安装私网服务和驱动；需要管理员权限。"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-overlay.ps1" -AppDir "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "网络组件安装失败。应用文件已复制，但尚不能跨网使用。请查看 C:\ProgramData\FriendScreen\logs 并重新运行安装包；不要忽略失败。"
    Abort
  ${EndIf}
!macroend
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\uninstall-overlay.ps1" -AppDir "$INSTDIR"'
    Pop $0
  ${endIf}
!macroend
