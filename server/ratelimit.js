// 简单的按 key 计数限流（固定时间窗口），单进程内存实现，内部工具够用。
// 规则：同一个 key 在 windowMs 内最多 limit 次，超了返回需要等待的秒数。

const buckets = new Map(); // `${name}|${key}` -> { count, resetAt }
const MAX_KEYS = 50000;

/**
 * 记一次请求。返回 0 表示放行，>0 表示被限流、需要等待的秒数。
 */
export function hit(name, key, limit, windowMs) {
  const k = `${name}|${key}`;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(k, b);
  }
  b.count++;
  if (b.count > limit) return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  return 0;
}

/** 只查不记（用于「失败多少次就锁定」这类先判断、失败时才计数的场景） */
export function blockedFor(name, key, limit) {
  const b = buckets.get(`${name}|${key}`);
  if (!b || Date.now() >= b.resetAt || b.count < limit) return 0;
  return Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000));
}

export function reset(name, key) {
  buckets.delete(`${name}|${key}`);
}

// 定期清理过期的计数，防止内存无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  // 被大量不同 IP 打的极端情况：直接砍掉最老的一半
  if (buckets.size > MAX_KEYS) {
    let n = buckets.size / 2;
    for (const k of buckets.keys()) {
      if (n-- <= 0) break;
      buckets.delete(k);
    }
  }
}, 60e3).unref();
