@echo off
title Pragmatic Ballooning App
echo Cleaning up old background processes...
taskkill /F /IM node.exe >nul 2>&1

cd /d "%~dp0"

echo === Pragmatic Ballooning Application ===
echo.

echo Checking Backend dependencies...
if not exist "backend\node_modules" (
    echo Installing Backend Dependencies - First Time Setup...
    cd backend
    call npm install
    cd ..
)

echo Checking Frontend dependencies...
if not exist "frontend\node_modules" (
    echo Installing Frontend Dependencies - First Time Setup...
    cd frontend
    call npm install
    cd ..
)

echo.
echo Starting Backend Server...
start "Backend - Pragmatic Ballooning" cmd /k "title Backend && cd backend && node server.js"

echo Waiting for backend to start...
timeout /t 3 /nobreak >nul

echo Starting Frontend UI...
start "Frontend - Pragmatic Ballooning" cmd /k "title Frontend && cd frontend && npm run dev -- --open"

echo.
echo Application is starting up...
echo Backend:  http://localhost:5000
echo Frontend: http://localhost:3000
echo.
echo Both windows will open automatically.
echo Close both black windows to stop the app.
echo.
pause
