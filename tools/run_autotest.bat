@echo off
rem DGO autotest: run on user desktop (Electron GUI cannot run in agent sandbox)
cd /d "%~dp0..\app"
set FETCHIE_AUTOTEST=1
C:\Users\GG\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules\electron\cli.js .
echo.
echo ===== autotest finished (look for M1_E2E_PASS above) =====
pause
