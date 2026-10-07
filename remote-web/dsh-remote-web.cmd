@echo off
rem Thin wrapper so the launcher can be double-clicked or called from cmd.exe.
setlocal
set "PS=pwsh"
where pwsh >nul 2>nul || set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-remote-web.ps1" %*
if "%~1"=="" pause
endlocal
