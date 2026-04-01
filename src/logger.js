// ============================================
// logger.js — 分级日志 + WebSocket 实时推送
// ============================================
import { WebSocketServer } from 'ws';

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const COLORS = {
  DEBUG: '\x1b[90m',  // gray
  INFO: '\x1b[36m',   // cyan
  WARN: '\x1b[33m',   // yellow
  ERROR: '\x1b[31m',  // red
  RESET: '\x1b[0m',
};

// 环形缓冲: 最近 500 条
const BUFFER_SIZE = 500;
const logBuffer = [];

// WebSocket 客户端集合
const wsClients = new Set();

function formatTime() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function createEntry(level, ...args) {
  const message = args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a)
  ).join(' ');
  return {
    time: formatTime(),
    level,
    message,
  };
}

function pushToBuffer(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > BUFFER_SIZE) logBuffer.shift();
}

function broadcast(entry) {
  const payload = JSON.stringify(entry);
  for (const ws of wsClients) {
    try {
      if (ws.readyState === 1) ws.send(payload);
    } catch { /* ignore */ }
  }
}

function log(level, ...args) {
  const entry = createEntry(level, ...args);
  pushToBuffer(entry);

  // 控制台
  const color = COLORS[level] || '';
  console.log(
    `${color}[${entry.time}] [${level}]${COLORS.RESET} ${entry.message}`
  );

  // WebSocket 推送
  broadcast(entry);
}

export const logger = {
  debug: (...args) => log('DEBUG', ...args),
  info: (...args) => log('INFO', ...args),
  warn: (...args) => log('WARN', ...args),
  error: (...args) => log('ERROR', ...args),
};

/**
 * 初始化日志 WebSocket 服务器（挂载到 WebUI HTTP Server 上）
 */
export function initLogWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/api/logs' });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    // 发送历史日志
    for (const entry of logBuffer) {
      ws.send(JSON.stringify(entry));
    }
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });
  logger.info('[Logger] WebSocket 日志流已就绪');
}

export function getLogBuffer() {
  return [...logBuffer];
}
