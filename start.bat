@echo off
title Horizon Task Organizer
cd /d "%~dp0"
echo Starting Horizon...
where py >nul 2>nul
if %errorlevel%==0 (
  py server.py %*
) else (
  python server.py %*
)
pause
