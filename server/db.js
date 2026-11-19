import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// DB_FILE 可指定数据库文件（测试时用独立的库）
const dbFile = path.resolve(root, process.env.DB_FILE || 'data/eatwhat.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);

db.exec(`
  CREATE TABLE IF NOT EXISTS free_spins (
    day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key)
  );
  CREATE TABLE IF NOT EXISTS credits (
    device TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, device TEXT NOT NULL, ip TEXT, amount TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, paid_at INTEGER,
    code TEXT, claimed_at INTEGER, handled_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS favorites (
    device TEXT NOT NULL, poi_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (device, poi_id)
  );
  CREATE TABLE IF NOT EXISTS spin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, device TEXT, ip TEXT,
    source TEXT, poi_id TEXT, poi_name TEXT, created_at INTEGER
  );
`);

// 旧库迁移：补上新加的列
const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
for (const [col, type] of [['code', 'TEXT'], ['claimed_at', 'INTEGER'], ['handled_at', 'INTEGER']]) {
  if (!orderCols.includes(col)) db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, created_at)');

/**
 * 订单状态：
 *   pending   已下单，等用户付款
 *   claimed   用户点了「我已付款」，等管理员确认
 *   paid      管理员确认到账（或模拟支付），已加 1 次机会
 *   rejected  管理员确认没收到钱
 *   cancelled 用户取消
 */
const OPEN = "status IN ('pending', 'claimed')";
const ORDER_TTL = 24 * 3600e3; // 超过 24 小时的未完成订单视为过期，不再展示

const q = {
  used: db.prepare('SELECT n FROM free_spins WHERE day = ? AND key = ?'),
  bump: db.prepare(
    'INSERT INTO free_spins (day, key, n) VALUES (?, ?, 1) ON CONFLICT(day, key) DO UPDATE SET n = n + 1'
  ),
  credits: db.prepare('SELECT n FROM credits WHERE device = ?'),
  addCredit: db.prepare(
    'INSERT INTO credits (device, n) VALUES (?, ?) ON CONFLICT(device) DO UPDATE SET n = n + excluded.n'
  ),
  useCredit: db.prepare('UPDATE credits SET n = n - 1 WHERE device = ? AND n > 0'),
  insOrder: db.prepare(
    "INSERT INTO orders (id, device, ip, amount, code, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
  ),
  getOrder: db.prepare('SELECT * FROM orders WHERE id = ?'),
  openOrderFor: db.prepare(
    `SELECT * FROM orders WHERE device = ? AND ${OPEN} AND created_at > ? ORDER BY created_at DESC LIMIT 1`
  ),
  codeInUse: db.prepare(`SELECT 1 FROM orders WHERE code = ? AND ${OPEN} AND created_at > ?`),
  claim: db.prepare("UPDATE orders SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'"),
  cancel: db.prepare("UPDATE orders SET status = 'cancelled', handled_at = ? WHERE id = ? AND status = 'pending'"),
  pay: db.prepare(`UPDATE orders SET status = 'paid', paid_at = ?, handled_at = ? WHERE id = ? AND ${OPEN}`),
  reject: db.prepare(`UPDATE orders SET status = 'rejected', handled_at = ? WHERE id = ? AND ${OPEN}`),
  listOpen: db.prepare(
    `SELECT * FROM orders WHERE ${OPEN} AND created_at > ?
     ORDER BY (status = 'claimed') DESC, COALESCE(claimed_at, created_at) DESC LIMIT 200`
  ),
  listRecent: db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100'),
  spinStats: db.prepare('SELECT source, COUNT(*) AS n FROM spin_logs WHERE day = ? GROUP BY source'),
  paidStats: db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount AS REAL)), 0) AS total FROM orders WHERE status = 'paid' AND paid_at >= ?"
  ),
  favList: db.prepare('SELECT data FROM favorites WHERE device = ? ORDER BY created_at'),
  favCount: db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE device = ?'),
  favAdd: db.prepare(
    'INSERT INTO favorites (device, poi_id, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(device, poi_id) DO UPDATE SET data = excluded.data'
  ),
  favDel: db.prepare('DELETE FROM favorites WHERE device = ? AND poi_id = ?'),
  insLog: db.prepare(
    'INSERT INTO spin_logs (day, device, ip, source, poi_id, poi_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
};

function keysFor(mode, ip, device) {
  if (mode === 'ip') return [`ip:${ip}`];
  if (mode === 'device') return [`dev:${device}`];
  return [`ip:${ip}`, `dev:${device}`];
}

const usedMax = (day, keys) => Math.max(0, ...keys.map((k) => q.used.get(day, k)?.n ?? 0));
const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};
const since = () => Date.now() - ORDER_TTL;

export function getStatus({ day, ip, device, mode, freePerDay }) {
  const used = usedMax(day, keysFor(mode, ip, device));
  return {
    freeLeft: Math.max(0, freePerDay - used),
    credits: q.credits.get(device)?.n ?? 0,
  };
}

/** 消耗一次机会：优先免费，其次付费次数。返回 'free' | 'paid' | null */
export function consumeChance({ day, ip, device, mode, freePerDay }) {
  return tx(() => {
    const keys = keysFor(mode, ip, device);
    if (usedMax(day, keys) < freePerDay) {
      for (const k of keys) q.bump.run(day, k);
      return 'free';
    }
    if (q.useCredit.run(device).changes > 0) return 'paid';
    return null;
  });
}

export function logSpin({ day, device, ip, source, poi }) {
  q.insLog.run(day, device, ip, source, poi.id, poi.name, Date.now());
}

export const getOrder = (id) => q.getOrder.get(id);
export const openOrderFor = (device) => q.openOrderFor.get(device, since());

/** 建单；同一设备已有未完成订单时直接返回那一单（防止刷单） */
export function createOrder({ id, device, ip, amount }) {
  return tx(() => {
    const existing = q.openOrderFor.get(device, since());
    if (existing) return existing;
    // 4 位数字备注码，方便转账时填写、管理员核对；只需在未完成订单里唯一
    let code;
    for (let i = 0; i < 50; i++) {
      const c = String(1000 + Math.floor(Math.random() * 9000));
      if (!q.codeInUse.get(c, since())) {
        code = c;
        break;
      }
    }
    if (!code) code = String(Date.now()).slice(-6);
    q.insOrder.run(id, device, ip, amount, code, Date.now());
    return q.getOrder.get(id);
  });
}

export const claimOrder = (id) => q.claim.run(Date.now(), id).changes > 0;
export const cancelOrder = (id) => q.cancel.run(Date.now(), id).changes > 0;

/** 确认到账并加 1 次机会。幂等：同一订单只会入账一次 */
export function markPaid(orderId) {
  return tx(() => {
    const order = q.getOrder.get(orderId);
    if (!order) return false;
    const now = Date.now();
    if (q.pay.run(now, now, orderId).changes === 0) return false;
    q.addCredit.run(order.device, 1);
    return true;
  });
}

export const rejectOrder = (id) => q.reject.run(Date.now(), id).changes > 0;

export const listOrders = (scope) => (scope === 'all' ? q.listRecent.all() : q.listOpen.all(since()));

export function todayStats(day) {
  const spins = { free: 0, paid: 0 };
  for (const r of q.spinStats.all(day)) spins[r.source] = r.n;
  const dayStart = Date.parse(`${day}T00:00:00+08:00`);
  const paid = q.paidStats.get(dayStart);
  return { spins, paidOrders: paid.n, paidTotal: Number(paid.total).toFixed(2) };
}

// ---- 常去的店（按设备保存）----
export const FAV_LIMIT = 10;
export const listFavorites = (device) => q.favList.all(device).map((r) => JSON.parse(r.data));

/** 添加收藏；超过上限返回 false */
export function addFavorite(device, poi) {
  return tx(() => {
    const exists = listFavorites(device).some((f) => f.id === poi.id);
    if (!exists && q.favCount.get(device).n >= FAV_LIMIT) return false;
    q.favAdd.run(device, poi.id, JSON.stringify(poi), Date.now());
    return true;
  });
}

export const removeFavorite = (device, poiId) => q.favDel.run(device, poiId).changes > 0;
