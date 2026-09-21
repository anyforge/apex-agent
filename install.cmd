@echo off
rem ============================================================================
rem Apex Agent Windows Installer — double-click entry
rem Apex Agent Windows 安装器 — 双击入口
rem
rem 双击此文件即可安装；它用 -ExecutionPolicy Bypass 调用 install.ps1，
rem 避免 PowerShell 默认执行策略阻止脚本运行。
rem Double-click to install; calls install.ps1 with -ExecutionPolicy Bypass.
rem ============================================================================

setlocal
cd /d "%~dp0"

echo.
echo [Apex Agent] 正在启动安装脚本... / Starting installer...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

if errorlevel 1 (
    echo.
    echo [Apex Agent] 安装失败 / Install failed.
    pause
    exit /b 1
)

echo.
echo [Apex Agent] 完成 / Done.
pause
