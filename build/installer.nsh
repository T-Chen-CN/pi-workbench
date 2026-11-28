# Pi Workbench Windows NSIS 安装/卸载钩子（严格两目录模型）。
#
# 程序文件位于 $INSTDIR（更新与卸载交由 electron-builder 默认流程完整清理），
# 全部用户数据、配置、会话、日志与更新缓存统一位于 %APPDATA%\pi-workbench：
# - 升级（--updated）绝不触碰 %APPDATA%\pi-workbench；
# - 真正卸载时在欢迎页提供「保留用户配置与会话数据」勾选框（默认保留）。

!define PI_USER_DATA "$APPDATA\pi-workbench"
!define PI_DIFFERENTIAL_BASE "${PI_USER_DATA}\cache\pi-workbench-updater"
!define PI_UPDATE_FLAG "${PI_USER_DATA}\cache\pi-workbench-updater.flag"
!define PI_MIGRATION_MARKER "${PI_USER_DATA}\config\.migrated-from-install-dir"
!define PI_PENDING_LEGACY_MIGRATION "${PI_USER_DATA}\.pending-legacy-migration"
# electron-builder 默认在 LOCALAPPDATA 留下的差分副本与旧版外部缓存，统一清掉避免多出第 3 个目录
!define PI_LEGACY_UPDATER_STORE "$LOCALAPPDATA\pi-workbench-updater"
!define PI_LEGACY_UPDATE_CACHE "$LOCALAPPDATA\Pi-Workbench-Update"
!define PI_LEGACY_UPDATE_FLAG "$LOCALAPPDATA\Pi-Workbench-Update.flag"

!include LogicLib.nsh
!include nsDialogs.nsh

!ifdef BUILD_UNINSTALLER
Var KeepUserData
Var KeepDataCheckbox
!endif

LangString PW_KEEP_DATA_TITLE 1033 "Uninstall Pi Workbench"
LangString PW_KEEP_DATA_TITLE 2052 "卸载 Pi Workbench"
LangString PW_KEEP_DATA_SUBTITLE 1033 "Choose whether to keep your settings and session data."
LangString PW_KEEP_DATA_SUBTITLE 2052 "选择是否保留设置与会话数据。"
LangString PW_KEEP_DATA_CHECKBOX 1033 "Keep user settings and session data (%APPDATA%\pi-workbench)"
LangString PW_KEEP_DATA_CHECKBOX 2052 "保留用户配置与会话数据（%APPDATA%\pi-workbench）"

!macro customUnInit
  # 静默卸载（/S）与升级过程默认保留用户数据
  StrCpy $KeepUserData 1
!macroend

!macro customUnWelcomePage
  Function un.pwKeepDataPageShow
    !insertmacro MUI_HEADER_TEXT "$(PW_KEEP_DATA_TITLE)" "$(PW_KEEP_DATA_SUBTITLE)"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateCheckbox} 0 0u 100% 12u "$(PW_KEEP_DATA_CHECKBOX)"
    Pop $KeepDataCheckbox
    ${If} $KeepUserData == 1
      ${NSD_Check} $KeepDataCheckbox
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function un.pwKeepDataPageLeave
    ${NSD_GetState} $KeepDataCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $KeepUserData 1
    ${Else}
      StrCpy $KeepUserData 0
    ${EndIf}
  FunctionEnd

  UninstPage custom un.pwKeepDataPageShow un.pwKeepDataPageLeave
!macroend

!macro PW_ENTER_USER_CONTEXT
  # 旧版若曾以 /allusers（HKLM）模式安装，initMultiUser 会把上下文设为 all，
  # 导致 $APPDATA 解析到 C:\ProgramData 而非当前用户的 %APPDATA%。
  # 读写用户数据目录与更新缓存前必须切到 current，完成后按 $installMode 恢复。
  SetShellVarContext current
!macroend

!macro PW_RESTORE_SHELL_CONTEXT
  ${If} $installMode == "all"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
!macroend

!macro PW_RESCUE_LEGACY_DATA
  # 在任何可能清理 $INSTDIR 的步骤之前，先把仍留在安装目录内的旧版用户数据暂存到当前用户的
  # %APPDATA%\pi-workbench\.pending-legacy-migration，供新版本首启无损合并。
  !insertmacro PW_ENTER_USER_CONTEXT
  ${If} "$INSTDIR" != ""
  ${AndIfNot} ${FileExists} "$INSTDIR\portable"
  ${AndIfNot} ${FileExists} "${PI_MIGRATION_MARKER}"
    ${If} ${FileExists} "$INSTDIR\config\*.*"
    ${OrIf} ${FileExists} "$INSTDIR\data\*.*"
      CreateDirectory "${PI_PENDING_LEGACY_MIGRATION}"
      ${If} ${FileExists} "$INSTDIR\config\*.*"
        CreateDirectory "${PI_PENDING_LEGACY_MIGRATION}\config"
        CopyFiles /SILENT "$INSTDIR\config\*.*" "${PI_PENDING_LEGACY_MIGRATION}\config"
      ${EndIf}
      ${If} ${FileExists} "$INSTDIR\data\*.*"
        CreateDirectory "${PI_PENDING_LEGACY_MIGRATION}\data"
        CopyFiles /SILENT "$INSTDIR\data\*.*" "${PI_PENDING_LEGACY_MIGRATION}\data"
      ${EndIf}
      ${If} ${FileExists} "$INSTDIR\logs\*.*"
        CreateDirectory "${PI_PENDING_LEGACY_MIGRATION}\logs"
        CopyFiles /SILENT "$INSTDIR\logs\*.*" "${PI_PENDING_LEGACY_MIGRATION}\logs"
      ${EndIf}
      ${If} ${FileExists} "$INSTDIR\cache\drafts\*.*"
        CreateDirectory "${PI_PENDING_LEGACY_MIGRATION}\cache\drafts"
        CopyFiles /SILENT "$INSTDIR\cache\drafts\*.*" "${PI_PENDING_LEGACY_MIGRATION}\cache\drafts"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  !insertmacro PW_RESTORE_SHELL_CONTEXT
!macroend

!macro customUnInstall
  ${if} ${isUpdated}
    # 纵深防御：即使升级时由本卸载器执行 RMDir /r $INSTDIR，也绝不丢失尚未迁移的旧数据
    !insertmacro PW_RESCUE_LEGACY_DATA
  ${else}
    # 仅真正卸载时清理当前用户的外部残留与（取消勾选保留时）用户数据
    !insertmacro PW_ENTER_USER_CONTEXT
    RMDir /r "${PI_LEGACY_UPDATE_CACHE}"
    Delete "${PI_LEGACY_UPDATE_FLAG}"
    RMDir /r "${PI_LEGACY_UPDATER_STORE}"
    ${if} $KeepUserData != 1
      RMDir /r "${PI_USER_DATA}"
    ${endIf}
    !insertmacro PW_RESTORE_SHELL_CONTEXT
    # 若曾是 /allusers 安装，顺带清理此前错落在 ProgramData 的更新缓存残留（仅删空目录）
    ${If} $installMode == "all"
      SetShellVarContext all
      RMDir /r "$APPDATA\pi-workbench\cache\pi-workbench-updater"
      Delete "$APPDATA\pi-workbench\cache\pi-workbench-updater.flag"
      RMDir "$APPDATA\pi-workbench\cache"
      RMDir "$APPDATA\pi-workbench"
      !insertmacro PW_RESTORE_SHELL_CONTEXT
    ${EndIf}
  ${endIf}
!macroend

!macro customInit
  # 必须在旧卸载器清理 $INSTDIR 之前，先抢救仍留在安装目录内的旧版数据到当前用户暂存目录
  !insertmacro PW_RESCUE_LEGACY_DATA
!macroend

!macro customInstall
  # 差分更新基准收口到当前用户的统一数据目录（%APPDATA%\pi-workbench），避免 /allusers 误落 ProgramData
  !insertmacro PW_ENTER_USER_CONTEXT
  CreateDirectory "${PI_DIFFERENTIAL_BASE}"
  CopyFiles /SILENT "$EXEPATH" "${PI_DIFFERENTIAL_BASE}\installer.exe"
  FileOpen $9 "${PI_UPDATE_FLAG}" w
  FileWrite $9 "installed"
  FileClose $9

  # 清理 electron-builder 默认写入 LOCALAPPDATA 的重复副本及旧版外部缓存，保证全机严格两目录
  RMDir /r "${PI_LEGACY_UPDATER_STORE}"
  RMDir /r "${PI_LEGACY_UPDATE_CACHE}"
  Delete "${PI_LEGACY_UPDATE_FLAG}"
  !insertmacro PW_RESTORE_SHELL_CONTEXT

  # 若历史上以 /allusers 安装并曾由 0.12.0/0.12.1 在 ProgramData 落下缓存，顺手回收（非递归 RMDir 绝不误删非空目录）
  ${If} $installMode == "all"
    SetShellVarContext all
    RMDir /r "$APPDATA\pi-workbench\cache\pi-workbench-updater"
    Delete "$APPDATA\pi-workbench\cache\pi-workbench-updater.flag"
    RMDir "$APPDATA\pi-workbench\cache"
    RMDir "$APPDATA\pi-workbench"
    !insertmacro PW_RESTORE_SHELL_CONTEXT
  ${EndIf}

  # 更新后刷新 Windows Shell / 图标缓存（Win10/11 用 -ClearIconCache；缺文件时静默跳过）
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x0000, i 0, i 0)'
  ${If} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::Exec '"$SYSDIR\ie4uinit.exe" -ClearIconCache'
    Pop $0
  ${EndIf}
!macroend
