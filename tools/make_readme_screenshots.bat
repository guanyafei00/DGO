@echo off
rem Make README screenshots: runs DGO in capture mode (auto switches pages, saves 3 PNG, exits)
rem ASCII only - cmd.exe decodes this file as GBK
set DGO_CAPTURE=1
"C:\Users\GG\WorkBuddy\2026-10-04-09-08-25\app\node_modules\electron\dist\electron.exe" "C:\Users\GG\WorkBuddy\2026-10-04-09-08-25\app"
echo.
echo Done. Check: C:\Users\GG\WorkBuddy\2026-10-04-09-08-25\screenshots
pause
