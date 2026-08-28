@echo off
title Pragmatic Ballooning App
echo Cleaning up old background processes...
taskkill /F /IM node.exe >nul 2>&1

cd /d "%~dp0"

echo Checking Backend dependencies...
if not exist "backend\node_modules" (
    echo Installing Backend Dependencies (First Time Setup)...
    cd backend
    call npm install
    cd ..
)

echo Checking Frontend dependencies...
if not exist "frontend\node_modules" (
    echo Installing Frontend Dependencies (First Time Setup)...
    cd frontend
    call npm install
    cd ..
)

echo Starting Background Services...
start "Backend Services" cmd /k "cd backend && start /B node server.js"

echo Starting Frontend UI...
start "Frontend UI" cmd /k "cd frontend && npm run dev -- --open"
