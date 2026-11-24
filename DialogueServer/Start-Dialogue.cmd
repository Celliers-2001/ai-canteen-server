@echo off
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required to start the dialogue service.
    pause
    exit /b 1
)
choice /C DL /N /M "D = DeepSeek, L = Local offline demo: "
if errorlevel 2 (
    node "%~dp0dialogue.mjs" --mock
) else (
    node "%~dp0dialogue.mjs" --prompt
)
pause
