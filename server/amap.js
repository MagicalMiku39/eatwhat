import { config } from './config.js';

// 高德 POI 分类编码（已用真实接口验证）。能用编码的就不用关键词，关键词搜索很不准。
// filter: 关键词类别的二次过滤（按店名），去掉高德模糊匹配进来的无关店
export const CATEGORIES = {
  all: { name: '全部', types: '050100|050200|050300' }, // 正餐：中餐+外国菜+快餐，不含咖啡奶茶甜品
  chinese: { name: '中餐', types: '050100' },
  western: {
    name: '西餐',
    types: '050201|050204|050205|050207|050208|050210|050211|050212|050213|050214|050215|050216',
  },
  japanese: { name: '日料', types: '050202' },
  korean: { name: '韩餐', types: '050203' },
  sea: { name: '东南亚', types: '050206|050209|050217' },
  hotpot: { name: '火锅', types: '050117' },
  bbq: { name: '烧烤', types: '050000', kw: '烧烤', filter: /烧烤|烤肉|烤串|撸串|串串|烧鸟|烤吧/ },
  fastfood: { name: '快餐', types: '050300' },
  noodle: { name: '面·粉', types: '050100|050300', kw: '面', filter: /面(?!包)|粉|米线/ },
  cafe: { name: '咖啡甜品', types: '050500|050700|050800|050900' },
};

const PAGE_SIZE = 25;
const MAX_PAGES = 3; // 每次建池最多调几次接口（个人 Key QPS 很低）

const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map();

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLOSED = /暂停营业|停业|已关闭|歇业|已搬迁/;

const R_EARTH = 6371000;
const rad = (d) => (d * Math.PI) / 180;
export function distanceM(lng1, lat1, lng2, lat2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}
function offsetPoint(lng, lat, meters, angle) {
  const dLat = (meters * Math.cos(angle)) / R_EARTH;
  const dLng = (meters * Math.sin(angle)) / (R_EARTH * Math.cos(rad(lat)));
  return { lng: lng + (dLng * 180) / Math.PI, lat: lat + (dLat * 180) / Math.PI };
}

// 全局串行 + 限速：个人开发者 Key 约 3 QPS，超了会报 CUQPS_HAS_EXCEEDED_THE_LIMIT(10021)
const MIN_INTERVAL = 380;
// 排队上限：约 6 秒的量。超了直接告诉用户「忙」，而不是无限排队拖垮所有人
const MAX_PENDING = 15;
let queue = Promise.resolve();
let lastCall = 0;
let pending = 0;

function amapError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function throttled(fn) {
  if (pending >= MAX_PENDING) {
    return Promise.reject(amapError(503, 'busy', '查询的人太多了，请稍后再试'));
  }
  pending++;
  const run = queue.then(async () => {
    const wait = lastCall + MIN_INTERVAL - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run.finally(() => pending--);
}

const QPS_CODES = new Set(['10019', '10020', '10021']);

async function amapGet(path, params) {
  const url = new URL('https://restapi.amap.com' + path);
  url.searchParams.set('key', config.amapKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let data;
  for (let attempt = 0; ; attempt++) {
    data = await throttled(async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return await res.json();
      } catch (e) {
        console.error('AMAP request failed:', e.message);
        throw amapError(502, 'amap_unavailable', '地图服务暂时连不上，请稍后再试');
      }
    });
    if (data.status === '1' || !QPS_CODES.has(data.infocode) || attempt >= 2) break;
    await sleep(1000 * (attempt + 1));
  }
  if (data.status !== '1') {
    // 具体原因（可能涉及 Key 配置）只写服务器日志，不返回给用户
    console.error(`AMAP error: ${data.info} (${data.infocode})`);
    const quota = /DAILY_QUERY_OVER_LIMIT|ACCESS_TOO_FREQUENT|EXCEEDED/.test(data.info || '');
    throw amapError(502, 'amap_error', quota ? '今天的地图查询额度用完了，明天再来吧' : '地图服务出错了，请稍后再试');
  }
  return data;
}

function mapPoi(p) {
  const [lng, lat] = (p.location || '').split(',').map(Number);
  const rating = p.biz_ext && typeof p.biz_ext.rating === 'string' ? p.biz_ext.rating : '';
  const cost = p.biz_ext && typeof p.biz_ext.cost === 'string' && p.biz_ext.cost ? String(Math.round(Number(p.biz_ext.cost))) : '';
  const tel = typeof p.tel === 'string' ? p.tel : '';
  return {
    id: p.id,
    name: p.name,
    address: typeof p.address === 'string' ? p.address : '',
    distance: Number(p.distance) || 0,
    type: (p.type || '').split(';').pop(),
    typecode: p.typecode || '',
    rating,
    cost,
    tel,
    lng,
    lat,
  };
}

const DEMO_NAMES = [
  '老王牛肉面', '山城小火锅', '樱花日料', '罗马披萨屋', '韩式炸鸡', '老北京炸酱面', '港式茶餐厅',
  '蜀香川菜馆', '一碗饺子', '深夜烧烤摊', '牛排工坊', '寿司之神', '兰州拉面', '黄焖鸡米饭',
  '沙县小吃', '麻辣烫', '潮汕牛肉粿', '咖喱屋', '越南河粉', '煲仔饭', '轻食沙拉', '汉堡王国',
  '麻辣香锅', '酸菜鱼', '羊肉泡馍', '螺蛳粉', '东北大饺子', '广式烧腊', '日式拉面', '披萨与意面',
];

function demoPool({ lng, lat, radius }) {
  return DEMO_NAMES.map((name, i) => {
    const distance = Math.round(50 + Math.random() * (radius - 50));
    const at = offsetPoint(lng, lat, distance, Math.random() * Math.PI * 2);
    return {
      id: `demo-${i}`,
      name,
      address: '演示数据（未配置 AMAP_KEY）',
      distance,
      type: '演示',
      typecode: '050100',
      rating: (3 + ((i * 7) % 20) / 10).toFixed(1), // 固定评分，方便测试评分筛选
      cost: String(20 + ((i * 13) % 80)),
      tel: '',
      lng: at.lng,
      lat: at.lat,
    };
  });
}

/** 获取候选池；loc 已经是 GCJ-02 坐标 */
export async function getPool({ lng, lat, radius, category }) {
  if (!config.amapKey) return { demo: true, pool: demoPool({ lng, lat, radius }) };

  const ck = `${lng.toFixed(3)},${lat.toFixed(3)}|${radius}|${category}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { demo: false, pool: hit.pool };
  // 同一个查询正在进行中就共用它，不重复打高德
  if (inflight.has(ck)) return inflight.get(ck);
  const p = fetchPool({ lng, lat, radius, category }, ck).finally(() => inflight.delete(ck));
  inflight.set(ck, p);
  return p;
}

const inflight = new Map();

async function fetchPool({ lng, lat, radius, category }, ck) {

  const cat = CATEGORIES[category] || CATEGORIES.all;
  const seen = new Map();
  const fetchPage = async (page, at = { lng, lat, radius }) => {
    const data = await amapGet('/v3/place/around', {
      location: `${at.lng.toFixed(6)},${at.lat.toFixed(6)}`,
      radius: String(Math.round(at.radius)),
      types: cat.types,
      offset: String(PAGE_SIZE),
      page: String(page),
      extensions: 'all',
      sortrule: 'distance',
      ...(cat.kw ? { keywords: cat.kw } : {}),
    });
    for (const p of data.pois || []) {
      if (!p.id || !p.location || seen.has(p.id)) continue;
      if (CLOSED.test(p.name)) continue;
      if (cat.filter && !cat.filter.test(p.name)) continue;
      const poi = mapPoi(p);
      poi.distance = Math.round(distanceM(lng, lat, poi.lng, poi.lat)); // 统一按用户位置算距离
      if (poi.distance > radius) continue;
      seen.set(p.id, poi);
    }
    return Number(data.count) || 0;
  };

  const count = await fetchPage(1);
  // 实测：周边搜索最多只能翻到第 200 条（8 页），再往后返回空
  const totalPages = Math.min(Math.floor(200 / PAGE_SIZE), Math.ceil(count / PAGE_SIZE));
  if (count > 200) {
    // 饱和（密集商圈）：中心点最近的 200 家可能都在几百米内，翻页够不到远处。
    // 改为在半径内随机取几个点做小范围搜索，让候选铺满整个圈。
    for (let i = 0; i < MAX_PAGES - 1; i++) {
      const ang = Math.random() * Math.PI * 2;
      const d = radius * (0.45 + Math.random() * 0.3);
      const at = offsetPoint(lng, lat, d, ang);
      await fetchPage(1, { ...at, radius: Math.max(150, radius * 0.35) });
    }
  } else if (totalPages > 1) {
    // 未饱和：按距离排序时第 1 页只有最近的 25 家，从「中段」和「远段」各随机抽一页
    const extra = new Set();
    const segs = MAX_PAGES - 1;
    for (let s = 0; s < segs; s++) {
      const lo = 2 + Math.floor(((totalPages - 1) * s) / segs);
      const hi = 1 + Math.floor(((totalPages - 1) * (s + 1)) / segs);
      if (hi >= lo) extra.add(lo + Math.floor(Math.random() * (hi - lo + 1)));
    }
    for (const page of extra) await fetchPage(page);
  }
  const pool = [...seen.values()];
  cache.set(ck, { at: Date.now(), pool });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return { demo: false, pool };
}

/** 在指定范围内按店名搜索餐馆（用来添加「常去的店」） */
export async function searchNearby({ lng, lat, radius }, keyword) {
  if (!config.amapKey) {
    return demoPool({ lng, lat, radius }).filter((p) => p.name.includes(keyword));
  }
  const data = await amapGet('/v3/place/around', {
    location: `${lng.toFixed(6)},${lat.toFixed(6)}`,
    radius: String(radius),
    types: '050000',
    keywords: keyword,
    offset: String(PAGE_SIZE),
    page: '1',
    extensions: 'all',
    sortrule: 'distance',
  });
  return (data.pois || [])
    .filter((p) => p.id && p.location && !CLOSED.test(p.name))
    .map((p) => {
      const poi = mapPoi(p);
      poi.distance = Math.round(distanceM(lng, lat, poi.lng, poi.lat));
      return poi;
    })
    .filter((p) => p.distance <= radius);
}

/** 某家店是否属于某个类别（用于判断收藏的店要不要上这次的转盘） */
export function matchesCategory(poi, category) {
  const cat = CATEGORIES[category];
  if (!cat || category === 'all') return true; // 「全部」时收藏的店都上
  if (cat.filter && !cat.filter.test(poi.name)) return false;
  const codes = String(poi.typecode || '').split('|');
  return cat.types.split('|').some((t) =>
    codes.some((c) =>
      t.endsWith('0000') ? c.startsWith(t.slice(0, 2)) : t.endsWith('00') ? c.startsWith(t.slice(0, 4)) : c === t
    )
  );
}

/** 地址文字 -> GCJ-02 坐标 */
export async function geocode(address) {
  if (!config.amapKey) return { lng: 116.397428, lat: 39.90923, label: `${address}（演示：北京天安门）` };
  const data = await amapGet('/v3/geocode/geo', { address });
  const g = (data.geocodes || [])[0];
  if (!g || !g.location) {
    const err = new Error('没找到这个地址，换个更详细的试试');
    err.status = 404;
    err.code = 'geocode_not_found';
    throw err;
  }
  const [lng, lat] = g.location.split(',').map(Number);
  return { lng, lat, label: g.formatted_address || address };
}
