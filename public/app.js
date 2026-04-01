// ============================================
// app.js — WebUI 前端逻辑
// ============================================

const API_BASE = window.location.origin;
let autoScroll = true;
let logWs = null;
let statusInterval = null;

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  connectLogWs();
  pollStatus();
  statusInterval = setInterval(pollStatus, 3000);
});

// ---- Status Polling ----
async function pollStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/status`);
    if (!res.ok) return;
    const data = await res.json();

    // Badges
    const wsBadge = document.getElementById('badge-ws');
    const wsText = document.getElementById('badge-ws-text');
    if (data.onebot?.connected) {
      wsBadge.className = 'badge badge-online';
      wsText.textContent = 'OneBot 在线';
    } else {
      wsBadge.className = 'badge badge-offline';
      wsText.textContent = 'OneBot 离线';
    }

    const svcBadge = document.getElementById('badge-service');
    const svcText = document.getElementById('badge-service-text');
    if (data.serviceEnabled) {
      svcBadge.className = 'badge badge-online';
      svcText.textContent = '服务运行中';
    } else {
      svcBadge.className = 'badge badge-offline';
      svcText.textContent = '服务已暂停';
    }

    // Toggle button state
    const toggleBtn = document.getElementById('btn-toggle');
    const toggleIcon = document.getElementById('btn-toggle-icon');
    const toggleText = document.getElementById('btn-toggle-text');
    if (data.serviceEnabled) {
      toggleBtn.classList.add('active');
      toggleIcon.textContent = '⏸';
      toggleText.textContent = '暂停服务';
    } else {
      toggleBtn.classList.remove('active');
      toggleIcon.textContent = '▶';
      toggleText.textContent = '启用服务';
    }

    // Stats
    if (data.onebot) {
      document.getElementById('stat-sent').textContent = data.onebot.messagesSent || 0;
      document.getElementById('stat-replies').textContent = data.onebot.repliesReceived || 0;
      document.getElementById('stat-timeouts').textContent = data.onebot.timeouts || 0;
      document.getElementById('stat-errors').textContent = data.onebot.errors || 0;
      document.getElementById('stat-pending').textContent = data.onebot.pendingCount || 0;
    }

    // Update usage guide
    if (data.config) {
      document.getElementById('usage-baseurl').textContent =
        `http://127.0.0.1:${data.config.bridgePort}`;
      document.getElementById('usage-apikey').textContent =
        data.config.apiKey || 'sk-qq-bridge';
    }
  } catch {
    // ignore poll errors
  }
}

// ---- Config ----
async function loadConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    if (!res.ok) return;
    const cfg = await res.json();

    setVal('cfg-napcatWsUrl', cfg.napcatWsUrl);
    setVal('cfg-napcatToken', cfg.napcatToken === '***' ? '' : cfg.napcatToken);
    setVal('cfg-defaultGroupId', cfg.defaultGroupId);
    setVal('cfg-defaultUserId', cfg.defaultUserId);
    setVal('cfg-whitelistUsers', cfg.whitelistUsers);
    setVal('cfg-replyTimeoutMs', cfg.replyTimeoutMs);
    setVal('cfg-rateLimitMs', cfg.rateLimitMs);
    setVal('cfg-apiKey', cfg.apiKey);
    setVal('cfg-contextMode', cfg.contextMode);
  } catch {
    // ignore
  }
}

async function saveConfig(e) {
  e.preventDefault();
  const body = {
    napcatWsUrl: getVal('cfg-napcatWsUrl'),
    napcatToken: getVal('cfg-napcatToken') || undefined,
    defaultGroupId: getVal('cfg-defaultGroupId'),
    defaultUserId: getVal('cfg-defaultUserId'),
    whitelistUsers: getVal('cfg-whitelistUsers'),
    replyTimeoutMs: parseInt(getVal('cfg-replyTimeoutMs'), 10),
    rateLimitMs: parseInt(getVal('cfg-rateLimitMs'), 10),
    apiKey: getVal('cfg-apiKey'),
    contextMode: getVal('cfg-contextMode'),
  };

  try {
    const res = await fetch(`${API_BASE}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      showToast('✅ 配置已保存');
    } else {
      showToast('❌ 保存失败', 'error');
    }
  } catch {
    showToast('❌ 网络错误', 'error');
  }
}

// ---- Toggle Service ----
async function toggleService() {
  try {
    const res = await fetch(`${API_BASE}/api/toggle`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      showToast(data.serviceEnabled ? '▶ 服务已启用' : '⏸ 服务已暂停');
      pollStatus();
    }
  } catch {
    showToast('❌ 操作失败', 'error');
  }
}

// ---- Reconnect ----
async function reconnect() {
  try {
    await fetch(`${API_BASE}/api/reconnect`, { method: 'POST' });
    showToast('🔄 正在重新连接...');
  } catch {
    showToast('❌ 操作失败', 'error');
  }
}

// ---- Test ----
async function sendTest() {
  const text = getVal('test-text') || 'Hello from Bridge!';
  const resultEl = document.getElementById('test-result');
  const btnEl = document.getElementById('btn-test');

  resultEl.className = 'test-result loading';
  resultEl.textContent = '⏳ 发送中，等待回复...';
  resultEl.classList.remove('hidden');
  btnEl.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();

    if (data.status === 'ok') {
      resultEl.className = 'test-result success';
      resultEl.textContent = `✅ 回复: ${data.reply}`;
    } else {
      resultEl.className = 'test-result error';
      resultEl.textContent = `❌ 错误: ${data.error}`;
    }
  } catch (err) {
    resultEl.className = 'test-result error';
    resultEl.textContent = `❌ 网络错误: ${err.message}`;
  } finally {
    btnEl.disabled = false;
  }
}

// ---- Log WebSocket ----
function connectLogWs() {
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${window.location.host}/api/logs`;

  logWs = new WebSocket(wsUrl);

  logWs.onopen = () => {
    // connected
  };

  logWs.onmessage = (evt) => {
    try {
      const entry = JSON.parse(evt.data);
      appendLog(entry);
    } catch { /* ignore */ }
  };

  logWs.onclose = () => {
    setTimeout(connectLogWs, 3000);
  };

  logWs.onerror = () => {
    try { logWs.close(); } catch { /* ignore */ }
  };
}

function appendLog(entry) {
  const container = document.getElementById('log-container');

  // Remove "empty" placeholder
  const empty = container.querySelector('.log-empty');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = 'log-line';

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = entry.time?.slice(11) || '';

  const level = document.createElement('span');
  level.className = `log-level log-level-${entry.level}`;
  level.textContent = entry.level;

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = entry.message;

  line.appendChild(time);
  line.appendChild(level);
  line.appendChild(msg);
  container.appendChild(line);

  // Keep max 1000 lines in DOM
  while (container.children.length > 1000) {
    container.removeChild(container.firstChild);
  }

  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function clearLogs() {
  const container = document.getElementById('log-container');
  container.innerHTML = '<div class="log-empty">日志已清空</div>';
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('btn-autoscroll');
  btn.classList.toggle('active', autoScroll);
  if (autoScroll) {
    const container = document.getElementById('log-container');
    container.scrollTop = container.scrollHeight;
  }
}

// ---- Toast ----
function showToast(message, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    padding: 12px 22px;
    border-radius: 10px;
    font-family: var(--font);
    font-size: 0.88rem;
    font-weight: 500;
    z-index: 9999;
    animation: fadeIn 0.3s ease;
    backdrop-filter: blur(16px);
    border: 1px solid ${type === 'error' ? 'rgba(239,68,68,0.3)' : 'rgba(99,102,241,0.3)'};
    background: ${type === 'error' ? 'rgba(239,68,68,0.15)' : 'rgba(99,102,241,0.15)'};
    color: ${type === 'error' ? '#f87171' : '#a5b4fc'};
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ---- Helpers ----
function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined && val !== null) el.value = val;
}
