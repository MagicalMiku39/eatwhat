(() => {
  const $ = (id) => document.getElementById(id);
  const COLORS = ['#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6', '#f87171', '#fcd34d', '#4ade80', '#38bdf8'];
  const REASON = { out_of_range: '不在当前范围内', category: '不属于当前类别' };

  const state = {
    loc: null, // { lng, lat, coord: 'wgs84' | 'gcj02', label }
    category: 'all',
    wheelId: null, // 服务端组好的这一盘；转的时候只从这一盘里抽
    slices: [],
    favLimit: 10,
    rotation: 0,
    spinning: false,
    status: null,
    order: null,
  };

  // ---------- 工具 ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || '请求失败');
      err.code = data.error;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2500);
  }

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    for (const c of children) e.append(c);
    return e;
  }

  const shuffle = (a) => {
    a = [...a];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ---------- 转盘绘制 ----------
  const canvas = $('wheel');
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    const size = canvas.clientWidth;
    if (size < 20) return; // 页面隐藏/尚未布局时跳过，等 ResizeObserver 再触发
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // 转盘上只显示主店名：去掉「(国贸店)」这类分店后缀
  const clip = (s, n) => {
    s = s.replace(/[（(].*$/, '').trim() || s;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  function draw() {
    const size = canvas.clientWidth;
    if (size < 20) return;
    const c = size / 2;
    const r = c - 6;
    ctx.clearRect(0, 0, size, size);
    const n = state.slices.length;

    ctx.save();
    ctx.translate(c, c);
    if (!n) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = '#e7d9c8';
      ctx.fill();
      ctx.fillStyle = '#8a7968';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('定位后即可开转', 0, 6);
      ctx.restore();
      return;
    }
    ctx.rotate(state.rotation);
    const step = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + i * step;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, a0, a0 + step);
      ctx.closePath();
      let ci = i % COLORS.length;
      if (i === n - 1 && ci === 0 && n > 1) ci = 1; // 避免最后一格和第一格同色
      ctx.fillStyle = COLORS[ci];
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.save();
      ctx.rotate(a0 + step / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#3b2a1a';
      const sl = state.slices[i];
      ctx.font = `600 ${n > 12 ? 12 : n > 8 ? 13 : 15}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.fillText((sl.fav ? '★' : '') + clip(sl.name, n > 12 ? 6 : 8), r - 14, 5);
      ctx.restore();
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  /** 转到 index 号扇区中心（带随机抖动），返回 Promise */
  function animateTo(index) {
    return new Promise((resolve) => {
      const n = state.slices.length;
      const step = (Math.PI * 2) / n;
      const jitter = (Math.random() - 0.5) * step * 0.7;
      const target = -((index + 0.5) * step) + jitter; // 指针在正上方
      const start = state.rotation;
      const twoPi = Math.PI * 2;
      const base = ((target - start) % twoPi + twoPi) % twoPi;
      const delta = base + twoPi * (5 + Math.floor(Math.random() * 2));
      const dur = 4800;
      const t0 = performance.now();
      const ease = (t) => 1 - Math.pow(1 - t, 4);
      (function frame(now) {
        const t = Math.min(1, (now - t0) / dur);
        state.rotation = start + delta * ease(t);
        draw();
        if (t < 1) requestAnimationFrame(frame);
        else {
          state.rotation %= twoPi;
          resolve();
        }
      })(t0);
    });
  }

  // ---------- 数据 ----------
  const locParams = () => ({
    lng: state.loc.lng,
    lat: state.loc.lat,
    coord: state.loc.coord,
    radius: Number($('radius').value),
    category: state.category,
    minRating: Number($('minRating').value),
  });

  // 组一盘（服务端决定盘面）。连续切换筛选时只认最后一次的结果
  let wheelSeq = 0;
  async function loadWheel() {
    if (!state.loc || state.spinning) return;
    const seq = ++wheelSeq;
    $('wheelInfo').textContent = '加载中…';
    try {
      const data = await api('POST', '/api/wheel', locParams());
      if (seq !== wheelSeq) return;
      state.wheelId = data.wheelId;
      state.slices = data.slices;
      renderWheelInfo(data);
      renderFavorites(data.favorites);
    } catch (e) {
      if (seq !== wheelSeq) return;
      state.wheelId = null;
      state.slices = [];
      $('wheelInfo').textContent = e.message;
      $('btnReshuffle').hidden = true;
    }
    draw();
  }

  function renderWheelInfo(d) {
    const rating = Number($('minRating').value);
    let text;
    if (d.favCount) {
      text = `常去 ${d.favCount} 家 + 随机 ${d.randomCount} 家`;
      if (d.randomCount < d.favCount) text += `（符合条件的随机店只有 ${d.randomCount} 家）`;
    } else {
      text = `从附近 ${d.candidateTotal} 家${rating ? ` ${rating} 分以上` : ''}的店里随机 ${d.randomCount} 家`;
    }
    $('wheelInfo').textContent = text;
    $('btnReshuffle').hidden = d.candidateTotal <= d.randomCount; // 没有更多可换时隐藏
  }

  // ---------- 常去的店 ----------
  function renderFavorites(list) {
    const box = $('favList');
    box.textContent = '';
    $('favSummary').textContent = list.length ? `${list.length}/${state.favLimit}` : '';
    if (!list.length) {
      box.append(el('p', { className: 'muted small', textContent: '还没有。搜一下你常去的店加进来吧。' }));
      return;
    }
    for (const f of list) {
      const del = el('button', { className: 'link', textContent: '删除' });
      del.onclick = () => removeFavorite(f.id, f.name);
      const meta = [`${f.distance} 米`, f.rating && `⭐${f.rating}`, f.reason && REASON[f.reason]]
        .filter(Boolean)
        .join(' · ');
      box.append(
        el('div', { className: 'item' + (f.included ? '' : ' off') }, [
          el('div', { className: 'item-main' }, [
            el('div', { className: 'item-name', textContent: '★ ' + f.name }),
            el('div', { className: 'muted small', textContent: meta }),
          ]),
          del,
        ])
      );
    }
  }

  async function searchFavorites() {
    const keyword = $('favInput').value.trim();
    if (!keyword) return toast('输入店名再搜');
    if (!state.loc) return toast('请先定位或输入地址');
    const box = $('favResults');
    box.textContent = '搜索中…';
    try {
      const { items } = await api('POST', '/api/search', { ...locParams(), keyword });
      box.textContent = '';
      if (!items.length) {
        const range = $('radius').selectedOptions[0].text;
        box.append(el('p', { className: 'muted small', textContent: `${range}内没搜到「${keyword}」` }));
        return;
      }
      for (const p of items) {
        const btn = el('button', { className: 'ghost small-btn', textContent: p.fav ? '已添加' : '添加', disabled: p.fav });
        btn.onclick = () => addFavorite(p, btn);
        const meta = [`${p.distance} 米`, p.rating && `⭐${p.rating}`, p.cost && `人均¥${p.cost}`, p.address]
          .filter(Boolean)
          .join(' · ');
        box.append(
          el('div', { className: 'item' }, [
            el('div', { className: 'item-main' }, [
              el('div', { className: 'item-name', textContent: p.name }),
              el('div', { className: 'muted small', textContent: meta }),
            ]),
            btn,
          ])
        );
      }
    } catch (e) {
      box.textContent = '';
      toast(e.message);
    }
  }

  async function addFavorite(p, btn) {
    btn.disabled = true;
    try {
      await api('POST', '/api/favorites', { poiId: p.id });
      btn.textContent = '已添加';
      toast(`已添加「${clip(p.name, 12)}」`);
      loadWheel();
    } catch (e) {
      btn.disabled = false;
      toast(e.message);
    }
  }

  async function removeFavorite(id, name) {
    try {
      await api('DELETE', '/api/favorites/' + encodeURIComponent(id));
      toast(`已删除「${clip(name, 12)}」`);
      $('favResults').textContent = ''; // 搜索结果里的「已添加」状态过时了，清掉
      loadWheel();
    } catch (e) {
      toast(e.message);
    }
  }

  function renderStatus() {
    const s = state.status;
    if (!s) return;
    $('demoTip').hidden = !s.demo;
    const parts = [];
    parts.push(s.freeLeft > 0 ? `今日免费次数：${s.freeLeft}` : '今日免费次数已用完');
    if (s.credits > 0) parts.push(`已购次数：${s.credits}`);
    // 页面刷新后恢复未完成的订单
    if (s.openOrder && (!state.order || state.order.orderId !== s.openOrder.orderId)) trackOrder(s.openOrder);
    const o = state.order;
    if (o && o.status === 'claimed') parts.push(`订单 ${o.code} 等待管理员确认`);
    $('status').textContent = parts.join(' · ');
    const buy = $('btnBuy');
    const noChance = s.freeLeft <= 0 && s.credits <= 0;
    buy.hidden = !(o || noChance);
    buy.textContent = o ? `查看订单（备注 ${o.code}）` : `不满意？扫码支付 ¥${s.amount}，再转一次`;
  }

  async function refreshStatus() {
    state.status = await api('GET', '/api/status');
    renderStatus();
  }

  // ---------- 定位 ----------
  function setLoc(loc) {
    state.loc = loc;
    $('locLabel').textContent = '📍 ' + loc.label;
    loadWheel();
  }

  function locate() {
    if (!navigator.geolocation) {
      $('locLabel').textContent = '浏览器不支持定位，请输入地址';
      return;
    }
    $('locLabel').textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
      (p) => setLoc({ lng: p.coords.longitude, lat: p.coords.latitude, coord: 'wgs84', label: '当前位置' }),
      (err) => {
        $('locLabel').textContent = '定位失败（需 HTTPS/授权），请输入地址';
        console.warn(err);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  async function useAddress() {
    const address = $('addrInput').value.trim();
    if (!address) return toast('请输入地址');
    try {
      const g = await api('GET', '/api/geocode?address=' + encodeURIComponent(address));
      setLoc({ lng: g.lng, lat: g.lat, coord: 'gcj02', label: g.label });
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- 转 ----------
  function showResult(p) {
    const box = $('result');
    box.innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = '🎉 ' + p.name;
    box.appendChild(h);
    const lines = [
      p.fav && '★ 你常去的店',
      [p.type, p.rating && '⭐' + p.rating, p.cost && '人均 ¥' + p.cost].filter(Boolean).join(' · '),
      p.distance && `距离约 ${p.distance} 米`,
      p.address,
      p.tel && `电话：${p.tel}`,
    ].filter(Boolean);
    for (const l of lines) {
      const el = document.createElement('p');
      el.textContent = l;
      box.appendChild(el);
    }
    if (p.lng && p.lat) {
      const a = document.createElement('a');
      a.href = `https://uri.amap.com/marker?position=${p.lng},${p.lat}&name=${encodeURIComponent(p.name)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '用高德地图导航 →';
      box.appendChild(a);
    }
    box.hidden = false;
  }

  async function spin() {
    if (state.spinning) return;
    if (!state.loc) return toast('请先定位或输入地址');
    if (!state.slices.length || !state.wheelId) return toast('附近没有可转的餐厅');
    state.spinning = true;
    $('btnSpin').disabled = true;
    $('result').hidden = true;
    try {
      const r = await api('POST', '/api/spin', { wheelId: state.wheelId });
      await animateTo(r.index);
      showResult(r.poi);
      state.status = r.status;
      renderStatus();
    } catch (e) {
      if (e.code === 'no_chance') {
        await refreshStatus();
        toast('今天的免费次数用完了，可扫码再转一次');
      } else if (e.code === 'wheel_expired') {
        state.spinning = false;
        await loadWheel(); // 服务重启或放太久，重新组一盘（没扣次数）
        toast(e.message);
      } else toast(e.message);
    } finally {
      state.spinning = false;
      $('btnSpin').disabled = false;
    }
  }

  // ---------- 支付 ----------
  // manual 模式：扫管理员收款码转账（备注 4 位码）→「我已付款」→ 管理员后台确认 → 自动加次数
  const FINAL = ['paid', 'rejected', 'cancelled'];
  let pollTimer;

  function renderPayModal() {
    const o = state.order;
    const s = state.status;
    if (!o || !s) return;
    const manual = s.payMode === 'manual';
    const claimed = o.status === 'claimed';
    const qr = $('qrBox');
    qr.textContent = '';
    if (manual && s.hasQr) {
      const img = document.createElement('img');
      img.src = '/pay-qr';
      img.alt = '收款码';
      qr.appendChild(img);
    } else {
      qr.textContent = manual ? '管理员还没放收款码，请直接联系管理员' : '模拟支付（开发用）';
    }
    $('payTitle').textContent = claimed ? '等待管理员确认' : '扫码支付，再转一次';
    $('payAmount').textContent = '¥' + o.amount;
    $('payCode').textContent = o.code;
    $('payHint').textContent = claimed
      ? '已通知管理员，确认到账后会自动加 1 次机会，可以先关掉这个窗口。'
      : manual
        ? '转账时请备注上面的 4 位数字，付完点「我已付款」。'
        : '';
    $('btnClaim').hidden = !manual || claimed;
    $('btnMockPay').hidden = manual || claimed;
    $('btnPayCancel').hidden = claimed;
  }

  /** 跟踪一个订单：未结束就每 3 秒查一次状态（弹窗关了也继续查） */
  function trackOrder(o) {
    clearInterval(pollTimer);
    state.order = o && !FINAL.includes(o.status) ? o : null;
    if (state.order) pollTimer = setInterval(checkOrder, 3000);
  }

  async function checkOrder() {
    if (!state.order) return;
    let o;
    try {
      o = await api('GET', '/api/orders/' + state.order.orderId);
    } catch {
      return;
    }
    const prev = state.order.status;
    if (FINAL.includes(o.status)) {
      trackOrder(null);
      $('payModal').hidden = true;
      if (o.status === 'paid') toast('付款已确认，获得 1 次机会！');
      else if (o.status === 'rejected') toast(`订单 ${o.code} 没有确认到账，有疑问请联系管理员`);
      await refreshStatus();
    } else if (o.status !== prev) {
      state.order = o;
      renderPayModal();
      renderStatus();
    }
  }

  async function openPay() {
    if (!state.order) {
      try {
        trackOrder(await api('POST', '/api/orders'));
      } catch (e) {
        return toast(e.message);
      }
    }
    renderPayModal();
    renderStatus();
    $('payModal').hidden = false;
  }

  async function orderAction(action) {
    if (!state.order) return;
    try {
      const o = await api('POST', `/api/orders/${state.order.orderId}/${action}`);
      if (FINAL.includes(o.status)) {
        state.order = o; // 交给 checkOrder 统一收尾
        return checkOrder();
      }
      trackOrder(o);
      renderPayModal();
      renderStatus();
    } catch (e) {
      toast(e.message);
    }
  }

  async function cancelPay() {
    if (!state.order) return;
    try {
      await api('POST', `/api/orders/${state.order.orderId}/cancel`);
    } catch (e) {
      return toast(e.message);
    }
    trackOrder(null);
    $('payModal').hidden = true;
    await refreshStatus(); // 用最新状态，避免旧的 openOrder 把已取消的单又挂回来
  }

  // ---------- 初始化 ----------
  async function init() {
    const meta = await api('GET', '/api/meta');
    state.status = meta;
    state.favLimit = meta.favLimit || 10;
    renderStatus();

    const chips = $('chips');
    for (const c of meta.categories) {
      const b = document.createElement('button');
      b.className = 'chip' + (c.key === state.category ? ' on' : '');
      b.textContent = c.name;
      b.onclick = () => {
        if (state.spinning) return;
        state.category = c.key;
        chips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b));
        loadWheel();
      };
      chips.appendChild(b);
    }

    $('radius').onchange = loadWheel;
    $('minRating').onchange = loadWheel;
    $('btnReshuffle').onclick = loadWheel;
    $('btnFavSearch').onclick = searchFavorites;
    $('favInput').onkeydown = (e) => e.key === 'Enter' && searchFavorites();
    $('btnLocate').onclick = locate;
    $('btnAddr').onclick = useAddress;
    $('addrInput').onkeydown = (e) => e.key === 'Enter' && useAddress();
    $('btnSpin').onclick = spin;
    $('btnBuy').onclick = openPay;
    $('btnClaim').onclick = () => orderAction('claim');
    $('btnMockPay').onclick = () => orderAction('mock-pay');
    $('btnPayCancel').onclick = cancelPay;
    $('btnPayClose').onclick = () => ($('payModal').hidden = true);

    new ResizeObserver(resizeCanvas).observe(canvas);
    resizeCanvas();
    locate();
  }

  init().catch((e) => toast(e.message));
})();
