@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer first.
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  call npm.cmd ci --omit=dev --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Open http://localhost:8787 in Edge or Chrome.
echo Keep this window open. Press Ctrl+C to stop.
call npm.cmd start
pause
