@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo 启动 云图 应用...

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js 未安装，请先安装 Node.js
    exit /b 1
)

where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo npm 未安装，请先安装 npm
    exit /b 1
)

if not exist ".\node_modules\" (
    echo 安装后端依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo 后端依赖安装失败
        exit /b 1
    )
)

if not exist ".\client\node_modules\" (
    echo 安装前端依赖...
    cd /d ".\client"
    call npm install
    if %errorlevel% neq 0 (
        echo 前端依赖安装失败
        exit /b 1
    )
    cd /d "%~dp0"
)

echo 构建前端...
cd /d ".\client"
call npm run build
if %errorlevel% neq 0 (
    echo 前端构建失败
    exit /b 1
)
cd /d "%~dp0"

echo 启动服务器...
echo 访问地址: http://localhost:3001
echo 按 Ctrl+C 停止服务

call npm start
