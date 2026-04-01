// ============================================
// index.js — 入口：启动所有服务
// ============================================
import { loadRuntimeConfig, getConfig } from './config.js';
import { logger } from './logger.js';
import { OneBotClient } from './onebot-client.js';
import { createBridgeServer, createWebuiServer } from './api-server.js';
import http from 'http';

// 加载已保存的运行时配置
loadRuntimeConfig();

const config = getConfig();

logger.info('╔══════════════════════════════════════════╗');
logger.info('║     QQ-to-OpenAI Bridge  v1.0.0          ║');
logger.info('╚══════════════════════════════════════════╝');

// 1. 初始化 OneBot 客户端
const onebotClient = new OneBotClient();
onebotClient.connect();

// 2. 启动 Bridge API 服务器 (OpenAI 兼容端口)
const bridgeApp = createBridgeServer(onebotClient);
const bridgeServer = http.createServer(bridgeApp);
bridgeServer.listen(config.bridgePort, () => {
  logger.info(`[Bridge] 🚀 OpenAI API 已启动: http://127.0.0.1:${config.bridgePort}`);
  logger.info(`[Bridge]    POST /v1/chat/completions`);
  logger.info(`[Bridge]    GET  /v1/models`);
});

// 3. 启动 WebUI 服务器
const webuiServer = createWebuiServer(onebotClient);
webuiServer.listen(config.webuiPort, () => {
  logger.info(`[WebUI] 🎛️  控制面板已启动: http://127.0.0.1:${config.webuiPort}`);
});

// 4. 优雅关闭
function shutdown() {
  logger.info('[System] 正在关闭...');
  onebotClient.disconnect();
  bridgeServer.close();
  webuiServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logger.info(`[Config] 目标群号: ${config.defaultGroupId || '(未设置)'}`);
logger.info(`[Config] 目标好友: ${config.defaultUserId || '(未设置)'}`);
logger.info(`[Config] 白名单:   ${config.whitelistUsers.length > 0 ? config.whitelistUsers.join(', ') : '(不过滤)'}`);
logger.info(`[Config] 超时:     ${config.replyTimeoutMs}ms`);
logger.info(`[Config] 限流:     ${config.rateLimitMs}ms/条`);
logger.info(`[Config] API Key:  ${config.apiKey}`);
