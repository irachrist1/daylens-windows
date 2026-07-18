# Electron's app.setLoginItemSettings registers launch-on-login as an HKCU Run
# value named after the AppUserModelId. The value names cover the current AUMID,
# the pre-rename AUMID, and the product name for older installs.
#
# Data: electron-builder's uninstaller only deletes app data when launched with
# --delete-app-data (the in-app "Reset and uninstall" flow passes it after the
# person confirms). A manual, interactive uninstall gets an explicit yes/no
# prompt instead of silent deletion; silent uninstalls (updates, /S) never
# delete data unless the flag was passed.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.daylens.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "dev.christiantonny.daylens"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Daylens"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.daylens.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "dev.christiantonny.daylens"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Daylens"

    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${ifNot} ${Errors}
      # The built-in block also removes $APPDATA\Daylens and $APPDATA\daylens on
      # --delete-app-data; repeating them here keeps the requested reset complete
      # even if that block changes, and adds the legacy directory it never knew.
      RMDir /r "$APPDATA\Daylens"
      RMDir /r "$APPDATA\daylens"
      RMDir /r "$APPDATA\DaylensWindows"
    ${else}
      ClearErrors
      ${GetOptions} $R0 "/S" $R1
      ${if} ${Errors}
        # One-click uninstalls switch to silent mode after their initial
        # confirmation. Restore dialog mode for the explicit data choice.
        SetSilent normal
        MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your local Daylens data (timeline database and settings)?$\r$\n$\r$\nChoose No to keep it for a future install." /SD IDNO IDYES daylensDeleteData IDNO daylensKeepData
        daylensDeleteData:
          RMDir /r "$APPDATA\Daylens"
          RMDir /r "$APPDATA\daylens"
          RMDir /r "$APPDATA\DaylensWindows"
        daylensKeepData:
        SetSilent silent
      ${endif}
    ${endif}
  ${endif}
!macroend
