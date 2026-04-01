// ============================================
// config.js — 集中配置管理（支持 .env + 运行时热修改）
// ============================================
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// 加载 .env
dotenvConfig({ path: join(ROOT, '.env') });

// 运行时可变配置（WebUI 可以热修改这些值）
const runtimeConfig = {
  bridgePort: parseInt(process.env.BRIDGE_PORT || '9520', 10),
  webuiPort: parseInt(process.env.WEBUI_PORT || '9521', 10),
  napcatWsUrl: process.env.NAPCAT_WS_URL || 'ws://127.0.0.1:3001',
  napcatToken: process.env.NAPCAT_TOKEN || '',
  defaultGroupId: process.env.DEFAULT_GROUP_ID || '',
  defaultUserId: process.env.DEFAULT_USER_ID || '',
  whitelistUsers: parseList(process.env.WHITELIST_USERS || ''),
  replyTimeoutMs: parseInt(process.env.REPLY_TIMEOUT_MS || '60000', 10),
  rateLimitMs: parseInt(process.env.RATE_LIMIT_MS || '1500', 10),
  apiKey: process.env.API_KEY || 'sk-qq-bridge',
  forwardMsgThreshold: parseInt(process.env.FORWARD_MSG_THRESHOLD || '2000', 10), // 超过此字数自动用合并转发
  // 运行时状态
  serviceEnabled: true,
  contextMode: 'last', // 'last' = 只发最后一条 user 消息, 'full' = 拼接完整对话
};

function parseList(str) {
  return str
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// 持久化到 runtime-config.json（可选）
const RUNTIME_CONFIG_PATH = join(ROOT, 'runtime-config.json');

export function loadRuntimeConfig() {
  if (existsSync(RUNTIME_CONFIG_PATH)) {
    try {
      const saved = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'));
      Object.assign(runtimeConfig, saved);
    } catch {
      // ignore corrupt file
    }
  }
}

export function saveRuntimeConfig() {
  try {
    const toSave = { ...runtimeConfig };
    writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch {
    // best effort
  }
}

export function getConfig() {
  return runtimeConfig;
}

export function updateConfig(patch) {
  Object.assign(runtimeConfig, patch);
  if (patch.whitelistUsers && typeof patch.whitelistUsers === 'string') {
    runtimeConfig.whitelistUsers = parseList(patch.whitelistUsers);
  }
  saveRuntimeConfig();
  return runtimeConfig;
}
