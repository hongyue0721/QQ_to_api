// ============================================
// onebot-client.js — OneBot11 WebSocket 客户端
// 管理与 NapCat 的长连接，发送消息并等待回复
// ============================================
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import { RateLimiter } from './rate-limiter.js';

// ---- 零宽字符编解码 ----
const ZW = {
  ZERO: '\u200B',   // 代表 bit 0
  ONE: '\u200C',    // 代表 bit 1
  SEP: '\u200D',    // 分隔符/起始标记
};

function encodeReqId(reqId) {
  // reqId 是 8 字符 hex，编码为零宽字符串
  let bits = '';
  for (const ch of reqId) {
    bits += parseInt(ch, 16).toString(2).padStart(4, '0');
  }
  let encoded = ZW.SEP; // 起始标记
  for (const b of bits) {
    encoded += b === '0' ? ZW.ZERO : ZW.ONE;
  }
  return encoded;
}

function decodeReqId(text) {
  // 从文本中提取零宽编码的 reqId
  const sepIdx = text.lastIndexOf(ZW.SEP);
  if (sepIdx === -1) return null;
  const zwPart = text.slice(sepIdx + 1);
  let bits = '';
  for (const ch of zwPart) {
    if (ch === ZW.ZERO) bits += '0';
    else if (ch === ZW.ONE) bits += '1';
    else break; // 遇到非零宽字符就停止
  }
  if (bits.length < 32) return null; // 8 hex chars = 32 bits
  bits = bits.slice(0, 32);
  let hex = '';
  for (let i = 0; i < 32; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function stripZeroWidth(text) {
  return text.replace(/[\u200B\u200C\u200D]/g, '');
}

// 生成短 reqId (8 hex chars)
function shortId() {
  return uuidv4().replace(/-/g, '').slice(0, 8);
}

// ---- 长文本切分 ----
function splitTextToChunks(text, maxLen = 2000) {
  const chunks = [];
  // 优先按段落分割
  const paragraphs = text.split(/\n\n+/);
  let current = '';
  for (const para of paragraphs) {
    if (para.length > maxLen) {
      // 段落本身就超长，按 maxLen 硬切
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < para.length; i += maxLen) {
        chunks.push(para.slice(i, i + maxLen));
      }
    } else if ((current + '\n\n' + para).length > maxLen) {
      if (current) chunks.push(current);
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

// 构造合并转发 node 数组
function buildForwardNodes(chunks, senderName = 'Bridge', senderUin = '10001') {
  return chunks.map((chunk, i) => ({
    type: 'node',
    data: {
      name: chunks.length > 1 ? `${senderName} (${i + 1}/${chunks.length})` : senderName,
      uin: senderUin,
      content: [{ type: 'text', data: { text: chunk } }],
    },
  }));
}

// 从合并转发消息中递归提取所有文本
function extractForwardText(message) {
  if (!Array.isArray(message)) return '';
  const texts = [];
  for (const seg of message) {
    if (seg.type === 'text') {
      texts.push(seg.data?.text || '');
    } else if (seg.type === 'forward') {
      // 合并转发内可能嵌套 node 列表
      const nodes = seg.data?.content || seg.data?.messages || [];
      for (const node of nodes) {
        const innerMsg = node.data?.content || node.content || [];
        texts.push(extractForwardText(Array.isArray(innerMsg) ? innerMsg : []));
      }
    }
  }
  return texts.filter(Boolean).join('\n');
}

// ---- OneBot Client Class ----
export class OneBotClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.echoCallbacks = new Map();    // echo -> { resolve, reject, timer }
    this.pendingReplies = new Map();   // reqId -> { resolve, reject, timer, groupId, userId, sentMsgId }
    this.rateLimiter = new RateLimiter(getConfig().rateLimitMs);

    // 统计
    this.stats = {
      messagesSent: 0,
      repliesReceived: 0,
      timeouts: 0,
      errors: 0,
    };
  }

  connect() {
    const config = getConfig();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }

    const url = config.napcatWsUrl;
    const headers = {};
    if (config.napcatToken) {
      headers['Authorization'] = `Bearer ${config.napcatToken}`;
    }

    logger.info(`[OneBot] 正在连接 ${url} ...`);
    this.ws = new WebSocket(url, { headers, handshakeTimeout: 5000 });

    this.ws.on('open', () => {
      this.connected = true;
      logger.info('[OneBot] ✅ 已连接到 NapCat OneBot');
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this.handleMessage(data);
      } catch (err) {
        logger.error('[OneBot] 消息解析失败:', err.message);
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      logger.warn('[OneBot] ❌ 连接已断开');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.connected = false;
      logger.error('[OneBot] 连接错误:', err.message);
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('[OneBot] 尝试重连...');
      this.connect();
    }, 5000);
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
  }

  // 发送 OneBot Action 并等待 API 响应
  sendAction(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) {
        return reject(new Error('OneBot WebSocket 未连接'));
      }
      const echo = uuidv4();
      const timer = setTimeout(() => {
        this.echoCallbacks.delete(echo);
        reject(new Error(`Action ${action} 超时`));
      }, 15000);

      this.echoCallbacks.set(echo, { resolve, reject, timer });

      const payload = JSON.stringify({ action, params, echo });
      this.ws.send(payload);
      logger.debug(`[OneBot] → ${action}`, JSON.stringify(params).slice(0, 200));
    });
  }

  // 处理所有收到的 WS 消息
  handleMessage(data) {
    // 1. API 响应 (有 echo 字段)
    if (data.echo && this.echoCallbacks.has(data.echo)) {
      const cb = this.echoCallbacks.get(data.echo);
      this.echoCallbacks.delete(data.echo);
      clearTimeout(cb.timer);
      if (data.status === 'ok' || data.retcode === 0) {
        cb.resolve(data.data || data);
      } else {
        cb.reject(new Error(data.message || data.wording || `Action failed: ${data.retcode}`));
      }
      return;
    }

    // 2. 事件 (消息上报等)
    if (data.post_type === 'message') {
      this.handleIncomingMessage(data);
    }
    // 忽略心跳等其他事件
  }

  // 处理收到的 QQ 消息
  handleIncomingMessage(msg) {
    const config = getConfig();
    const senderId = String(msg.user_id || '');
    const groupId = String(msg.group_id || '');
    const selfId = String(msg.self_id || '');

    // 忽略自己发的消息
    if (senderId === selfId) return;

    // 白名单过滤
    if (config.whitelistUsers.length > 0) {
      if (!config.whitelistUsers.includes(senderId)) {
        return;
      }
    }

    // 提取纯文本 — 优先尝试从合并转发中提取
    let text = '';
    if (typeof msg.message === 'string') {
      text = msg.message;
    } else if (Array.isArray(msg.message)) {
      // 检查是否包含合并转发消息
      const hasForward = msg.message.some(seg => seg.type === 'forward');
      if (hasForward) {
        text = extractForwardText(msg.message);
        logger.debug(`[OneBot] 📦 从合并转发中提取文本 (${text.length} 字符)`);
      } else {
        text = msg.message
          .filter(seg => seg.type === 'text')
          .map(seg => seg.data?.text || '')
          .join('');
      }
    }
    if (!text.trim()) return;

    const messageId = String(msg.message_id || '');
    logger.info(`[OneBot] ← 收到消息 [${msg.message_type}] from ${senderId}${groupId ? ` in group ${groupId}` : ''}: ${stripZeroWidth(text).slice(0, 100)}`);

    // 尝试匹配 pending request

    // 策略1: 检查是否引用了我们发的消息 (reply)
    let replyToMsgId = null;
    if (Array.isArray(msg.message)) {
      const replySeg = msg.message.find(seg => seg.type === 'reply');
      if (replySeg) {
        replyToMsgId = String(replySeg.data?.id || '');
      }
    }

    if (replyToMsgId) {
      // 通过 sentMsgId 匹配
      for (const [reqId, pending] of this.pendingReplies) {
        if (pending.sentMsgId === replyToMsgId) {
          const cleanText = stripZeroWidth(text);
          this.resolveReply(reqId, cleanText);
          return;
        }
      }
    }

    // 策略2: 尝试从消息中解码零宽字符 reqId (如果对方复制了原始消息)
    const decodedReqId = decodeReqId(text);
    if (decodedReqId && this.pendingReplies.has(decodedReqId)) {
      const cleanText = stripZeroWidth(text);
      this.resolveReply(decodedReqId, cleanText);
      return;
    }

    // 策略3: 时序匹配 — 匹配同一群/同一用户中最早的 pending request
    for (const [reqId, pending] of this.pendingReplies) {
      const matchGroup = pending.groupId && pending.groupId === groupId;
      const matchUser = pending.userId && pending.userId === senderId && !groupId;
      if (matchGroup || matchUser) {
        const cleanText = stripZeroWidth(text);
        this.resolveReply(reqId, cleanText);
        return;
      }
    }
  }

  resolveReply(reqId, text) {
    const pending = this.pendingReplies.get(reqId);
    if (!pending) return;
    this.pendingReplies.delete(reqId);
    clearTimeout(pending.timer);
    this.stats.repliesReceived++;
    logger.info(`[OneBot] ✅ 匹配回复 req=${reqId}: ${text.slice(0, 80)}...`);
    pending.resolve(text);
  }

  /**
   * 核心方法: 发送消息到 QQ 并等待回复
   * @param {object} options
   * @param {string} options.groupId - 群号 (与 userId 二选一)
   * @param {string} options.userId - 好友 QQ (与 groupId 二选一)
   * @param {string} options.text - 发送的文本
   * @param {number} options.timeoutMs - 超时
   * @returns {Promise<string>} 回复文本
   */
  async sendAndWaitReply({ groupId, userId, text, timeoutMs }) {
    const config = getConfig();
    const reqId = shortId();
    const taggedText = text + encodeReqId(reqId);
    const threshold = config.forwardMsgThreshold || 2000;
    const useForward = taggedText.length > threshold;

    // 构造发送参数
    let action, params;
    if (groupId) {
      if (useForward) {
        // 超长文本 → 合并转发
        const chunks = splitTextToChunks(taggedText, threshold);
        action = 'send_group_forward_msg';
        params = {
          group_id: groupId,
          messages: buildForwardNodes(chunks),
        };
        logger.info(`[OneBot] 📦 长文本分为 ${chunks.length} 段合并转发 (总 ${taggedText.length} 字)`);
      } else {
        action = 'send_group_msg';
        params = {
          group_id: groupId,
          message: [{ type: 'text', data: { text: taggedText } }],
        };
      }
    } else if (userId) {
      if (useForward) {
        const chunks = splitTextToChunks(taggedText, threshold);
        action = 'send_private_forward_msg';
        params = {
          user_id: userId,
          messages: buildForwardNodes(chunks),
        };
        logger.info(`[OneBot] 📦 长文本分为 ${chunks.length} 段合并转发 (总 ${taggedText.length} 字)`);
      } else {
        action = 'send_private_msg';
        params = {
          user_id: userId,
          message: [{ type: 'text', data: { text: taggedText } }],
        };
      }
    } else {
      throw new Error('必须指定 group_id 或 user_id');
    }

    // 通过限流队列发送
    const sendResult = await this.rateLimiter.enqueue(async () => {
      return await this.sendAction(action, params);
    });

    const sentMsgId = String(sendResult?.message_id || '');
    this.stats.messagesSent++;
    logger.info(`[OneBot] 📤 消息已发送 req=${reqId} msgId=${sentMsgId}`);

    // 注册 pending reply
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(reqId);
        this.stats.timeouts++;
        logger.warn(`[OneBot] ⏰ 超时 req=${reqId} (${timeoutMs}ms)`);
        reject(new Error('TIMEOUT'));
      }, timeoutMs);

      this.pendingReplies.set(reqId, {
        resolve,
        reject,
        timer,
        groupId: groupId || '',
        userId: userId || '',
        sentMsgId,
      });
    });
  }

  getStats() {
    return {
      connected: this.connected,
      pendingCount: this.pendingReplies.size,
      ...this.stats,
    };
  }
}
