# 自定义卸载/更新时的文件删除逻辑（electron-builder 的 customRemoveFiles 钩子）。
#
# 更新时（安装器带 --updated 调用旧卸载器）只删除清单里的程序文件，
# config/data/logs/cache 等运行时数据不会被触碰；真正卸载时由用户在卸载
# 欢迎页勾选是否保留数据，未勾选才清理这些目录。清单由
# scripts/after-pack-manifest.js 生成，受保护目录清单同样由它生成。
#
# 更新安装器运行在 %LOCALAPPDATA%\Pi-Workbench-Update（安装目录之外）：electron-builder
# 的卸载器会按 $INSTDIR 路径前缀结束进程，安装器若从安装目录内启动会被误杀。
# 安装完成后写标记，新版本首次启动时清空外部缓存。

!define UPDATER_CACHE_ROOT "$LOCALAPPDATA\Pi-Workbench-Update"
!define UPDATER_CACHE_FLAG "$LOCALAPPDATA\Pi-Workbench-Update.flag"
# electron-builder 安装器把自己复制到这里供差分更新使用（APP_INSTALLER_STORE_FILE）。
# 名称取自 appInfo.updaterCacheDirName，与 app-update.yml 保持一致；改了缓存目录名要同步。
!define PI_UPDATER_STORE "$LOCALAPPDATA\pi-workbench-updater"

# electron-updater 在 Windows 读取差分基准的路径是
# {baseCachePath}/{updaterCacheDirName}/installer.exe。应用把 baseCachePath 覆盖成了
# UPDATER_CACHE_ROOT，和 electron-builder 默认保存副本的位置不同，因此 customInstall
# 要按这个路径另存一份；清理时由应用保留，真正卸载时随 UPDATER_CACHE_ROOT 一起删除。
!define PI_DIFFERENTIAL_BASE "${UPDATER_CACHE_ROOT}\pi-workbench-updater"

# 本 include 早于 common.nsh / MUI2.nsh，LogicLib 与 nsDialogs 需要自己引入
# （两者都有重复包含保护）。
!include LogicLib.nsh
!include nsDialogs.nsh

# 卸载时是否保留 config/data/logs/cache。静默卸载不显示勾选框，默认保留。
# 只在卸载器构建里声明：安装器构建不包含 un 页面与 un 段，声明了会成为未使用变量
# （NSIS warnings-as-errors 会因此失败）。
!ifdef BUILD_UNINSTALLER
Var KeepUserData
Var KeepDataCheckbox
!endif

# 安装器只编译 en_US / zh_CN 两种语言（见 package.json nsis.installerLanguages），
# LangString 只需覆盖 1033 / 2052。
LangString PW_KEEP_DATA_TITLE 1033 "Uninstall Pi Workbench"
LangString PW_KEEP_DATA_TITLE 2052 "卸载 Pi Workbench"
LangString PW_KEEP_DATA_SUBTITLE 1033 "Choose whether to keep your settings and session data."
LangString PW_KEEP_DATA_SUBTITLE 2052 "选择是否保留设置与会话数据。"
LangString PW_KEEP_DATA_CHECKBOX 1033 "Keep configuration and session data (config, data, logs, cache)"
LangString PW_KEEP_DATA_CHECKBOX 2052 "保留配置与会话数据（config、data、logs、cache）"

!macro customUnInit
  # 静默卸载（/S）不会显示卸载欢迎页，按安全默认保留数据
  StrCpy $KeepUserData 1
!macroend

# 卸载器欢迎页换成带"保留数据"勾选框的自定义页（assisted 安装器专用）。
# 函数放在宏里定义：这个 include 早于 MUI2.nsh，宏在 assistedInstaller.nsh
# 展开时 MUI/nsDialogs 宏才可用。
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

# 安装目录校验：应用把 config/data/logs 写在安装目录内，目录必须可写。
# 在目录页就拒绝 Program Files / Windows 目录，避免装完启动才提示重装。
!macro PW_REJECT_IF_UNDER prefix
  StrLen $1 ${prefix}
  IntOp $1 $1 + 1
  StrCpy $2 $INSTDIR $1
  ${If} $2 == "${prefix}\"
    Abort
  ${EndIf}
!macroend

Function .onVerifyInstDir
  StrLen $0 $INSTDIR
  ${If} $0 < 4
    Abort
  ${EndIf}

  ${If} $INSTDIR == "$PROGRAMFILES"
    Abort
  ${EndIf}
  !insertmacro PW_REJECT_IF_UNDER $PROGRAMFILES

  ${If} $PROGRAMFILES64 != ""
    ${If} $INSTDIR == "$PROGRAMFILES64"
      Abort
    ${EndIf}
    !insertmacro PW_REJECT_IF_UNDER $PROGRAMFILES64
  ${EndIf}

  !insertmacro PW_REJECT_IF_UNDER $WINDIR
FunctionEnd

!macro customRemoveFiles
  # un.onInit 把当前目录设为 $INSTDIR，删除前必须离开
  SetOutPath $TEMP

  ClearErrors
  FileOpen $0 "$INSTDIR\resources\installer-manifest.files.txt" r
  IfErrors pwNoManifest

  pwFilesLoop:
    ClearErrors
    FileRead $0 $1
    IfErrors pwFilesDone
    # FileRead 保留行尾换行；清单固定 CRLF，去掉末尾两个字符
    StrCpy $1 $1 -2
    StrCmp $1 "" pwFilesLoop
    Delete "$INSTDIR\$1"
    Goto pwFilesLoop

  pwFilesDone:
    FileClose $0

    ClearErrors
    FileOpen $0 "$INSTDIR\resources\installer-manifest.dirs.txt" r
    IfErrors pwAfterDirs

  pwDirsLoop:
    ClearErrors
    FileRead $0 $1
    IfErrors pwDirsDone
    StrCpy $1 $1 -2
    StrCmp $1 "" pwDirsLoop
    # 非递归删除：只有空目录会被移除，未知文件会让目录保留
    RMDir "$INSTDIR\$1"
    Goto pwDirsLoop

  pwDirsDone:
    FileClose $0
    Goto pwAfterDirs

  pwNoManifest:
    # 没有清单：更新时保守处理（不删任何文件）。
    # 卸载时保留数据只删顶层程序文件与已知程序目录；否则整目录删除。
    ${ifNot} ${isUpdated}
      ${if} $KeepUserData == 1
        Delete "$INSTDIR\*.*"
        RMDir /r "$INSTDIR\locales"
        RMDir /r "$INSTDIR\resources"
        RMDir /r "$INSTDIR\swiftshader"
      ${else}
        RMDir /r $INSTDIR
      ${endIf}
      Goto pwEnd
    ${endIf}
    DetailPrint "Installer manifest not found; skipping file removal."
    Goto pwEnd

  pwAfterDirs:
    # 运行时数据只在真正卸载且用户未勾选“保留数据”时删除。
    # 受保护目录清单由 afterPack 生成，避免与 JS 侧名单两处维护。
    ${ifNot} ${isUpdated}
      ${if} $KeepUserData != 1
        ClearErrors
        FileOpen $0 "$INSTDIR\resources\installer-manifest.protected.txt" r
        IfErrors pwProtectedDone

      pwProtectedLoop:
        ClearErrors
        FileRead $0 $1
        IfErrors pwProtectedEnd
        StrCpy $1 $1 -2
        StrCmp $1 "" pwProtectedLoop
        RMDir /r "$INSTDIR\$1"
        Goto pwProtectedLoop

      pwProtectedEnd:
        FileClose $0

      pwProtectedDone:
      ${endIf}
    ${endIf}

    Delete "$INSTDIR\resources\installer-manifest.files.txt"
    Delete "$INSTDIR\resources\installer-manifest.dirs.txt"
    Delete "$INSTDIR\resources\installer-manifest.protected.txt"

    ${ifNot} ${isUpdated}
      # 安装器生成、不在清单内的文件（更新时由新安装包覆盖）。
      # elevate.exe 由 electron-builder 在 afterPack 之后才放进 resources。
      Delete "$INSTDIR\${UNINSTALL_FILENAME}"
      Delete "$INSTDIR\uninstallerIcon.ico"
      Delete "$INSTDIR\resources\app-update.yml"
      Delete "$INSTDIR\resources\elevate.exe"
      Delete "$INSTDIR\.write-probe"
      RMDir "$INSTDIR\resources"

      # 外部更新缓存：更新时安装器正从其中运行，只有真正卸载才清理
      RMDir /r "${UPDATER_CACHE_ROOT}"
      Delete "${UPDATER_CACHE_FLAG}"

      RMDir "$INSTDIR"
    ${endIf}

  pwEnd:
!macroend

# 解压完成后写入“安装完成”标记，供新版本首次启动清空外部更新缓存。
# customInstall 在 installApplicationFiles 之后执行（installSection.nsh）。
!macro customInstall
  FileOpen $9 "${UPDATER_CACHE_FLAG}" w
  FileWrite $9 "installed"
  FileClose $9

  # 差分更新基准：保存本次安装的安装包本身，供下一次更新做块级差分。
  # 静默更新时 $EXEPATH 就是刚下载的新安装包；首次安装时是用户下载的安装包。
  CreateDirectory "${PI_DIFFERENTIAL_BASE}"
  CopyFiles /SILENT "$EXEPATH" "${PI_DIFFERENTIAL_BASE}\installer.exe"

  # 安装器在 LOCALAPPDATA 的差分副本：位置与 electron-updater 读取的基准路径不一致，
  # 上面已经另存了一份，这里直接删除避免占用双份空间。
  Delete "${PI_UPDATER_STORE}\installer.exe"
  RMDir /r "${PI_UPDATER_STORE}"

  # 更新后让 Windows 立刻丢弃旧的 shell 缓存：
  # SHCNE_ASSOCCHANGED 通知图标 / 文件关联 / 快捷方式失效，ie4uinit 重建图标缓存库。
  # 两者都是尽力而为，失败不影响安装；应用侧首启还有一次兜底（electron/shell-refresh.ts）。
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x0000, i 0, i 0)'
  Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend
