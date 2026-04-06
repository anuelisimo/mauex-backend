/**
 * MAUex Backend Server v2
 * Runs on Railway — syncs exchange data every 10s
 * 
 * Environment variables:
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *   BINANCE_KEY, BINANCE_SECRET
 *   BYBIT_KEY, BYBIT_SECRET
 *   OKX_KEY, OKX_SECRET, OKX_PASSPHRASE
 *   MEXC_KEY, MEXC_SECRET
 *   ALLOWED_ORIGIN (e.g. https://mauex.vercel.app)
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fetch   = require('node-fetch');
const admin   = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Firebase ──────────────────────────────────────────────────────────────────
let db = null;
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
  db = admin.firestore();
  console.log('✅ Firebase connected');
} catch(e) {
  console.warn('⚠️ Firebase not configured:', e.message);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const hmac256 = (secret, msg) =>
  crypto.createHmac('sha256', secret).update(msg).digest('hex');

const safeFetch = async (url, opts={}) => {
  const r = await fetch(url, { timeout: 10000, ...opts });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch(e) { return { ok: false, status: r.status, data: null, raw: text.slice(0, 200) }; }
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  positions: [],
  orders:    [],
  lastSync:  null,
  errors:    {},
};

// ═════════════════════════════════════════════════════════════════════════════
// BINANCE
// ═════════════════════════════════════════════════════════════════════════════
async function syncBinance() {
  const key = process.env.BINANCE_KEY;
  const sec = process.env.BINANCE_SECRET;
  if(!key || !sec) return { positions:[], orders:[] };

  const positions = [];
  const orders    = [];

  try {
    // ── Check position mode (one-way vs hedge) ──────────────────────────────
    const ts0  = Date.now();
    const q0   = `timestamp=${ts0}`;
    const r0   = await safeFetch(
      `https://fapi.binance.com/fapi/v1/positionSide/dual?${q0}&signature=${hmac256(sec,q0)}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );
    const isHedge = r0.data?.dualSidePosition === true;
    console.log(`Binance mode: ${isHedge ? 'HEDGE' : 'ONE-WAY'}`);

    // ── Futures positions ────────────────────────────────────────────────────
    const ts1  = Date.now();
    const q1   = `timestamp=${ts1}`;
    const r1   = await safeFetch(
      `https://fapi.binance.com/fapi/v2/positionRisk?${q1}&signature=${hmac256(sec,q1)}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    if(!r1.ok || !Array.isArray(r1.data)) {
      throw new Error(`positionRisk failed: ${r1.status} ${r1.raw||JSON.stringify(r1.data)}`);
    }

    // In hedge mode, filter by positionAmt != 0 OR by notional != 0
    const openPos = r1.data.filter(p => {
      const amt      = Math.abs(parseFloat(p.positionAmt));
      const notional = Math.abs(parseFloat(p.notional||0));
      return amt > 0 || notional > 0.01;
    });

    console.log(`Binance: ${r1.data.length} total, ${openPos.length} open positions`);

    openPos.forEach(p => {
      const amt      = parseFloat(p.positionAmt);
      const entry    = parseFloat(p.entryPrice);
      const mark     = parseFloat(p.markPrice);
      const lev      = parseInt(p.leverage) || 1;
      const notional = Math.abs(parseFloat(p.notional) || parseFloat(p.positionAmt) * mark);
      const pnl      = parseFloat(p.unRealizedProfit);
      const margin   = notional / lev;
      const liq      = parseFloat(p.liquidationPrice) || 0;

      // In hedge mode, positionSide tells us LONG/SHORT
      // In one-way mode, positive amt = long, negative = short
      let dir;
      if(isHedge) {
        dir = p.positionSide === 'LONG' ? 'long' : 'short';
      } else {
        dir = amt >= 0 ? 'long' : 'short';
      }

      positions.push({
        exchange:    'BINANCE',
        type:        'futures',
        ticker:      p.symbol.replace('USDT','').replace('BUSD',''),
        symbol:      p.symbol,
        dir,
        entry,
        mark,
        pnl:         Math.round(pnl * 100) / 100,
        pnlPct:      margin > 0 ? Math.round(pnl / margin * 10000) / 100 : 0,
        posSize:     Math.round(notional * 100) / 100,
        margin:      Math.round(margin * 100) / 100,
        leverage:    lev,
        liquidation: liq,
        sl:          null,
        tp1:         null,
        tp2:         null,
        tp3:         null,
        exchangeId:  `bnb-pos-${p.symbol}-${dir}`,
      });
    });

    // ── Open orders (to get SL/TP attached to positions) ─────────────────────
    const ts2  = Date.now();
    const q2   = `timestamp=${ts2}`;
    const r2   = await safeFetch(
      `https://fapi.binance.com/fapi/v1/openOrders?${q2}&signature=${hmac256(sec,q2)}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    if(r2.ok && Array.isArray(r2.data)) {
      console.log(`Binance: ${r2.data.length} open orders`);
      r2.data.forEach(o => {
        const price  = parseFloat(o.stopPrice) || parseFloat(o.price) || 0;
        const type   = o.type || '';
        const ticker = o.symbol.replace('USDT','').replace('BUSD','');
        const dir    = o.side === 'BUY' ? 'long' : 'short';
        const isStop = type.includes('STOP');
        const isTP   = type.includes('TAKE_PROFIT');
        const isLim  = type === 'LIMIT';

        // Attach SL/TP to matching position
        const pos = positions.find(p =>
          p.symbol === o.symbol &&
          (isHedge ? p.dir === (o.positionSide==='LONG'?'long':'short') : true)
        );
        if(pos) {
          if(isStop && !pos.sl)   pos.sl  = price;
          if(isTP)  {
            if(!pos.tp1)      pos.tp1 = price;
            else if(!pos.tp2) pos.tp2 = price;
            else if(!pos.tp3) pos.tp3 = price;
          }
        }

        // Standalone limit orders
        if(isLim) {
          orders.push({
            exchange:   'BINANCE',
            type,
            ticker,
            symbol:     o.symbol,
            dir,
            price,
            origQty:    parseFloat(o.origQty),
            size:       parseFloat(o.origQty) * price,
            status:     'OPEN',
            exchangeId: `bnb-ord-${o.orderId}`,
          });
        }
      });
    }

    state.errors.binance = null;
  } catch(e) {
    state.errors.binance = e.message;
    console.error('❌ Binance:', e.message);
  }

  return { positions, orders };
}

// ═════════════════════════════════════════════════════════════════════════════
// BYBIT
// ═════════════════════════════════════════════════════════════════════════════
async function syncBybit() {
  const key = process.env.BYBIT_KEY;
  const sec = process.env.BYBIT_SECRET;
  if(!key || !sec) return { positions:[], orders:[] };

  const positions = [];
  const orders    = [];

  const bybitHeaders = (q) => {
    const ts  = Date.now().toString();
    const msg = ts + key + '5000' + q;
    return {
      'X-BAPI-API-KEY':     key,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-SIGN':        hmac256(sec, msg),
      'X-BAPI-RECV-WINDOW': '5000',
    };
  };

  try {
    const q1 = 'category=linear&settleCoin=USDT';
    const r1 = await safeFetch(
      `https://api.bybit.com/v5/position/list?${q1}`,
      { headers: bybitHeaders(q1) }
    );

    if(!r1.ok || !r1.data) {
      throw new Error(`Bybit positions: ${r1.status} ${r1.raw||'no data'}`);
    }
    if(r1.data.retCode !== 0) {
      throw new Error(`Bybit API error: ${r1.data.retCode} ${r1.data.retMsg}`);
    }

    const list = r1.data.result?.list || [];
    console.log(`Bybit: ${list.length} positions (${list.filter(p=>parseFloat(p.size)>0).length} open)`);

    list.filter(p => parseFloat(p.size) > 0).forEach(p => {
      const entry    = parseFloat(p.avgPrice);
      const mark     = parseFloat(p.markPrice);
      const lev      = parseInt(p.leverage) || 1;
      const notional = parseFloat(p.positionValue) || 0;
      const pnl      = parseFloat(p.unrealisedPnl);
      const margin   = notional / lev;
      const liq      = parseFloat(p.liqPrice) || 0;
      const dir      = p.side === 'Buy' ? 'long' : 'short';

      positions.push({
        exchange:    'BYBIT',
        type:        'futures',
        ticker:      p.symbol.replace('USDT',''),
        symbol:      p.symbol,
        dir,
        entry,
        mark,
        pnl:         Math.round(pnl * 100) / 100,
        pnlPct:      margin > 0 ? Math.round(pnl / margin * 10000) / 100 : 0,
        posSize:     Math.round(notional * 100) / 100,
        margin:      Math.round(margin * 100) / 100,
        leverage:    lev,
        liquidation: liq,
        sl:          parseFloat(p.stopLoss) || null,
        tp1:         parseFloat(p.takeProfit) || null,
        tp2:         null,
        tp3:         null,
        exchangeId:  `bybit-pos-${p.symbol}-${dir}`,
        openTime:    parseInt(p.createdTime) || null,
      });
    });

    // Open orders
    const q2 = 'category=linear&settleCoin=USDT';
    const r2 = await safeFetch(
      `https://api.bybit.com/v5/order/realtime?${q2}`,
      { headers: bybitHeaders(q2) }
    );

    if(r2.ok && r2.data?.retCode === 0) {
      (r2.data.result?.list || []).forEach(o => {
        orders.push({
          exchange:   'BYBIT',
          type:       o.orderType,
          ticker:     o.symbol.replace('USDT',''),
          symbol:     o.symbol,
          dir:        o.side === 'Buy' ? 'long' : 'short',
          price:      parseFloat(o.price) || parseFloat(o.triggerPrice) || 0,
          origQty:    parseFloat(o.qty),
          size:       parseFloat(o.qty) * (parseFloat(o.price)||0),
          status:     'OPEN',
          exchangeId: `bybit-ord-${o.orderId}`,
        });
      });
    }

    state.errors.bybit = null;
  } catch(e) {
    state.errors.bybit = e.message;
    console.error('❌ Bybit:', e.message);
  }

  return { positions, orders };
}

// ═════════════════════════════════════════════════════════════════════════════
// OKX
// ═════════════════════════════════════════════════════════════════════════════
async function syncOKX() {
  const key  = process.env.OKX_KEY;
  const sec  = process.env.OKX_SECRET;
  const pass = process.env.OKX_PASSPHRASE;
  if(!key || !sec || !pass) return { positions:[], orders:[] };

  const positions = [];
  const orders    = [];

  const okxHdr = (path, method='GET') => {
    const ts  = new Date().toISOString();
    const sig = crypto.createHmac('sha256', sec).update(ts+method+path).digest('base64');
    return {
      'OK-ACCESS-KEY':        key,
      'OK-ACCESS-SIGN':       sig,
      'OK-ACCESS-TIMESTAMP':  ts,
      'OK-ACCESS-PASSPHRASE': pass,
      'Content-Type':         'application/json',
    };
  };

  try {
    const path1 = '/api/v5/account/positions?instType=SWAP';
    const r1    = await safeFetch(`https://www.okx.com${path1}`, { headers: okxHdr(path1) });

    if(!r1.ok || !r1.data) throw new Error(`OKX positions: ${r1.status}`);
    if(r1.data.code !== '0') throw new Error(`OKX error: ${r1.data.code} ${r1.data.msg}`);

    const list = r1.data.data || [];
    console.log(`OKX: ${list.length} positions`);

    list.filter(p => parseFloat(p.pos) !== 0).forEach(p => {
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
        exchange:    'OKX',
        type:        'futures',
        ticker,
        symbol:      p.instId,
        dir,
        entry,
        mark,
        pnl:         Math.round(pnl * 100) / 100,
        pnlPct:      margin > 0 ? Math.round(pnl / margin * 10000) / 100 : 0,
        posSize:     Math.round(notional * 100) / 100,
        margin:      Math.round(margin * 100) / 100,
        leverage:    lev,
        liquidation: liq,
        sl:          null,
        tp1:         null,
        tp2:         null,
        tp3:         null,
        exchangeId:  `okx-pos-${p.instId}-${dir}`,
      });
    });

    // Open orders
    const path2 = '/api/v5/trade/orders-pending?instType=SWAP';
    const r2    = await safeFetch(`https://www.okx.com${path2}`, { headers: okxHdr(path2) });
    if(r2.ok && r2.data?.code === '0') {
      (r2.data.data || []).forEach(o => {
        const ticker = o.instId.replace('-USDT-SWAP','').replace('-','');
        orders.push({
          exchange:   'OKX',
          type:       o.ordType,
          ticker,
          symbol:     o.instId,
          dir:        o.side === 'buy' ? 'long' : 'short',
          price:      parseFloat(o.px) || 0,
          origQty:    parseFloat(o.sz),
          size:       parseFloat(o.sz) * (parseFloat(o.px)||0),
          status:     'OPEN',
          exchangeId: `okx-ord-${o.ordId}`,
        });
      });
    }

    state.errors.okx = null;
  } catch(e) {
    state.errors.okx = e.message;
    console.error('❌ OKX:', e.message);
  }

  return { positions, orders };
}

// ═════════════════════════════════════════════════════════════════════════════
// MEXC
// ═════════════════════════════════════════════════════════════════════════════
async function syncMEXC() {
  const key = process.env.MEXC_KEY;
  const sec = process.env.MEXC_SECRET;
  if(!key || !sec) return { positions:[], orders:[] };

  const positions = [];
  const orders    = [];

  try {
    const ts  = Date.now().toString();
    const sig = hmac256(sec, key + ts);

    const r1 = await safeFetch(
      'https://contract.mexc.com/api/v1/private/position/open_positions',
      { headers: { 'ApiKey': key, 'Request-Time': ts, 'Signature': sig, 'Content-Type': 'application/json' } }
    );

    if(!r1.ok || !r1.data) throw new Error(`MEXC positions: ${r1.status} ${r1.raw||''}`);
    if(!r1.data.success) throw new Error(`MEXC error: ${r1.data.code} ${r1.data.message}`);

    const list = r1.data.data || [];
    console.log(`MEXC: ${list.length} positions`);

    list.forEach(p => {
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
        exchange:    'MEXC',
        type:        'futures',
        ticker,
        symbol:      p.symbol,
        dir,
        entry,
        mark,
        pnl:         Math.round(pnl * 100) / 100,
        pnlPct:      margin > 0 ? Math.round(pnl / margin * 10000) / 100 : 0,
        posSize:     Math.round(notional * 100) / 100,
        margin:      Math.round(margin * 100) / 100,
        leverage:    lev,
        liquidation: liq,
        sl:          parseFloat(p.stopLossPrice) || null,
        tp1:         parseFloat(p.takeProfitPrice) || null,
        tp2:         null,
        tp3:         null,
        exchangeId:  `mexc-pos-${p.symbol}-${dir}`,
      });
    });

    state.errors.mexc = null;
  } catch(e) {
    state.errors.mexc = e.message;
    console.error('❌ MEXC:', e.message);
  }

  return { positions, orders };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN SYNC
// ═════════════════════════════════════════════════════════════════════════════
async function syncAll() {
  console.log(`[${new Date().toISOString()}] Syncing...`);
  try {
    const [bnb, bybit, okx, mexc] = await Promise.all([
      syncBinance(), syncBybit(), syncOKX(), syncMEXC()
    ]);

    state.positions = [...bnb.positions, ...bybit.positions, ...okx.positions, ...mexc.positions];
    state.orders    = [...bnb.orders,    ...bybit.orders,    ...okx.orders,    ...mexc.orders];
    state.lastSync  = new Date().toISOString();

    console.log(`✅ ${state.positions.length} positions, ${state.orders.length} orders`);

    // Save to Firestore
    if(db) {
      await db.collection('sync').doc('latest').set({
        positions: state.positions,
        orders:    state.orders,
        lastSync:  state.lastSync,
        errors:    state.errors,
      }).catch(e => console.warn('Firestore write error:', e.message));
    }
  } catch(e) {
    console.error('Sync error:', e.message);
  }
}

// Sync every 10 seconds
setInterval(syncAll, 10000);
syncAll();

// ═════════════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({
  status:    'ok',
  lastSync:  state.lastSync,
  positions: state.positions.length,
  orders:    state.orders.length,
  errors:    state.errors,
}));

app.get('/myip', async (req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const d = await r.json();
    res.json({ ip: d.ip, note: 'Add this IP to Binance API whitelist' });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/positions', (req, res) => res.json({
  positions: state.positions,
  lastSync:  state.lastSync,
  errors:    state.errors,
}));

app.get('/orders', (req, res) => res.json({
  orders:   state.orders,
  lastSync: state.lastSync,
}));

app.get('/summary', (req, res) => {
  const totalPnl = state.positions.reduce((s,p) => s + (p.pnl||0), 0);
  res.json({
    positions:  state.positions,
    orders:     state.orders,
    lastSync:   state.lastSync,
    errors:     state.errors,
    totalPnl:   Math.round(totalPnl * 100) / 100,
    count: {
      positions: state.positions.length,
      orders:    state.orders.length,
    },
  });
});

app.listen(PORT, () => {
  console.log(`🚀 MAUex backend v2 on port ${PORT}`);
  console.log('   Exchanges:', [
    process.env.BINANCE_KEY ? 'Binance' : null,
    process.env.BYBIT_KEY   ? 'Bybit'   : null,
    process.env.OKX_KEY     ? 'OKX'     : null,
    process.env.MEXC_KEY    ? 'MEXC'    : null,
  ].filter(Boolean).join(', ') || 'none');
});
