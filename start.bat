@echo off
chcp 65001 >nul
echo 🚀 一键启动 QQ-to-OpenAI Bridge
echo -----------------------------------

REM 1. 检查 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 错误：未检测到 Node.js，请先前往 nodejs.org 安装 Node.js
    pause
    exit /b
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo ✅ 检测到 Node.js 版本: %NODE_VER%

REM 2. 安装项目依赖
echo 📦 正在安装核心依赖...
call npm install --production --silent
if %errorlevel% neq 0 (
    echo ❌ 依赖安装失败，请检查网络。
    pause
    exit /b
)
echo ✅ 依赖安装完成！

REM 3. 初始化配置文件
if not exist .env (
    echo 📄 未找到 .env 配置文件，正在从模板生成...
    copy .env.example .env >nul
    echo ⚠️ 请使用记事本打开 .env 并修改里面的配置（如 NapCat 端口号）
) else (
    echo ✅ 读取到已有的 .env 配置文件
)

REM 4. 启动服务
echo 🟢 正在启动或重启后台服务...
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo ⚙️ 未检测到 pm2，将使用普通方式启动...（关闭窗口则服务停止）
    echo ==================================================
    echo 🎉 启动成功！你可以访问 WebUI: http://127.0.0.1:9521
    echo 👉 OpenAI API 接口地址: http://127.0.0.1:9520
    echo ==================================================
    node src/index.js
) else (
    call pm2 stop qq-bridge 2>nul
    call pm2 start src/index.js --name "qq-bridge"
    echo ==================================================
    echo 🎉 启动成功！Bridge 服务已由 PM2 在后台持运行。
    echo ==================================================
    echo 👉 Web 控制面板地址: http://127.0.0.1:9521
    echo 👉 OpenAI API 接口地址: http://127.0.0.1:9520
    echo.
    echo 查看日志命令: pm2 logs qq-bridge
    echo 停止服务命令: pm2 stop qq-bridge
    echo ==================================================
)
pause
