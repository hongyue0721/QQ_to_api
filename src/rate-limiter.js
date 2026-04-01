// ============================================
// rate-limiter.js — 令牌桶限流队列
// ============================================

export class RateLimiter {
  constructor(intervalMs = 1500) {
    this.intervalMs = intervalMs;
    this.queue = [];
    this.processing = false;
    this.lastSendTime = 0;
  }

  updateInterval(ms) {
    this.intervalMs = ms;
  }

  /**
   * 入队一个异步任务，返回其结果的 Promise
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastSendTime;
      if (elapsed < this.intervalMs) {
        await sleep(this.intervalMs - elapsed);
      }

      const { fn, resolve, reject } = this.queue.shift();
      this.lastSendTime = Date.now();
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }

    this.processing = false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
