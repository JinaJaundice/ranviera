; The owner's installer adds a second shortcut that opens the synthetic Northgate Synthetic Bank demonstrator in a window of
; its own (desktop/main.cjs, --demo). The public installer does not include this file.
!macro customInstall
  CreateShortCut "$DESKTOP\Ranviera demonstrator.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--demo" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\Ranviera demonstrator.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--demo" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Ranviera demonstrator.lnk"
  Delete "$SMPROGRAMS\Ranviera demonstrator.lnk"
!macroend
