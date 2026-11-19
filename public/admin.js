(() => {
  const $ = (id) => document.getElementById(id);
  const STATUS = {
    pending: '待付款',
    claimed: '用户称已付款',
    paid: '已确认',
    rejected: '已拒绝',
    cancelled: '已取消',
  };
  const store = {
    get: () => {
      try {
        return localStorage.getItem('eatwhat_admin') || '';
      } catch {
        return '';
      }
    },
    set: (v) => {
      try {
        v ? localStorage.setItem('eatwhat_admin', v) : localStorage.removeItem('eatwhat_admin');
      } catch {}
    },
  };

  let token = store.get();
  let scope = 'open';
  let timer;
  let busy = false;

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2500);
  }

  async function api(method, url) {
    const res = await fetch(url, { method, headers: { 'X-Admin-Token': token } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || '请求失败');
      err.code = data.error;
      throw err;
    }
    return data;
  }

  const fmt = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    const sameDay = d.toDateString() === new Date().toDateString();
    return (sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()} `) + `${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    for (const c of children) e.append(c);
    return e;
  }

  function render({ orders, stats }) {
    $('sSpins').textContent = stats.spins.free + stats.spins.paid;
    $('sSpins').title = `免费 ${stats.spins.free} / 付费 ${stats.spins.paid}`;
    $('sOrders').textContent = stats.paidOrders;
    $('sTotal').textContent = stats.paidTotal;
    const claimedCount = orders.filter((o) => o.status === 'claimed').length;
    document.title = (claimedCount ? `(${claimedCount}) ` : '') + '收款确认后台';

    const list = $('list');
    list.textContent = '';
    if (!orders.length) {
      list.append(el('div', { className: 'empty', textContent: scope === 'open' ? '没有待处理的订单 🎉' : '还没有订单' }));
      return;
    }
    for (const o of orders) {
      const open = o.status === 'pending' || o.status === 'claimed';
      const times = [`下单 ${fmt(o.createdAt)}`];
      if (o.claimedAt) times.push(`称已付 ${fmt(o.claimedAt)}`);
      if (o.handledAt && !open) times.push(`处理 ${fmt(o.handledAt)}`);

      const info = el('div', { className: 'info' }, [
        el('div', { className: 'st' }, [
          `¥${o.amount}`,
          el('span', { className: `badge b-${o.status}`, textContent: STATUS[o.status] || o.status }),
        ]),
        el('div', { textContent: times.join(' · ') }),
        el('div', { textContent: `IP ${o.ip || '-'} · 设备 ${o.device}` }),
      ]);
      const ops = el('div', { className: 'ops' });
      if (open) {
        const ok = el('button', { textContent: '确认到账' });
        ok.onclick = () => act(o, 'confirm');
        const no = el('button', { className: 'ghost', textContent: '没收到' });
        no.onclick = () => act(o, 'reject');
        ops.append(ok, no);
      }
      list.append(
        el('section', { className: `card order ${o.status}` }, [el('div', { className: 'code', textContent: o.code || '-' }), info, ops])
      );
    }
  }

  async function act(o, action) {
    const msg =
      action === 'confirm'
        ? `确认已收到备注 ${o.code} 的 ¥${o.amount}？确认后对方立刻获得 1 次机会。`
        : `确认没有收到备注 ${o.code} 的付款？`;
    if (!confirm(msg)) return;
    try {
      const r = await api('POST', `/api/admin/orders/${encodeURIComponent(o.orderId)}/${action}`);
      toast(r.ok ? (action === 'confirm' ? `已确认 ${o.code}，已加 1 次` : `已拒绝 ${o.code}`) : '订单状态已变化，未做修改');
    } catch (e) {
      toast(e.message);
    }
    load();
  }

  async function load() {
    if (busy) return;
    busy = true;
    try {
      render(await api('GET', `/api/admin/orders?scope=${scope}`));
      $('login').hidden = true;
      $('panel').hidden = false;
    } catch (e) {
      if (e.code === 'bad_token' || e.code === 'admin_disabled') {
        clearInterval(timer);
        $('panel').hidden = true;
        $('login').hidden = false;
        if (token) toast(e.message);
      } else toast(e.message);
    } finally {
      busy = false;
    }
  }

  function start() {
    clearInterval(timer);
    load();
    timer = setInterval(load, 5000);
  }

  $('btnLogin').onclick = () => {
    token = $('tokenInput').value.trim();
    if (!token) return;
    store.set(token);
    start();
  };
  $('tokenInput').onkeydown = (e) => e.key === 'Enter' && $('btnLogin').click();
  $('btnLogout').onclick = () => {
    token = '';
    store.set('');
    clearInterval(timer);
    $('panel').hidden = true;
    $('login').hidden = false;
  };
  document.querySelectorAll('.tabs .chip').forEach((b) => {
    b.onclick = () => {
      scope = b.dataset.scope;
      document.querySelectorAll('.tabs .chip').forEach((x) => x.classList.toggle('on', x === b));
      load();
    };
  });

  if (token) start();
  else $('login').hidden = false;
})();
