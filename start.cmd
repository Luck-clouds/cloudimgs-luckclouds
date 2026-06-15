@echo off
setlocal

cd /d %~dp0

echo Starting cloudimgs...

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed.
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo npm is not installed.
    exit /b 1
)

if not exist node_modules (
    echo Installing server dependencies...
    call npm install
    if errorlevel 1 (
        echo Server dependency install failed.
        exit /b 1
    )
)

if not exist client\node_modules (
    echo Installing client dependencies...
    cd /d client
    call npm install
    if errorlevel 1 (
        echo Client dependency install failed.
        exit /b 1
    )
    cd /d %~dp0
)

echo Building client...
cd /d client
call npm run build
if errorlevel 1 (
    echo Client build failed.
    exit /b 1
)
cd /d %~dp0

echo Starting server...
echo Open http://localhost:3001

call npm start
