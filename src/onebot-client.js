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

// ---- 多模态消息提取 ----
/**
 * 从 OneBot 消息段数组中提取所有富媒体内容
 * @param {Array} segments - OneBot message segment 数组
 * @returns {{ text: string, images: Array, files: Array, audio: Array, video: Array }}
 */
function extractMultimodalContent(segments) {
  const result = { text: '', images: [], files: [], audio: [], video: [] };
  if (!Array.isArray(segments)) return result;

  const textParts = [];

  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        textParts.push(seg.data?.text || '');
        break;

      case 'image': {
        const url = seg.data?.url || seg.data?.file || '';
        const fileId = seg.data?.file_id || '';
        if (url || fileId) {
          result.images.push({
            url: url,
            file_id: fileId,
            file_size: seg.data?.file_size || '',
            file_unique: seg.data?.file_unique || '',
          });
        }
        break;
      }

      case 'file': {
        const url = seg.data?.url || seg.data?.file || '';
        const name = seg.data?.name || 'file';
        result.files.push({
          name,
          url,
          file_id: seg.data?.file_id || '',
          file_size: seg.data?.file_size || '',
        });
        break;
      }

      case 'record': {
        const url = seg.data?.url || seg.data?.file || '';
        result.audio.push({
          url,
          file_id: seg.data?.file_id || '',
          file_size: seg.data?.file_size || '',
        });
        break;
      }

      case 'video': {
        const url = seg.data?.url || seg.data?.file || '';
        result.video.push({
          url,
          file_id: seg.data?.file_id || '',
          file_size: seg.data?.file_size || '',
          name: seg.data?.name || 'video',
        });
        break;
      }

      case 'forward': {
        // 合并转发提取文本（递归）
        textParts.push(extractForwardText([seg]));
        break;
      }

      // reply / at / face 等不提取
      default:
        break;
    }
  }

  result.text = textParts.join('');
  return result;
}

/**
 * 将富媒体结构体序列化为 OpenAI content 格式
 * @param {{ text, images, files, audio, video }} media
 * @returns {string | Array} OpenAI content (string 或 content 数组)
 */
export function mediaToOpenAIContent(media) {
  const hasMedia = media.images.length > 0 || media.files.length > 0 || media.audio.length > 0 || media.video.length > 0;

  if (!hasMedia) {
    return media.text;
  }

  // 构造 OpenAI 多模态 content 数组
  const contentParts = [];

  // 文本部分
  if (media.text) {
    contentParts.push({ type: 'text', text: media.text });
  }

  // 图片 → image_url
  for (const img of media.images) {
    if (img.url) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: img.url },
      });
    }
  }

  // 文件/音频/视频 → 附加为文本描述 + URL
  for (const f of media.files) {
    contentParts.push({
      type: 'text',
      text: `\n📎 [文件: ${f.name}](${f.url})`,
    });
  }
  for (const a of media.audio) {
    contentParts.push({
      type: 'text',
      text: `\n🎵 [语音消息](${a.url})`,
    });
  }
  for (const v of media.video) {
    contentParts.push({
      type: 'text',
      text: `\n🎬 [视频: ${v.name}](${v.url})`,
    });
  }

  return contentParts;
}

/**
 * 将富媒体结构体序列化为纯文本 (Markdown 风格，含图片链接)
 */
export function mediaToMarkdownText(media) {
  const parts = [];
  if (media.text) parts.push(media.text);
  for (const img of media.images) {
    if (img.url) parts.push(`![image](${img.url})`);
  }
  for (const f of media.files) {
    parts.push(`📎 [${f.name}](${f.url})`);
  }
  for (const a of media.audio) {
    parts.push(`🎵 [语音消息](${a.url})`);
  }
  for (const v of media.video) {
    parts.push(`🎬 [${v.name}](${v.url})`);
  }
  return parts.join('\n');
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

    // 提取多模态内容（文本 + 图片 + 文件 + 音频 + 视频）
    let media;
    if (typeof msg.message === 'string') {
      media = { text: msg.message, images: [], files: [], audio: [], video: [] };
    } else if (Array.isArray(msg.message)) {
      media = extractMultimodalContent(msg.message);
    } else {
      media = { text: '', images: [], files: [], audio: [], video: [] };
    }

    const text = media.text;
    const hasMedia = media.images.length > 0 || media.files.length > 0 || media.audio.length > 0 || media.video.length > 0;
    if (!text.trim() && !hasMedia) return;

    const messageId = String(msg.message_id || '');
    const mediaInfo = hasMedia ? ` [+${media.images.length}img ${media.files.length}file ${media.audio.length}audio ${media.video.length}video]` : '';
    logger.info(`[OneBot] ← 收到消息 [${msg.message_type}] from ${senderId}${groupId ? ` in group ${groupId}` : ''}${mediaInfo}: ${stripZeroWidth(text).slice(0, 100)}`);

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
          media.text = stripZeroWidth(media.text);
          this.resolveReply(reqId, media);
          return;
        }
      }
    }

    // 策略2: 尝试从消息中解码零宽字符 reqId (如果对方复制了原始消息)
    const decodedReqId = decodeReqId(text);
    if (decodedReqId && this.pendingReplies.has(decodedReqId)) {
      media.text = stripZeroWidth(media.text);
      this.resolveReply(decodedReqId, media);
      return;
    }

    // 策略3: 时序匹配 — 匹配同一群/同一用户中最早的 pending request
    for (const [reqId, pending] of this.pendingReplies) {
      const matchGroup = pending.groupId && pending.groupId === groupId;
      const matchUser = pending.userId && pending.userId === senderId && !groupId;
      if (matchGroup || matchUser) {
        media.text = stripZeroWidth(media.text);
        this.resolveReply(reqId, media);
        return;
      }
    }
  }

  resolveReply(reqId, media) {
    const pending = this.pendingReplies.get(reqId);
    if (!pending) return;
    this.pendingReplies.delete(reqId);
    clearTimeout(pending.timer);
    this.stats.repliesReceived++;
    const preview = (media.text || '').slice(0, 60);
    const mediaCount = (media.images?.length || 0) + (media.files?.length || 0) + (media.audio?.length || 0) + (media.video?.length || 0);
    logger.info(`[OneBot] ✅ 匹配回复 req=${reqId}: ${preview}${mediaCount > 0 ? ` [+${mediaCount} media]` : ''}`);
    pending.resolve(media);
  }

  /**
   * 核心方法: 发送消息到 QQ 并等待回复
   * @param {object} options
   * @param {string} options.groupId - 群号 (与 userId 二选一)
   * @param {string} options.userId - 好友 QQ (与 groupId 二选一)
   * @param {string} options.text - 发送的文本
   * @param {Array} [options.segments] - 额外的 OneBot 消息段 (图片/文件等)
   * @param {number} options.timeoutMs - 超时
   * @returns {Promise<{text, images, files, audio, video}>} 富媒体回复
   */
  async sendAndWaitReply({ groupId, userId, text, segments = [], timeoutMs }) {
    const config = getConfig();
    const reqId = shortId();
    const taggedText = text + encodeReqId(reqId);
    const threshold = config.forwardMsgThreshold || 2000;
    const hasExtraMedia = segments.length > 0;
    const useForward = !hasExtraMedia && taggedText.length > threshold;

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
          message: [{ type: 'text', data: { text: taggedText } }, ...segments],
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
          message: [{ type: 'text', data: { text: taggedText } }, ...segments],
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
