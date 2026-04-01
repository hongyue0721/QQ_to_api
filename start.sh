#!/bin/bash

echo "🚀 一键启动 QQ-to-OpenAI Bridge"
echo "-----------------------------------"

# 1. 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 错误：未检测到 Node.js，请先安装 Node.js (推荐 v18+)"
    exit 1
fi
echo "✅ 检测到 Node.js 版本: $(node -v)"

# 2. 检查 npm
if ! command -v npm &> /dev/null; then
    echo "❌ 错误：未检测到 npm"
    exit 1
fi

# 3. 安装项目依赖
echo "📦 正在安装核心依赖..."
npm install --production --silent
echo "✅ 依赖安装完成！"

# 4. 初始化配置文件
if [ ! -f .env ]; then
    echo "📄 未找到 .env 配置文件，正在从模板生成..."
    cp .env.example .env
    echo "⚠️ 请使用文本编辑器 (如 vim .env) 修改里面的配置（如 NapCat 端口号）"
else
    echo "✅ 读取到已有的 .env 配置文件"
fi

# 5. 安装 PM2（如果尚未安装）并启动
if ! command -v pm2 &> /dev/null; then
    echo "⚙️ 正在安装进程管理工具 PM2..."
    npm install -g pm2 --silent
fi

echo "🟢 正在启动或重启后台服务..."
# 尝试停止已有的同名服务
pm2 stop qq-bridge 2>/dev/null
# 启动服务
pm2 start src/index.js --name "qq-bridge"

echo ""
echo "=================================================="
echo "🎉 启动成功！Bridge 服务已在后台持运行。"
echo "=================================================="
echo "👉 Web 控制面板地址: http://服务器IP:9521"
echo "👉 OpenAI API 接口地址: http://服务器IP:9520"
echo ""
echo "查看运行日志命令: pm2 logs qq-bridge"
echo "重启服务命令:     pm2 restart qq-bridge"
echo "停止服务命令:     pm2 stop qq-bridge"
echo "=================================================="
