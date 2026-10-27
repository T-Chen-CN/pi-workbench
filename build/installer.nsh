# 自定义卸载/更新时的文件删除逻辑（electron-builder 的 customRemoveFiles 钩子）。
#
# 更新时（安装器带 --updated 调用旧卸载器）只删除清单里的程序文件，
# config/data/logs/cache 等运行时数据不会被触碰；真正卸载时再额外清理
# 安装器生成的文件与数据目录。清单由 scripts/after-pack-manifest.js 生成。
#
# 更新安装器运行在 %LOCALAPPDATA%\Pi-Workbench-Update（安装目录之外）：electron-builder
# 的卸载器会按 $INSTDIR 路径前缀结束进程，安装器若从安装目录内启动会被误杀。
# 安装完成后写标记，新版本首次启动时清空外部缓存。

!define UPDATER_CACHE_ROOT "$LOCALAPPDATA\Pi-Workbench-Update"
!define UPDATER_CACHE_FLAG "$LOCALAPPDATA\Pi-Workbench-Update.flag"
# electron-builder 安装器把自己复制到这里供差分更新使用（APP_INSTALLER_STORE_FILE）。
# 名称取自 appInfo.updaterCacheDirName，与 app-update.yml 保持一致；改了缓存目录名要同步。
!define PI_UPDATER_STORE "$LOCALAPPDATA\pi-workbench-updater"

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
    # 没有清单：更新时保守处理（不删任何文件），卸载时退回整目录删除
    ${ifNot} ${isUpdated}
      RMDir /r $INSTDIR
      Goto pwEnd
    ${endIf}
    DetailPrint "Installer manifest not found; skipping file removal."
    Goto pwEnd

  pwAfterDirs:
    Delete "$INSTDIR\resources\installer-manifest.files.txt"
    Delete "$INSTDIR\resources\installer-manifest.dirs.txt"

    ${ifNot} ${isUpdated}
      # 安装器生成、不在清单内的文件（更新时由新安装包覆盖）。
      # elevate.exe 由 electron-builder 在 afterPack 之后才放进 resources。
      Delete "$INSTDIR\${UNINSTALL_FILENAME}"
      Delete "$INSTDIR\uninstallerIcon.ico"
      Delete "$INSTDIR\resources\app-update.yml"
      Delete "$INSTDIR\resources\elevate.exe"
      Delete "$INSTDIR\.write-probe"
      RMDir "$INSTDIR\resources"

      # 运行时数据（更新时保留，卸载时删除）
      RMDir /r "$INSTDIR\config"
      RMDir /r "$INSTDIR\data"
      RMDir /r "$INSTDIR\logs"
      RMDir /r "$INSTDIR\cache"

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

  # 安装器在 LOCALAPPDATA 的差分副本：更新缓存已改到外部专用目录，
  # 这份副本不会被 electron-updater 读取，安装完成后直接删除。
  Delete "${PI_UPDATER_STORE}\installer.exe"
  RMDir /r "${PI_UPDATER_STORE}"

  # 更新后让 Windows 立刻丢弃旧的 shell 缓存：
  # SHCNE_ASSOCCHANGED 通知图标 / 文件关联 / 快捷方式失效，ie4uinit 重建图标缓存库。
  # 两者都是尽力而为，失败不影响安装；应用侧首启还有一次兜底（electron/shell-refresh.ts）。
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x0000, i 0, i 0)'
  Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend
