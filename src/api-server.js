// ============================================
// api-server.js — OpenAI 兼容 API + WebUI 后端
// ============================================
import express from 'express';
import cors from 'cors';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, updateConfig } from './config.js';
import { logger, initLogWebSocket, getLogBuffer } from './logger.js';
import { mediaToMarkdownText } from './onebot-client.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 解析 OpenAI 多模态 content 格式，转换为 text + OneBot 消息段
 * OpenAI content 可以是 string 或 array:
 *   [ { type: 'text', text: '...' }, { type: 'image_url', image_url: { url: '...' } } ]
 * @param {string|Array} content
 * @returns {{ text: string, segments: Array }} text 和额外的 OneBot segment
 */
function parseOpenAIContent(content) {
  if (typeof content === 'string') {
    return { text: content, segments: [] };
  }

  if (!Array.isArray(content)) {
    return { text: String(content || ''), segments: [] };
  }

  const textParts = [];
  const segments = [];

  for (const part of content) {
    if (part.type === 'text') {
      textParts.push(part.text || '');
    } else if (part.type === 'image_url') {
      const url = part.image_url?.url || '';
      if (url) {
        // Base64 data URL 或 HTTP URL 都支持
        segments.push({
          type: 'image',
          data: { file: url },
        });
      }
    }
    // 未来可以这里拓展支持 input_audio 等
  }

  return { text: textParts.join('\n'), segments };
}

/**
 * 创建 Bridge API 服务器 (OpenAI 兼容端点)
 */
export function createBridgeServer(onebotClient) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // ---- 鉴权中间件 ----
  function authMiddleware(req, res, next) {
    const config = getConfig();
    if (!config.apiKey) return next();
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (token === config.apiKey) return next();
    return res.status(401).json({ error: { message: 'Invalid API Key', type: 'auth_error' } });
  }

  // ---- GET /v1/models ----
  app.get('/v1/models', authMiddleware, (req, res) => {
    res.json({
      object: 'list',
      data: [
        {
          id: 'qpt-5.4',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'qq-bridge',
        },
        {
          id: 'qlaude-opus-4-6',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'qq-bridge',
        },
      ],
    });
  });

  // ---- POST /v1/chat/completions — 核心接口 ----
  app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
    const config = getConfig();

    if (!config.serviceEnabled) {
      return res.status(503).json({
        error: { message: '服务已暂停，请在 WebUI 中启用', type: 'service_disabled' },
      });
    }

    if (!onebotClient.connected) {
      return res.status(502).json({
        error: { message: 'OneBot WebSocket 未连接', type: 'connection_error' },
      });
    }

    const { messages, model, stream } = req.body;
    // 从请求中提取动态 group_id / user_id
    const groupId = req.body.group_id || req.body.extra?.group_id || config.defaultGroupId;
    const userId = req.body.user_id || req.body.extra?.user_id || config.defaultUserId;

    if (!groupId && !userId) {
      return res.status(400).json({
        error: { message: '未配置目标群号或好友 QQ，请在 WebUI 中设置或请求中传入 group_id', type: 'config_error' },
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: { message: 'messages 参数不合法', type: 'invalid_request_error' },
      });
    }

    // 构造发送内容：支持多模态 content
    let sendText = '';
    let mediaSegments = [];

    if (config.contextMode === 'full') {
      // 拼接完整对话历史
      const parts = [];
      for (const m of messages) {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统';
        const parsed = parseOpenAIContent(m.content);
        parts.push(`[${role}]: ${parsed.text}`);
        // 只在最后一条消息中带上媒体段
        if (m === messages[messages.length - 1]) {
          mediaSegments = parsed.segments;
        }
      }
      sendText = parts.join('\n');
    } else {
      // 只取最后一条 user 消息
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      if (lastUser) {
        const parsed = parseOpenAIContent(lastUser.content);
        sendText = parsed.text;
        mediaSegments = parsed.segments;
      }
    }

    if (!sendText.trim() && mediaSegments.length === 0) {
      return res.status(400).json({
        error: { message: '消息内容为空', type: 'invalid_request_error' },
      });
    }

    if (mediaSegments.length > 0) {
      logger.info(`[API] 🖼️ 检测到 ${mediaSegments.length} 个媒体段 (图片/文件)`);
    }

    const requestId = uuidv4().slice(0, 8);
    logger.info(`[API] 📥 收到请求 req=${requestId} model=${model || 'default'} target=${groupId || userId}`);

    try {
      const replyMedia = await onebotClient.sendAndWaitReply({
        groupId: groupId || '',
        userId: groupId ? '' : userId,
        text: sendText,
        segments: mediaSegments,
        timeoutMs: config.replyTimeoutMs,
      });

      // 将回复的多模态内容转换为 Markdown 文本
      const replyText = mediaToMarkdownText(replyMedia);

      const completionId = `chatcmpl-qq-${requestId}`;
      const responseBody = {
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'qpt-5.4',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: replyText },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };

      logger.info(`[API] 📤 返回响应 req=${requestId} len=${replyText.length}`);

      // 处理 streaming 请求 — 一次性推送
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model || 'qpt-5.4',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: replyText },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);

        const doneChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model || 'qpt-5.4',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      return res.json(responseBody);
    } catch (err) {
      if (err.message === 'TIMEOUT') {
        logger.warn(`[API] ⏰ 请求超时 req=${requestId}`);
        return res.status(504).json({
          error: { message: `QQ 回复超时 (${config.replyTimeoutMs}ms)`, type: 'timeout_error' },
        });
      }
      logger.error(`[API] 请求失败 req=${requestId}:`, err.message);
      return res.status(500).json({
        error: { message: err.message, type: 'internal_error' },
      });
    }
  });

  // ---- Health Check ----
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: onebotClient.connected });
  });

  return app;
}

/**
 * 创建 WebUI 服务器（控制面板 + 管理 API）
 */
export function createWebuiServer(onebotClient) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // 静态文件
  app.use(express.static(join(__dirname, '..', 'public')));

  // ---- GET /api/status ----
  app.get('/api/status', (req, res) => {
    const config = getConfig();
    res.json({
      serviceEnabled: config.serviceEnabled,
      onebot: onebotClient.getStats(),
      config: {
        napcatWsUrl: config.napcatWsUrl,
        defaultGroupId: config.defaultGroupId,
        defaultUserId: config.defaultUserId,
        whitelistUsers: config.whitelistUsers,
        replyTimeoutMs: config.replyTimeoutMs,
        rateLimitMs: config.rateLimitMs,
        apiKey: config.apiKey,
        contextMode: config.contextMode,
        bridgePort: config.bridgePort,
      },
    });
  });

  // ---- GET /api/config ----
  app.get('/api/config', (req, res) => {
    const config = getConfig();
    res.json({
      napcatWsUrl: config.napcatWsUrl,
      napcatToken: config.napcatToken ? '***' : '',
      defaultGroupId: config.defaultGroupId,
      defaultUserId: config.defaultUserId,
      whitelistUsers: config.whitelistUsers.join(','),
      replyTimeoutMs: config.replyTimeoutMs,
      rateLimitMs: config.rateLimitMs,
      apiKey: config.apiKey,
      contextMode: config.contextMode,
    });
  });

  // ---- POST /api/config ----
  app.post('/api/config', (req, res) => {
    const patch = req.body;
    const updated = updateConfig(patch);
    // 更新限流间隔
    onebotClient.rateLimiter.updateInterval(updated.rateLimitMs);
    logger.info('[WebUI] 🔧 配置已更新');
    res.json({ status: 'ok', config: updated });
  });

  // ---- POST /api/toggle ----
  app.post('/api/toggle', (req, res) => {
    const config = getConfig();
    config.serviceEnabled = !config.serviceEnabled;
    logger.info(`[WebUI] 🔀 服务${config.serviceEnabled ? '已启用' : '已暂停'}`);
    res.json({ serviceEnabled: config.serviceEnabled });
  });

  // ---- POST /api/reconnect ----
  app.post('/api/reconnect', (req, res) => {
    logger.info('[WebUI] 🔄 手动重连 OneBot');
    onebotClient.disconnect();
    setTimeout(() => onebotClient.connect(), 500);
    res.json({ status: 'ok' });
  });

  // ---- POST /api/test ----
  app.post('/api/test', async (req, res) => {
    const { groupId, userId, text } = req.body;
    const config = getConfig();
    const targetGroup = groupId || config.defaultGroupId;
    const targetUser = userId || config.defaultUserId;

    if (!targetGroup && !targetUser) {
      return res.status(400).json({ error: '未指定目标群号或好友 QQ' });
    }

    try {
      const replyMedia = await onebotClient.sendAndWaitReply({
        groupId: targetGroup || '',
        userId: targetGroup ? '' : targetUser,
        text: text || '连通性测试 / Bridge Test',
        timeoutMs: config.replyTimeoutMs,
      });
      const replyText = mediaToMarkdownText(replyMedia);
      res.json({ status: 'ok', reply: replyText });
    } catch (err) {
      res.json({ status: 'error', error: err.message });
    }
  });

  // ---- GET /api/logs ----
  app.get('/api/logs-history', (req, res) => {
    res.json(getLogBuffer());
  });

  const server = http.createServer(app);

  // 初始化日志 WebSocket
  initLogWebSocket(server);

  return server;
}
