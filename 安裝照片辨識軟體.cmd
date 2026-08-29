@echo off
chcp 65001 >nul
setlocal
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-AI.ps1"
echo.
pause
