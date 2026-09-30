# electron-builder 的 NSIS 模板（include/installer.nsh）每次安装都会把安装包自身复制一份到
# %LOCALAPPDATA%\dym-updater\installer.exe，那是留给 electron-updater 做差分更新用的。
# 本项目已移除自动更新，这份 ~195MB 的副本纯属白占地方，装完即清。
!macro customInstall
  Delete "$LOCALAPPDATA\dym-updater\installer.exe"
  RMDir "$LOCALAPPDATA\dym-updater"
!macroend
