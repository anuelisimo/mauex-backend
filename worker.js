/**
 * MAUex Cloudflare Worker v3
 * 
 * SETUP EN CLOUDFLARE DASHBOARD:
 * 1. Workers & Pages → tu worker → Settings → Variables:
 *    BINANCE_KEY, BINANCE_SECRET
 *    BYBIT_KEY, BYBIT_SECRET
 *    OKX_KEY, OKX_SECRET, OKX_PASSPHRASE
 *    MEXC_KEY, MEXC_SECRET
 *
 * 2. Workers & Pages → tu worker → Settings → KV Namespaces:
 *    Bind: MAUEX_CACHE (crear namespace primero en KV section)
 *
 * 3. Workers & Pages → tu worker → Settings → Triggers → Cron:
 *    Agregar: * * * * * (cada minuto)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── HMAC-SHA256 (Web Crypto API) ─────────────────────────────────────────────
async function hmac256(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Safe fetch (returns parsed JSON or null) ─────────────────────────────────
async function safeFetch(url, opts = {}) {
  try {
    const r    = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    try {
      return { ok: r.ok, status: r.status, data: JSON.parse(text) };
    } catch(e) {
      return { ok: false, status: r.status, data: null, raw: text.slice(0, 300) };
    }
  } catch(e) {
    return { ok: false, status: 0, data: null, raw: e.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// BINANCE — via Railway server (IPv4 whitelisted in Binance)
// ═════════════════════════════════════════════════════════════════════════════
async function syncBinance(env) {
  const railwayUrl = (env.RAILWAY_URL || '').trim();
  if (!railwayUrl) return { positions: [], orders: [], error: 'RAILWAY_URL not set' };

  try {
    const r = await safeFetch(`${railwayUrl}/binance-positions`);
    if (!r.ok || !r.data) {
      return { positions: [], orders: [], error: `Railway: ${r.status} ${r.raw || ''}` };
    }
    if (r.data.error) {
      return { positions: [], orders: [], error: `Binance via Railway: ${r.data.error}` };
    }

    const r2 = await safeFetch(`${railwayUrl}/binance-orders`);
    const orders = r2.ok && r2.data?.orders ? r2.data.orders : [];

    return {
      positions: r.data.positions || [],
      orders,
      error: null,
    };
  } catch(e) {
    return { positions: [], orders: [], error: e.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// BYBIT
// ═════════════════════════════════════════════════════════════════════════════
async function syncBybit(env) {
  const key = env.BYBIT_KEY;
  const sec = env.BYBIT_SECRET;
  if (!key || !sec) return { positions: [], orders: [], error: 'No keys' };

  const positions = [];
  const orders    = [];

  // Trim keys to remove any accidental whitespace
  const k = key.trim();
  const s = sec.trim();

  const bybitHdr = async (q) => {
    const ts  = Date.now().toString();
    const msg = ts + k + '5000' + q;
    return {
      'X-BAPI-API-KEY':     k,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-SIGN':        await hmac256(s, msg),
      'X-BAPI-RECV-WINDOW': '5000',
    };
  };

  try {
    const q1 = 'category=linear&settleCoin=USDT';
    const r1 = await safeFetch(
      `https://api.bybit.com/v5/position/list?${q1}`,
      { headers: await bybitHdr(q1) }
    );

    if (!r1.ok || !r1.data) {
      return { positions, orders, error: `${r1.status} ${r1.raw || 'no data'}` };
    }
    if (r1.data.retCode !== 0) {
      return { positions, orders, error: `retCode ${r1.data.retCode}: ${r1.data.retMsg}` };
    }

    for (const p of (r1.data.result?.list || []).filter(p => parseFloat(p.size) > 0)) {
      const entry    = parseFloat(p.avgPrice);
      const mark     = parseFloat(p.markPrice);
      const lev      = parseInt(p.leverage) || 1;
      const notional = parseFloat(p.positionValue) || 0;
      const pnl      = parseFloat(p.unrealisedPnl);
      const margin   = notional / lev;
      const liq      = parseFloat(p.liqPrice) || 0;
      const dir      = p.side === 'Buy' ? 'long' : 'short';

      positions.push({
        exchange: 'BYBIT', type: 'futures',
        ticker:      p.symbol.replace('USDT',''),
        symbol:      p.symbol, dir,
        entry, mark,
        pnl:         Math.round(pnl * 100) / 100,
        pnlPct:      margin > 0 ? Math.round(pnl / margin * 10000) / 100 : 0,
        posSize:     Math.round(notional * 100) / 100,
        margin:      Math.round(margin * 100) / 100,
        leverage:    lev, liquidation: liq,
        sl:          parseFloat(p.stopLoss) || null,
        tp1:         parseFloat(p.takeProfit) || null,
        tp2: null, tp3: null,
        exchangeId:  `bybit-pos-${p.symbol}-${dir}`,
        openTime:    parseInt(p.createdTime) || null,
      });
    }

    const q2 = 'category=linear&settleCoin=USDT';
    const r2 = await safeFetch(
      `https://api.bybit.com/v5/order/realtime?${q2}`,
      { headers: await bybitHdr(q2) }
    );
    if (r2.ok && r2.data?.retCode === 0) {
      for (const o of (r2.data.result?.list || [])) {
        orders.push({
          exchange: 'BYBIT', type: o.orderType,
          ticker:     o.symbol.replace('USDT',''),
          symbol:     o.symbol,
          dir:        o.side === 'Buy' ? 'long' : 'short',
          price:      parseFloat(o.price) || parseFloat(o.triggerPrice) || 0,
          origQty:    parseFloat(o.qty),
          size:       parseFloat(o.qty) * (parseFloat(o.price) || 0),
          tp1:        parseFloat(o.takeProfit) || null,
          sl:         parseFloat(o.stopLoss)   || null,
          leverage:   parseInt(o.leverage)     || null,
          exchangeId: `bybit-ord-${o.orderId}`,
        });
      }
    }

    return { positions, orders, error: null };
  } catch(e) {
    return { positions, orders, error: e.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// OKX
// ═════════════════════════════════════════════════════════════════════════════
async function syncOKX(env) {
  const key  = (env.OKX_KEY || '').trim();
  const sec  = (env.OKX_SECRET || '').trim();
  const pass = (env.OKX_PASSPHRASE || '').trim();
  if (!key || !sec || !pass) return { positions: [], orders: [], error: 'No keys' };

  const positions = [];
  const orders    = [];

  const okxHdr = async (path) => {
    const ts  = new Date().toISOString();
    const msg = ts + 'GET' + path;
    const key2 = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(sec),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key2, new TextEncoder().encode(msg));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return {
      'OK-ACCESS-KEY':        key,
      'OK-ACCESS-SIGN':       b64,
      'OK-ACCESS-TIMESTAMP':  ts,
      'OK-ACCESS-PASSPHRASE': pass,
      'Content-Type':         'application/json',
    };
  };

  try {
    const path1 = '/api/v5/account/positions?instType=SWAP';
    const r1    = await safeFetch(
      `https://www.okx.com${path1}`,
      { headers: await okxHdr(path1) }
    );

    if (!r1.ok || !r1.data) {
      return { positions, orders, error: `${r1.status} ${r1.raw || ''}` };
    }
    if (r1.data.code !== '0') {
      return { positions, orders, error: `OKX ${r1.data.code}: ${r1.data.msg}` };
    }

    for (const p of (r1.data.data || []).filter(p => parseFloat(p.pos) !== 0)) {
      const entry    = parseFloat(p.avgPx);
      const mark     = parseFloat(p.markPx);
      const lev      = parseInt(p.lever) || 1;
      const notional = Math.abs(parseFloat(p.notionalUsd)) || 0;
      const pnl      = parseFloat(p.upl);
      const margin   = parseFloat(p.margin) || notional / lev;
      const liq      = parseFloat(p.liqPx) || 0;
      const dir      = parseFloat(p.pos) > 0 ? 'long' : 'short';
      const ticker   = p.instId.replace('-USDT-SWAP','').replace('-','');

      positions.push({
        exchange: 'OKX', type: 'futures',
        ticker, symbol: p.instId, dir,
        entry, mark,
        pnl:         Math.round(pnl * 100) / 100,
        pnlPct:      margin > 0 ? Math.round(pnl / margin * 10000) / 100 : 0,
        posSize:     Math.round(notional * 100) / 100,
        margin:      Math.round(margin * 100) / 100,
        leverage:    lev, liquidation: liq,
        sl: null, tp1: null, tp2: null, tp3: null,
        exchangeId:  `okx-pos-${p.instId}-${dir}`,
      });
    }

    const path2 = '/api/v5/trade/orders-pending?instType=SWAP';
    const r2    = await safeFetch(
      `https://www.okx.com${path2}`,
      { headers: await okxHdr(path2) }
    );
    if (r2.ok && r2.data?.code === '0') {
      for (const o of (r2.data.data || [])) {
        orders.push({
          exchange: 'OKX', type: o.ordType,
          ticker:     o.instId.replace('-USDT-SWAP','').replace('-',''),
          symbol:     o.instId,
          dir:        o.side === 'buy' ? 'long' : 'short',
          price:      parseFloat(o.px) || 0,
          origQty:    parseFloat(o.sz),
          size:       parseFloat(o.sz) * (parseFloat(o.px) || 0),
          tp1:        parseFloat(o.tpTriggerPx) || null,
          sl:         parseFloat(o.slTriggerPx) || null,
          leverage:   parseInt(o.lever) || null,
          exchangeId: `okx-ord-${o.ordId}`,
        });
      }
    }

    return { positions, orders, error: null };
  } catch(e) {
    return { positions, orders, error: e.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MEXC
// ═════════════════════════════════════════════════════════════════════════════
async function syncMEXC(env) {
  const key = (env.MEXC_KEY || '').trim();
  const sec = (env.MEXC_SECRET || '').trim();
  if (!key || !sec) return { positions: [], orders: [], error: 'No keys' };

  const positions = [];
  const orders    = [];

  try {
    const ts = Date.now().toString();
    // MEXC contract API signature: HMAC_SHA256(secret, accessKey + timestamp)
    const sig = await hmac256(sec, key + ts);

    const r1 = await safeFetch(
      'https://contract.mexc.com/api/v1/private/position/open_positions',
      { headers: { 'ApiKey': key, 'Request-Time': ts, 'Signature': sig, 'Content-Type': 'application/json' } }
    );

    if (!r1.ok || !r1.data) {
      return { positions, orders, error: `${r1.status} ${r1.raw || ''}` };
    }
    if (!r1.data.success) {
      return { positions, orders, error: `MEXC ${r1.data.code}: ${r1.data.message}` };
    }

    for (const p of (r1.data.data || [])) {
      const entry    = parseFloat(p.openAvgPrice) || 0;
      const mark     = parseFloat(p.markPrice) || entry;
      const lev      = parseInt(p.leverage) || 1;
      const notional = parseFloat(p.positionValue) || 0;
      const pnl      = parseFloat(p.unrealisedPnl) || 0;
      const margin   = notional / lev;
      const liq      = parseFloat(p.liquidatePrice) || 0;
      const dir      = p.positionType === 1 ? 'long' : 'short';
      const ticker   = p.symbol.replace('_USDT','').replace('USDT','');

      positions.push({
        exchange: 'MEXC', type: 'futures',
        ticker, symbol: p.symbol, dir,
        entry, mark,
        pnl:         Math.round(pnl * 100) / 100,
        pnlPct:      margin > 0 ? Math.round(pnl / margin * 10000) / 100 : 0,
        posSize:     Math.round(notional * 100) / 100,
        margin:      Math.round(margin * 100) / 100,
        leverage:    lev, liquidation: liq,
        sl:          parseFloat(p.stopLossPrice) || null,
        tp1:         parseFloat(p.takeProfitPrice) || null,
        tp2: null, tp3: null,
        exchangeId:  `mexc-pos-${p.symbol}-${dir}`,
      });
    }

    return { positions, orders, error: null };
  } catch(e) {
    return { positions, orders, error: e.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// BALANCES — free USDT/USDC not locked in positions or orders
// ═════════════════════════════════════════════════════════════════════════════
function normalizeBalance(raw = {}) {
  const usdt = Number(raw.USDT ?? raw.usdt ?? 0) || 0;
  const usdc = Number(raw.USDC ?? raw.usdc ?? 0) || 0;
  const fallbackTotal = usdt + usdc;
  const total = Number(raw.total ?? raw.totalEquity ?? raw.wallet ?? fallbackTotal) || 0;
  const free = Number(raw.free ?? raw.available ?? raw.availableBalance ?? (fallbackTotal || total)) || 0;
  const margin = Number(raw.margin ?? raw.marginUsed ?? 0) || 0;
  const orders = Number(raw.orders ?? raw.orderMargin ?? 0) || 0;
  const pnl = Number(raw.pnl ?? raw.unrealizedPnl ?? raw.upnl ?? 0) || 0;

  return {
    total: Math.round(total * 100) / 100,
    free: Math.round(free * 100) / 100,
    margin: Math.round(margin * 100) / 100,
    orders: Math.round(orders * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    USDT: Math.round(usdt * 100) / 100,
    USDC: Math.round(usdc * 100) / 100,
  };
}

async function fetchBalances(env) {
  const balances = {};
  const errors   = {};

  // ── Binance via Railway ──────────────────────────────────────────────────
  const railwayUrl = (env.RAILWAY_URL || '').trim();
  if (railwayUrl) {
    try {
      const r = await safeFetch(`${railwayUrl}/binance-balance`);
      if (r.ok && r.data && !r.data.error) {
        balances.BINANCE = normalizeBalance(r.data);
      } else {
        errors.BINANCE = r.data?.error || `${r.status}`;
      }
    } catch(e) { errors.BINANCE = e.message; }
  }

  // ── Bybit ────────────────────────────────────────────────────────────────
  const bybitKey = (env.BYBIT_KEY || '').trim();
  const bybitSec = (env.BYBIT_SECRET || '').trim();
  if (bybitKey && bybitSec) {
    try {
      const bybitBalance = async (accountType) => {
        const ts  = Date.now().toString();
        const q   = `accountType=${accountType}`;
        const msg = ts + bybitKey + '5000' + q;
        const sig = await hmac256(bybitSec, msg);
        return safeFetch(
          `https://api.bybit.com/v5/account/wallet-balance?${q}`,
          { headers: { 'X-BAPI-API-KEY': bybitKey, 'X-BAPI-TIMESTAMP': ts,
                       'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': '5000' } }
        );
      };

      // Try UNIFIED first, fall back to CONTRACT
      let r = await bybitBalance('UNIFIED');
      if (!r.ok || r.data?.retCode !== 0) {
        r = await bybitBalance('CONTRACT');
      }

      if (r.ok && r.data?.retCode === 0) {
        // Sum across all accounts returned
        let totalUsdt = 0, totalUsdc = 0;
        for (const account of (r.data.result?.list || [])) {
          const coins = account.coin || [];
          const usdt  = coins.find(c => c.coin === 'USDT');
          const usdc  = coins.find(c => c.coin === 'USDC');
          totalUsdt += parseFloat(usdt?.availableToWithdraw || usdt?.walletBalance || 0);
          totalUsdc += parseFloat(usdc?.availableToWithdraw || usdc?.walletBalance || 0);
        }
        balances.BYBIT = normalizeBalance({
          total: totalUsdt + totalUsdc,
          free: totalUsdt + totalUsdc,
          margin: 0,
          orders: 0,
          pnl: 0,
          USDT: totalUsdt,
          USDC: totalUsdc,
        });
      } else {
        errors.BYBIT = r.data?.retMsg || `${r.status}`;
      }
    } catch(e) { errors.BYBIT = e.message; }
  }

  // ── OKX ──────────────────────────────────────────────────────────────────
  const okxKey  = (env.OKX_KEY || '').trim();
  const okxSec  = (env.OKX_SECRET || '').trim();
  const okxPass = (env.OKX_PASSPHRASE || '').trim();
  if (okxKey && okxSec && okxPass) {
    try {
      const okxGet = async (path) => {
        const ts   = new Date().toISOString();
        const key2 = await crypto.subtle.importKey('raw', new TextEncoder().encode(okxSec),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sig  = await crypto.subtle.sign('HMAC', key2, new TextEncoder().encode(ts + 'GET' + path));
        const b64  = btoa(String.fromCharCode(...new Uint8Array(sig)));
        return safeFetch(`https://www.okx.com${path}`, {
          headers: { 'OK-ACCESS-KEY': okxKey, 'OK-ACCESS-SIGN': b64,
                     'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': okxPass,
                     'Content-Type': 'application/json' }
        });
      };

      let usdtTotal = 0, usdcTotal = 0;

      // Trading account (futures/swaps)
      const r1 = await okxGet('/api/v5/account/balance?ccy=USDT,USDC');
      if (r1.ok && r1.data?.code === '0') {
        const details = r1.data.data?.[0]?.details || [];
        usdtTotal += parseFloat(details.find(d=>d.ccy==='USDT')?.availEq || 0);
        usdcTotal += parseFloat(details.find(d=>d.ccy==='USDC')?.availEq || 0);
      }

      // Funding account
      const r2 = await okxGet('/api/v5/asset/balances?ccy=USDT,USDC');
      if (r2.ok && r2.data?.code === '0') {
        for (const b of (r2.data.data || [])) {
          if (b.ccy === 'USDT') usdtTotal += parseFloat(b.availBal || 0);
          if (b.ccy === 'USDC') usdcTotal += parseFloat(b.availBal || 0);
        }
      }

      balances.OKX = normalizeBalance({
        total: usdtTotal + usdcTotal,
        free: usdtTotal + usdcTotal,
        margin: 0,
        orders: 0,
        pnl: 0,
        USDT: usdtTotal,
        USDC: usdcTotal,
      });

      if (!r1.ok && !r2.ok) errors.OKX = r1.data?.msg || `${r1.status}`;
    } catch(e) { errors.OKX = e.message; }
  }

  // ── MEXC ─────────────────────────────────────────────────────────────────
  const mexcKey = (env.MEXC_KEY || '').trim();
  const mexcSec = (env.MEXC_SECRET || '').trim();
  if (mexcKey && mexcSec) {
    try {
      let usdtTotal = 0, usdcTotal = 0;

      // Futures account
      const ts1  = Date.now().toString();
      const sig1 = await hmac256(mexcSec, mexcKey + ts1);
      const r1   = await safeFetch(
        'https://contract.mexc.com/api/v1/private/account/assets',
        { headers: { 'ApiKey': mexcKey, 'Request-Time': ts1,
                     'Signature': sig1, 'Content-Type': 'application/json' } }
      );
      if (r1.ok && r1.data?.success) {
        const assets = r1.data.data || [];
        usdtTotal += parseFloat(assets.find(a=>a.currency==='USDT')?.availableBalance || 0);
        usdcTotal += parseFloat(assets.find(a=>a.currency==='USDC')?.availableBalance || 0);
      }

      // Spot account
      const ts2  = Date.now().toString();
      const q2   = `timestamp=${ts2}`;
      const sig2 = await hmac256(mexcSec, q2);
      const r2   = await safeFetch(
        `https://api.mexc.com/api/v3/account?${q2}&signature=${sig2}`,
        { headers: { 'X-MEXC-APIKEY': mexcKey } }
      );
      if (r2.ok && r2.data?.balances) {
        for (const b of r2.data.balances) {
          if (b.asset === 'USDT') usdtTotal += parseFloat(b.free || 0);
          if (b.asset === 'USDC') usdcTotal += parseFloat(b.free || 0);
        }
      }

      balances.MEXC = normalizeBalance({
        total: usdtTotal + usdcTotal,
        free: usdtTotal + usdcTotal,
        margin: 0,
        orders: 0,
        pnl: 0,
        USDT: usdtTotal,
        USDC: usdcTotal,
      });

      if (!r1.ok && !r2.ok) errors.MEXC = r1.data?.message || `${r1.status}`;
    } catch(e) { errors.MEXC = e.message; }
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  let totalUsdt = 0, totalUsdc = 0;
  for (const b of Object.values(balances)) {
    totalUsdt += b.USDT || 0;
    totalUsdc += b.USDC || 0;
  }

  return {
    balances,  // per-exchange breakdown
    totals: {
      USDT: Math.round(totalUsdt * 100) / 100,
      USDC: Math.round(totalUsdc * 100) / 100,
      total: Math.round((totalUsdt + totalUsdc) * 100) / 100,
    },
    errors,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN SYNC — called by cron and by /sync endpoint
// ═════════════════════════════════════════════════════════════════════════════
async function syncAll(env) {
  let balanceData = { balances: {}, totals: { USDT: 0, USDC: 0, total: 0 }, errors: {} };
  try { balanceData = await fetchBalances(env); } catch(e) {}

  const payload = {
    positions: [],
    orders: [],
    errors: balanceData.errors,
    totalPnl: 0,
    marginInUse: 0,
    lastSync:     new Date().toISOString(),
    count: { positions: 0, orders: 0 },
    balances:     balanceData.balances,
    liquidity:    balanceData.totals,
    balanceErrors: balanceData.errors,
  };

  // Save to KV — only write if data changed (saves KV write quota)
  if (env.MAUEX_CACHE) {
    const prev = await env.MAUEX_CACHE.get('summary');
    const newStr = JSON.stringify(payload);
    // Compare position count and total PnL to detect changes
    let changed = true;
    if (prev) {
      try {
        const prevData = JSON.parse(prev);
        changed = prevData.count?.positions !== payload.count?.positions ||
                  prevData.count?.orders    !== payload.count?.orders    ||
                  Math.abs((prevData.totalPnl||0) - (payload.totalPnl||0)) > 0.5 ||
                  JSON.stringify(prevData.balances || {}) !== JSON.stringify(payload.balances || {}) ||
                  JSON.stringify(prevData.balanceErrors || {}) !== JSON.stringify(payload.balanceErrors || {}) ||
                  JSON.stringify(prevData.errors || {}) !== JSON.stringify(payload.errors || {});
      } catch(e) {}
    }
    if (changed) {
      await env.MAUEX_CACHE.put('summary', newStr, { expirationTtl: 600 });
    }
  }

  return payload;
}

// ═════════════════════════════════════════════════════════════════════════════
// WORKER ENTRY POINT
// ═════════════════════════════════════════════════════════════════════════════
export default {

  // ── HTTP requests ─────────────────────────────────────────────────────────
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const json = (data, status = 200) => new Response(
      JSON.stringify(data),
      { status, headers: { 'Content-Type': 'application/json', ...CORS } }
    );

    // ── /health ──────────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      let cached = null;
      if (env.MAUEX_CACHE) {
        const raw = await env.MAUEX_CACHE.get('summary');
        if (raw) cached = JSON.parse(raw);
      }
      return json({
        status:    'ok',
        lastSync:  cached?.lastSync || null,
        positions: cached?.count?.positions || 0,
        orders:    cached?.count?.orders || 0,
        errors:    cached?.errors || {},
        hasKV:     !!env.MAUEX_CACHE,
        keys: {
          binance: !!env.RAILWAY_URL,
          bybit:   !!env.BYBIT_KEY,
          okx:     !!env.OKX_KEY,
          mexc:    !!env.MEXC_KEY,
        },
        railwayUrl: env.RAILWAY_URL || null
      });
    }

    // ── /balance — free liquidity per exchange ───────────────────────────────
    if (url.pathname === '/balance') {
      const forceLive = url.searchParams.has('live') || url.searchParams.has('t');
      // Try KV cache first (balance is part of summary)
      let cached = null;
      if (!forceLive && env.MAUEX_CACHE) {
        const raw = await env.MAUEX_CACHE.get('summary');
        if (raw) {
          try {
            const d = JSON.parse(raw);
            if (d.liquidity) cached = { balances: d.balances, liquidity: d.liquidity, errors: d.balanceErrors || {} };
          } catch(e) {}
        }
      }
      if (cached) return json(cached);
      // No cache — fetch live
      const data = await fetchBalances(env);
      return json(data);
    }

    // ── /summary, /positions, /orders — read from KV ─────────────────────────
    if (['/summary', '/positions', '/orders'].includes(url.pathname)) {
      let data = null;
      if (env.MAUEX_CACHE) {
        const raw = await env.MAUEX_CACHE.get('summary');
        if (raw) data = JSON.parse(raw);
      }

      if (!data) {
        // No cache yet — do a live sync
        data = await syncAll(env);
      }

      if (url.pathname === '/positions') return json({ positions: data.positions, lastSync: data.lastSync, errors: data.errors });
      if (url.pathname === '/orders')    return json({ orders: data.orders, lastSync: data.lastSync });
      return json(data);
    }

    // ── /sync — force immediate sync ─────────────────────────────────────────
    if (url.pathname === '/sync') {
      const data = await syncAll(env);
      return json(data);
    }

    // ── /myip ────────────────────────────────────────────────────────────────
    if (url.pathname === '/myip') {
      let ip = null;
      try {
        const r = await fetch('https://api4.ipify.org?format=json');
        const d = await r.json();
        ip = d.ip;
      } catch(e) {
        try {
          const r2 = await fetch('https://ipv4.icanhazip.com');
          ip = (await r2.text()).trim();
        } catch(e2) { ip = 'IPv4 not available'; }
      }
      return json({ ip, note: 'Add this IPv4 to Binance API whitelist' });
    }

    // ── /import-history ──────────────────────────────────────────────────────
    if (url.pathname === '/import-history') {
      const from = url.searchParams.get('from') || '2026-01-01';
      const to   = url.searchParams.get('to')   || new Date().toISOString().split('T')[0];
      const startTs = new Date(from).getTime();
      const endTs   = new Date(to).getTime() + 86400000; // end of day

      const trades  = [];
      const summary = [];

      // Binance via Railway
      const railwayUrl = (env.RAILWAY_URL || '').trim();
      if (railwayUrl) {
        try {
          const r = await safeFetch(`${railwayUrl}/binance-history?from=${startTs}&to=${endTs}`);
          if (r.ok && r.data?.trades) {
            trades.push(...r.data.trades);
            summary.push(`✅ BINANCE: ${r.data.trades.length} trades`);
          } else {
            summary.push(`⚠️ BINANCE: ${r.data?.error || 'sin datos'}`);
          }
        } catch(e) {
          summary.push(`❌ BINANCE: ${e.message}`);
        }
      }

      // Bybit history
      const bybitKey = (env.BYBIT_KEY || '').trim();
      const bybitSec = (env.BYBIT_SECRET || '').trim();
      if (bybitKey && bybitSec) {
        try {
          const ts  = Date.now().toString();
          const q   = `category=linear&startTime=${startTs}&endTime=${endTs}&limit=100`;
          const msg = ts + bybitKey + '5000' + q;
          const sig = await hmac256(bybitSec, msg);
          const r   = await safeFetch(
            `https://api.bybit.com/v5/execution/list?${q}`,
            { headers: { 'X-BAPI-API-KEY': bybitKey, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': '5000' } }
          );
          if (r.ok && r.data?.retCode === 0) {
            const byOrder = {};
            (r.data.result?.list || []).forEach(t => {
              if(!byOrder[t.orderId]) byOrder[t.orderId] = { trades:[], symbol:t.symbol, side:t.side, pnl:0, fee:0, time:parseInt(t.execTime) };
              byOrder[t.orderId].trades.push(t);
              byOrder[t.orderId].pnl += parseFloat(t.closedPnl||0);
              byOrder[t.orderId].fee += parseFloat(t.execFee||0);
            });
            const bybitTrades = Object.values(byOrder).filter(o => o.pnl !== 0).map(o => ({
              exchangeSource: 'BYBIT', exchangeId: `bybit-${o.trades[0].orderId}`,
              ticker: o.symbol.replace('USDT',''), dir: o.side==='Buy'?'long':'short',
              exchange: 'BYBIT', type: 'futures',
              entry: parseFloat(o.trades[0]?.execPrice)||0,
              closePrice: parseFloat(o.trades[o.trades.length-1]?.execPrice)||0,
              pnl: Math.round((o.pnl-o.fee)*100)/100, fees: Math.round(o.fee*100)/100,
              posSize: parseFloat(o.trades[0]?.execValue)||0,
              status: 'closed',
              createdAt: new Date(o.time).toISOString(),
              closeDate: new Date(o.time).toISOString().split('T')[0],
              closeNotes: 'Importado de Bybit',
            }));
            trades.push(...bybitTrades);
            summary.push(`✅ BYBIT: ${bybitTrades.length} trades`);
          } else {
            summary.push(`⚠️ BYBIT: ${r.data?.retMsg || 'sin datos'}`);
          }
        } catch(e) { summary.push(`❌ BYBIT: ${e.message}`); }
      }

      // OKX history
      const okxKey  = (env.OKX_KEY || '').trim();
      const okxSec  = (env.OKX_SECRET || '').trim();
      const okxPass = (env.OKX_PASSPHRASE || '').trim();
      if (okxKey && okxSec && okxPass) {
        try {
          const okxHdr = async (path) => {
            const ts  = new Date().toISOString();
            const key2 = await crypto.subtle.importKey('raw', new TextEncoder().encode(okxSec), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
            const sig  = await crypto.subtle.sign('HMAC', key2, new TextEncoder().encode(ts+'GET'+path));
            const b64  = btoa(String.fromCharCode(...new Uint8Array(sig)));
            return { 'OK-ACCESS-KEY': okxKey, 'OK-ACCESS-SIGN': b64, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': okxPass, 'Content-Type': 'application/json' };
          };
          const path = `/api/v5/trade/fills-history?instType=SWAP&begin=${startTs}&end=${endTs}&limit=100`;
          const r    = await safeFetch(`https://www.okx.com${path}`, { headers: await okxHdr(path) });
          if (r.ok && r.data?.code === '0') {
            const byOrder = {};
            (r.data.data || []).forEach(t => {
              if(!byOrder[t.ordId]) byOrder[t.ordId] = { trades:[], instId:t.instId, side:t.side, pnl:0, fee:0, time:parseInt(t.ts) };
              byOrder[t.ordId].trades.push(t);
              byOrder[t.ordId].pnl += parseFloat(t.pnl||0);
              byOrder[t.ordId].fee += Math.abs(parseFloat(t.fee||0));
            });
            const okxTrades = Object.values(byOrder).filter(o => o.pnl !== 0).map(o => ({
              exchangeSource: 'OKX', exchangeId: `okx-${o.trades[0].tradeId}`,
              ticker: o.instId.replace('-USDT-SWAP','').replace('-',''), dir: o.side==='buy'?'long':'short',
              exchange: 'OKX', type: 'futures',
              entry: parseFloat(o.trades[0]?.fillPx)||0,
              closePrice: parseFloat(o.trades[o.trades.length-1]?.fillPx)||0,
              pnl: Math.round((o.pnl-o.fee)*100)/100, fees: Math.round(o.fee*100)/100,
              posSize: parseFloat(o.trades[0]?.fillNotionalUsd)||0,
              status: 'closed',
              createdAt: new Date(o.time).toISOString(),
              closeDate: new Date(o.time).toISOString().split('T')[0],
              closeNotes: 'Importado de OKX',
            }));
            trades.push(...okxTrades);
            summary.push(`✅ OKX: ${okxTrades.length} trades`);
          } else {
            summary.push(`⚠️ OKX: ${r.data?.msg || 'sin datos'}`);
          }
        } catch(e) { summary.push(`❌ OKX: ${e.message}`); }
      }

      return json({ trades, summary, total: trades.length });
    }

    // ── /position-history — fetch closed positions from exchanges ──────────────
    if (url.pathname === '/position-history') {
      const from = url.searchParams.get('from') || '2026-01-01';
      const to   = url.searchParams.get('to')   || new Date().toISOString().split('T')[0];
      const startTs = new Date(from).getTime();
      const endTs   = new Date(to).getTime() + 86400000;

      const trades  = [];
      const summary = [];

      // Bybit position history — max 7 days per request, so we chunk
      const bybitKey = (env.BYBIT_KEY || '').trim();
      const bybitSec = (env.BYBIT_SECRET || '').trim();
      if (bybitKey && bybitSec) {
        try {
          const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
          let bybitTotal = 0;
          let chunkStart = startTs;

          while (chunkStart < endTs) {
            const chunkEnd = Math.min(chunkStart + SEVEN_DAYS, endTs);
            const ts  = Date.now().toString();
            const q   = `category=linear&startTime=${chunkStart}&endTime=${chunkEnd}&limit=100`;
            const msg = ts + bybitKey + '5000' + q;
            const sig = await hmac256(bybitSec, msg);
            const r   = await safeFetch(
              `https://api.bybit.com/v5/position/closed-pnl?${q}`,
              { headers: { 'X-BAPI-API-KEY': bybitKey, 'X-BAPI-TIMESTAMP': ts,
                           'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': '5000' } }
            );
            if (r.ok && r.data?.retCode === 0) {
              const list = r.data.result?.list || [];
              bybitTotal += list.length;
              list.forEach(p => {
                const pnl  = parseFloat(p.closedPnl);
                const fees = Math.abs(parseFloat(p.cumExecFee || 0));
                trades.push({
                  exchangeSource: 'BYBIT',
                  exchangeId:     `bybit-pos-${p.symbol}-${p.orderId}`,
                  ticker:         p.symbol.replace('USDT',''),
                  dir:            p.side === 'Buy' ? 'long' : 'short',
                  exchange:       'BYBIT',
                  type:           'futures',
                  entry:          parseFloat(p.avgEntryPrice) || 0,
                  closePrice:     parseFloat(p.avgExitPrice)  || 0,
                  pnl:            Math.round((pnl - fees) * 100) / 100,
                  pnlRaw:         Math.round(pnl * 100) / 100,
                  fees:           Math.round(fees * 100) / 100,
                  posSize:        parseFloat(p.cumEntryValue) || 0,
                  leverage:       parseInt(p.leverage) || 1,
                  status:         'closed',
                  createdAt:      new Date(parseInt(p.createdTime)).toISOString(),
                  closeDate:      new Date(parseInt(p.updatedTime)).toISOString().split('T')[0],
                  closeNotes:     'Importado de Bybit (position history)',
                });
              });
            }
            chunkStart = chunkEnd + 1;
          }
          summary.push(`✅ BYBIT: ${bybitTotal} posiciones`);
        } catch(e) { summary.push(`❌ BYBIT: ${e.message}`); }
      }

      // OKX position history
      const okxKey  = (env.OKX_KEY || '').trim();
      const okxSec  = (env.OKX_SECRET || '').trim();
      const okxPass = (env.OKX_PASSPHRASE || '').trim();
      if (okxKey && okxSec && okxPass) {
        try {
          const okxHdr = async (path) => {
            const ts   = new Date().toISOString();
            const key2 = await crypto.subtle.importKey('raw', new TextEncoder().encode(okxSec),
              { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
            const sig  = await crypto.subtle.sign('HMAC', key2, new TextEncoder().encode(ts+'GET'+path));
            const b64  = btoa(String.fromCharCode(...new Uint8Array(sig)));
            return { 'OK-ACCESS-KEY': okxKey, 'OK-ACCESS-SIGN': b64,
                     'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': okxPass,
                     'Content-Type': 'application/json' };
          };
          // OKX closed positions
          const path = `/api/v5/account/positions-history?instType=SWAP&mgnMode=isolated&limit=100`;
          const r    = await safeFetch(`https://www.okx.com${path}`, { headers: await okxHdr(path) });
          if (r.ok && r.data?.code === '0') {
            const list = r.data.data || [];
            // Filter by date range
            const filtered = list.filter(p => {
              const t = parseInt(p.uTime);
              return t >= startTs && t <= endTs;
            });
            filtered.forEach(p => {
              const pnl  = parseFloat(p.realizedPnl);
              const fees = parseFloat(p.fee) || 0;
              const ticker = p.instId.replace('-USDT-SWAP','').replace('-','');
              trades.push({
                exchangeSource: 'OKX',
                exchangeId:     `okx-pos-${p.instId}-${p.uTime}`,
                ticker,
                dir:            parseFloat(p.pos) > 0 ? 'long' : 'short',
                exchange:       'OKX',
                type:           'futures',
                entry:          parseFloat(p.openAvgPx) || 0,
                closePrice:     parseFloat(p.closeAvgPx) || 0,
                pnl:            Math.round(pnl * 100) / 100,
                fees:           Math.round(Math.abs(fees) * 100) / 100,
                posSize:        parseFloat(p.notionalUsd) || 0,
                leverage:       parseInt(p.lever) || 1,
                status:         'closed',
                createdAt:      new Date(parseInt(p.cTime)).toISOString(),
                closeDate:      new Date(parseInt(p.uTime)).toISOString().split('T')[0],
                closeNotes:     'Importado de OKX (position history)',
              });
            });
            summary.push(`✅ OKX: ${filtered.length} posiciones`);
          } else {
            summary.push(`⚠️ OKX: ${r.data?.msg || 'sin datos'}`);
          }
        } catch(e) { summary.push(`❌ OKX: ${e.message}`); }
      }

      // Binance via Railway
      const railwayUrl = (env.RAILWAY_URL || '').trim();
      if (railwayUrl) {
        try {
          const r = await safeFetch(`${railwayUrl}/binance-position-history?from=${startTs}&to=${endTs}`);
          if (r.ok && r.data?.trades) {
            trades.push(...r.data.trades);
            summary.push(`✅ BINANCE: ${r.data.trades.length} posiciones`);
          } else {
            summary.push(`⚠️ BINANCE: ${r.data?.error || 'sin datos'}`);
          }
        } catch(e) { summary.push(`❌ BINANCE: ${e.message}`); }
      }

      return json({ trades, summary, total: trades.length });
    }

    // ── Legacy proxy (for AI analysis charts, Yahoo Finance) ─────────────────
    const targetUrl = url.searchParams.get('url');
    if (targetUrl) {
      const allowed = [
        'api.binance.com', 'fapi.binance.com',
        'query1.finance.yahoo.com', 'query2.finance.yahoo.com',
        'api.alternative.me',
        'contract.mexc.com',
      ];
      let targetDomain;
      try { targetDomain = new URL(targetUrl).hostname; } catch(e) {
        return json({ error: 'Invalid URL' }, 400);
      }
      if (!allowed.includes(targetDomain)) {
        return json({ error: 'Domain not allowed: ' + targetDomain }, 403);
      }
      const headers = {};
      for (const [k, v] of request.headers.entries()) {
        if (['host','connection','cf-connecting-ip','cf-ray','cf-visitor','cf-ipcountry'].includes(k.toLowerCase())) continue;
        headers[k] = v;
      }
      const r = await fetch(targetUrl, { method: request.method, headers });
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json', ...CORS }
      });
    }

    return json({ error: 'Not found', endpoints: ['/health','/summary','/positions','/orders','/sync','/myip'] }, 404);
  },

  // ── Cron trigger — runs every minute ─────────────────────────────────────
  async scheduled(event, env, ctx) {
    console.log('Cron sync starting...');
    const data = await syncAll(env);
    console.log(`Cron done: ${data.count.positions} positions, ${data.count.orders} orders`);
    if (data.errors.binance) console.error('Binance:', data.errors.binance);
    if (data.errors.bybit)   console.error('Bybit:',   data.errors.bybit);
    if (data.errors.okx)     console.error('OKX:',     data.errors.okx);
    if (data.errors.mexc)    console.error('MEXC:',    data.errors.mexc);
  },
};
