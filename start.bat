@echo off
title Orbyte SmartDesk
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install it from https://nodejs.org and try again.
  pause
  exit /b
)
echo Starting Orbyte SmartDesk...
echo Keep this window open. Close it to stop the website.
start "" http://localhost:3000
node server.js
pause
