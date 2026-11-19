import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { getPool, geocode, searchNearby, matchesCategory, distanceM, shuffle, CATEGORIES } from './amap.js';
import { wgs84ToGcj02 } from './geo.js';
import { config } from './config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CERTS = path.join(ROOT, 'certs');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 东八区日期，作为「每天」的边界
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/** 设备 ID 放 cookie；没有就新发一个 */
function identify(req, res) {
  const m = /(?:^|;\s*)did=([0-9a-f-]{36})/.exec(req.headers.cookie || '');
  let device = m?.[1];
  if (!device) {
    device = crypto.randomUUID();
    res.setHeader('Set-Cookie', `did=${device}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax`);
  }
  return { ip: clientIp(req), device };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16 * 1024) throw new HttpError(413, 'too_large', '请求过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', '请求格式错误');
  }
}

function parseLoc(body) {
  let lng = Number(body.lng);
  let lat = Number(body.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    throw new HttpError(400, 'bad_location', '位置无效');
  }
  if (body.coord === 'wgs84') ({ lng, lat } = wgs84ToGcj02(lng, lat));
  const radius = Math.min(3000, Math.max(200, Math.round(Number(body.radius) || 1000)));
  const category = CATEGORIES[body.category] ? body.category : 'all';
  const minRating = RATING_OPTIONS.includes(Number(body.minRating)) ? Number(body.minRating) : 0;
  return { lng, lat, radius, category, minRating };
}

const RATING_OPTIONS = [0, 3.5, 4, 4.5];

// ---- 转盘 ----
// 转盘由服务端组好并记住（wheelId），转的时候只能从这一盘里抽，保证「看到的就是抽的」。
const WHEEL_TTL = 2 * 3600e3;
const MAX_SLICES = 12; // 没有常去的店时，盘面放 12 家随机
const wheels = new Map(); // wheelId -> { device, slices, at }

function saveWheel(device, slices) {
  const wheelId = crypto.randomBytes(8).toString('hex');
  wheels.set(wheelId, { device, slices, at: Date.now() });
  // Map 按插入顺序排列，最老的在前：清掉过期的，并限制总量
  for (const [k, w] of wheels) {
    if (Date.now() - w.at > WHEEL_TTL || wheels.size > 5000) wheels.delete(k);
    else break;
  }
  return wheelId;
}

const POI_FIELDS = ['id', 'name', 'address', 'distance', 'type', 'typecode', 'rating', 'cost', 'tel', 'lng', 'lat'];
const pickFields = (p) => Object.fromEntries(POI_FIELDS.map((k) => [k, p[k] ?? '']));
const ratingOf = (p) => Number(p.rating) || 0;

/**
 * 组一盘：
 *  - 有 N 家「常去的店」在范围内（且符合类别）→ N 家常去 + N 家随机
 *  - 没有 → 12 家随机
 * 随机的店受评分筛选；常去的店是用户自己选的，不受评分筛选。
 */
async function buildWheel(id, loc) {
  const { pool, demo } = await getPool(loc);
  const favorites = db.listFavorites(id.device).map((f) => {
    const distance = Math.round(distanceM(loc.lng, loc.lat, f.lng, f.lat));
    let reason = null;
    if (distance > loc.radius) reason = 'out_of_range';
    else if (!matchesCategory(f, loc.category)) reason = 'category';
    return { ...f, distance, reason };
  });
  const favIn = favorites.filter((f) => !f.reason);
  const favIds = new Set(favorites.map((f) => f.id));
  const candidates = pool.filter((p) => !favIds.has(p.id) && ratingOf(p) >= loc.minRating);
  const randoms = shuffle([...candidates]).slice(0, favIn.length || MAX_SLICES);
  const slices = shuffle([
    ...favIn.map((f) => ({ ...pickFields(f), fav: true })),
    ...randoms.map((p) => ({ ...pickFields(p), fav: false })),
  ]);
  if (!slices.length) {
    throw new HttpError(
      404,
      'no_poi',
      pool.length && loc.minRating
        ? `附近没有 ${loc.minRating} 分以上的餐厅，试试降低评分要求或扩大范围`
        : '这个范围内没找到餐厅，试试扩大半径或换个类别'
    );
  }
  return {
    wheelId: saveWheel(id.device, slices),
    demo,
    slices,
    favCount: favIn.length,
    randomCount: randoms.length,
    candidateTotal: candidates.length,
    favorites: favorites.map((f) => ({
      id: f.id,
      name: f.name,
      distance: f.distance,
      rating: f.rating,
      included: !f.reason,
      reason: f.reason,
    })),
  };
}

// 搜索结果暂存：添加收藏时只认服务端搜到过的店，不信任前端传来的店铺数据
const SEARCH_TTL = 30 * 60e3;
const searchCache = new Map(); // `${device}:${poiId}` -> { poi, at }
function rememberSearch(device, items) {
  for (const p of items) searchCache.set(`${device}:${p.id}`, { poi: p, at: Date.now() });
  for (const [k, v] of searchCache) {
    if (Date.now() - v.at > SEARCH_TTL || searchCache.size > 20000) searchCache.delete(k);
    else break;
  }
}

const chanceCtx = (id) => ({
  day: today(),
  ip: id.ip,
  device: id.device,
  mode: config.limitMode,
  freePerDay: config.freePerDay,
});

const publicOrder = (o) => (o ? { orderId: o.id, code: o.code, amount: o.amount, status: o.status } : null);

const qrPath = () => path.resolve(ROOT, config.payQrFile);
const QR_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const publicStatus = (id) => ({
  ...db.getStatus(chanceCtx(id)),
  payMode: config.payMode,
  amount: config.orderAmount,
  hasQr: fs.existsSync(qrPath()),
  openOrder: publicOrder(db.openOrderFor(id.device)),
  demo: !config.amapKey,
});

function ownOrder(id, orderId) {
  const o = db.getOrder(orderId);
  if (!o || o.device !== id.device) throw new HttpError(404, 'no_order', '订单不存在');
  return o;
}

function requireAdmin(req) {
  if (!config.adminToken) throw new HttpError(503, 'admin_disabled', '管理后台未启用：请在 .env 设置 ADMIN_TOKEN');
  const given = String(req.headers['x-admin-token'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(config.adminToken).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'bad_token', '口令错误');
}

const adminOrder = (o) => ({
  orderId: o.id,
  code: o.code,
  amount: o.amount,
  status: o.status,
  ip: o.ip,
  device: o.device.slice(0, 8),
  createdAt: o.created_at,
  claimedAt: o.claimed_at,
  handledAt: o.handled_at,
});

const routes = {
  'GET /api/meta': async (req, res, id) => ({
    categories: Object.entries(CATEGORIES).map(([key, v]) => ({ key, name: v.name })),
    ratingOptions: RATING_OPTIONS,
    favLimit: db.FAV_LIMIT,
    ...publicStatus(id),
  }),

  'GET /api/status': async (req, res, id) => publicStatus(id),

  'GET /api/geocode': async (req, res, id, url) => {
    const address = (url.searchParams.get('address') || '').trim().slice(0, 100);
    if (!address) throw new HttpError(400, 'bad_address', '请输入地址');
    return geocode(address);
  },

  // 组一盘（换位置/类别/范围/评分、增删常去的店、点「换一批」时调用）
  'POST /api/wheel': async (req, res, id) => buildWheel(id, parseLoc(await readJson(req))),

  // 在当前范围内按店名搜索，用来添加「常去的店」
  'POST /api/search': async (req, res, id) => {
    const body = await readJson(req);
    const loc = parseLoc(body);
    const keyword = String(body.keyword || '').trim().slice(0, 30);
    if (!keyword) throw new HttpError(400, 'bad_keyword', '请输入店名');
    const items = (await searchNearby(loc, keyword)).map(pickFields);
    rememberSearch(id.device, items);
    const favIds = new Set(db.listFavorites(id.device).map((f) => f.id));
    return { items: items.map((p) => ({ ...p, fav: favIds.has(p.id) })) };
  },

  'POST /api/favorites': async (req, res, id) => {
    const { poiId } = await readJson(req);
    const hit = searchCache.get(`${id.device}:${poiId}`);
    if (!hit) throw new HttpError(404, 'search_expired', '搜索结果已过期，请重新搜索');
    const { distance, ...poi } = hit.poi; // 距离每次按当前位置重新算，不存
    if (!db.addFavorite(id.device, poi)) {
      throw new HttpError(409, 'fav_full', `常去的店最多 ${db.FAV_LIMIT} 家，先删掉一些`);
    }
    return { ok: true, count: db.listFavorites(id.device).length };
  },

  'DELETE /api/favorites/:id': async (req, res, id, url, params) => {
    db.removeFavorite(id.device, params.id);
    return { ok: true, count: db.listFavorites(id.device).length };
  },

  // 从这一盘里等概率抽一格；先校验转盘，再扣次数，避免「扣了次数却没结果」
  'POST /api/spin': async (req, res, id) => {
    const { wheelId } = await readJson(req);
    const w = wheels.get(String(wheelId || ''));
    if (!w || w.device !== id.device || Date.now() - w.at > WHEEL_TTL) {
      throw new HttpError(409, 'wheel_expired', '转盘已过期，已为你刷新，请再转一次');
    }
    const ctx = chanceCtx(id);
    const source = db.consumeChance(ctx);
    if (!source) throw new HttpError(402, 'no_chance', '今天的免费次数用完了');
    const index = crypto.randomInt(w.slices.length);
    const poi = w.slices[index];
    db.logSpin({ day: ctx.day, device: id.device, ip: id.ip, source, poi });
    return { index, poi, source, status: publicStatus(id) };
  },

  // ---- 支付 ----
  // manual：用户扫管理员收款码转账（备注 4 位码）→ 点「我已付款」→ 管理员后台确认 → 加 1 次
  // 接入真实支付时：新增 POST /api/pay/notify，验签 + 校验金额后调用 db.markPaid(orderId)（已幂等）
  'POST /api/orders': async (req, res, id) => {
    const orderId = 'O' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const o = db.createOrder({ id: orderId, device: id.device, ip: id.ip, amount: config.orderAmount });
    return publicOrder(o);
  },

  'GET /api/orders/:id': async (req, res, id, url, params) => publicOrder(ownOrder(id, params.id)),

  'POST /api/orders/:id/claim': async (req, res, id, url, params) => {
    const o = ownOrder(id, params.id);
    db.claimOrder(o.id);
    return publicOrder(db.getOrder(o.id));
  },

  'POST /api/orders/:id/cancel': async (req, res, id, url, params) => {
    const o = ownOrder(id, params.id);
    if (!db.cancelOrder(o.id)) throw new HttpError(409, 'cannot_cancel', '已提交付款的订单不能取消，请等待管理员处理');
    return publicOrder(db.getOrder(o.id));
  },

  'POST /api/orders/:id/mock-pay': async (req, res, id, url, params) => {
    if (config.payMode !== 'mock') throw new HttpError(404, 'not_found', 'Not found');
    const o = ownOrder(id, params.id);
    db.markPaid(o.id);
    return publicOrder(db.getOrder(o.id));
  },

  // ---- 管理后台（请求头 X-Admin-Token）----
  'GET /api/admin/orders': async (req, res, id, url) => {
    requireAdmin(req);
    const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'open';
    return { orders: db.listOrders(scope).map(adminOrder), stats: db.todayStats(today()) };
  },

  'POST /api/admin/orders/:id/confirm': async (req, res, id, url, params) => {
    requireAdmin(req);
    if (!db.getOrder(params.id)) throw new HttpError(404, 'no_order', '订单不存在');
    const ok = db.markPaid(params.id);
    return { ok, order: adminOrder(db.getOrder(params.id)) };
  },

  'POST /api/admin/orders/:id/reject': async (req, res, id, url, params) => {
    requireAdmin(req);
    if (!db.getOrder(params.id)) throw new HttpError(404, 'no_order', '订单不存在');
    const ok = db.rejectOrder(params.id);
    return { ok, order: adminOrder(db.getOrder(params.id)) };
  },
};

function matchRoute(method, pathname) {
  const exact = routes[`${method} ${pathname}`];
  if (exact) return { handler: exact, params: {} };
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method || !pattern.includes(':')) continue;
    const pp = pattern.split('/');
    const ap = pathname.split('/');
    if (pp.length !== ap.length) continue;
    const params = {};
    if (pp.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(ap[i])), true) : seg === ap[i]))) {
      return { handler: routes[key], params };
    }
  }
  return null;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const found = matchRoute(req.method, url.pathname);
      if (!found) throw new HttpError(404, 'not_found', 'Not found');
      const id = identify(req, res);
      return sendJson(res, 200, await found.handler(req, res, id, url, found.params));
    }
    if (req.method !== 'GET') throw new HttpError(405, 'method', 'Method not allowed');
    // 本地 CA 证书（只是公钥证书），供手机下载安装以消除证书警告
    if (url.pathname === '/ca.crt' && fs.existsSync(path.join(CERTS, 'ca.crt'))) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="EatWhat-CA.crt"',
      });
      return fs.createReadStream(path.join(CERTS, 'ca.crt')).pipe(res);
    }
    // 管理员收款码图片
    if (url.pathname === '/pay-qr' && fs.existsSync(qrPath())) {
      res.writeHead(200, {
        'Content-Type': QR_MIME[path.extname(qrPath()).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(qrPath()).pipe(res);
    }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (e) {
    if (!(e instanceof HttpError) && !e.code) console.error(e);
    if (e.code === 'bad_token') await new Promise((r) => setTimeout(r, 1000)); // 拖慢口令爆破
    sendJson(res, e.status || 500, { error: e.code || 'server_error', message: e.message || '服务器错误' });
  }
};

// 只列真实网卡：排除虚拟机网卡、代理软件 TUN 网卡(198.18.0.0/15)
const lanIps = () =>
  Object.entries(os.networkInterfaces())
    .filter(([name]) => !/vmware|virtualbox|vethernet|hyper-v|wsl|docker|tun|tap|meta|clash/i.test(name))
    .flatMap(([, addrs]) => addrs)
    .filter((a) => a.family === 'IPv4' && !a.internal && !/^(169\.254|198\.1[89])\./.test(a.address))
    .map((a) => a.address);

http.createServer(handler).listen(config.port, () => {
  console.log(`HTTP : http://localhost:${config.port}`);
});

const certFile = path.join(CERTS, 'server.crt');
const keyFile = path.join(CERTS, 'server.key');
if (config.httpsPort && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  https
    .createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, handler)
    .listen(config.httpsPort, () => {
      console.log(`HTTPS: https://localhost:${config.httpsPort}`);
      for (const ip of lanIps()) console.log(`       https://${ip}:${config.httpsPort}   <- 手机用这个（同一 WiFi）`);
    });
} else if (config.httpsPort) {
  console.log('HTTPS: 未启用（先运行 npm.cmd run cert 生成证书）');
}

console.log(
  `AMAP: ${config.amapKey ? 'key configured' : 'NO KEY (demo data)'} | limit=${config.limitMode} x${config.freePerDay}/day | pay=${config.payMode}`
);
if (config.payMode === 'manual') {
  console.log(`收款码: ${fs.existsSync(qrPath()) ? config.payQrFile : `未放置（请把收款码图片放到 ${config.payQrFile}）`}`);
}
console.log(`管理后台: ${config.adminToken ? `http://localhost:${config.port}/admin.html` : '未启用（.env 里设置 ADMIN_TOKEN）'}`);
