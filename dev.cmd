@echo off
cd /d "%~dp0"
if exist "src-tauri\target\release\mild-editor.exe" (
  start "" "src-tauri\target\release\mild-editor.exe"
  exit /b 0
)
echo Mild Editor has not been built yet. Run npm run tauri:build first.
pause
