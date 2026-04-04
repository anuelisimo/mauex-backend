/**
 * MAUex Backend Server
 * Runs on Railway — syncs exchange data every 10s, exposes REST API to MAUex frontend
 * 
 * Environment variables needed in Railway:
 *   FIREBASE_PROJECT_ID      — your Firebase project ID (mauex-8a771)
 *   FIREBASE_CLIENT_EMAIL    — from Firebase service account JSON
 *   FIREBASE_PRIVATE_KEY     — from Firebase service account JSON (with \n)
 *   BINANCE_KEY              — Binance API Key (read-only)
 *   BINANCE_SECRET           — Binance API Secret
 *   BYBIT_KEY                — Bybit API Key (read-only)
 *   BYBIT_SECRET             — Bybit API Secret
 *   OKX_KEY                  — OKX API Key (read-only)
 *   OKX_SECRET               — OKX API Secret
 *   OKX_PASSPHRASE           — OKX Passphrase
 *   MEXC_KEY                 — MEXC API Key (read-only)
 *   MEXC_SECRET              — MEXC API Secret
 *   ALLOWED_ORIGIN           — your Vercel URL e.g. https://mauex.vercel.app
 *   PORT                     — set automatically by Railway
 */

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const fetch    = require('node-fetch');
const admin    = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-mauex-token'],
}));
app.use(express.json());

// ── Firebase Admin ────────────────────────────────────────────────────────
let db;
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
  db = admin.firestore();
  console.log('✅ Firebase connected');
} catch(e) {
  console.error('❌ Firebase init failed:', e.message);
}

// ── HMAC helper ──────────────────────────────────────────────────────────────
function hmac256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

// ── State ────────────────────────────────────────────────────────────────────
let state = {
  positions: [],   // all open positions from all exchanges
  orders:    [],   // all open orders from all exchanges
  lastSync:  null,
  errors:    {},
};

// ── BINANCE ──────────────────────────────────────────────────────────────────
async function syncBinance() {
  const key    = process.env.BINANCE_KEY;
  const secret = process.env.BINANCE_SECRET;
  if(!key || !secret) return { positions:[], orders:[] };

  const positions = [];
  const orders    = [];

  try {
    // Futures positions
    const ts1  = Date.now();
    const q1   = `timestamp=${ts1}`;
    const sig1 = hmac256(secret, q1);
    const r1   = await fetch(`https://fapi.binance.com/fapi/v2/positionRisk?${q1}&signature=${sig1}`, {
      headers: { 'X-MBX-APIKEY': key }
    });
    const posData = await r1.json();

    if(Array.isArray(posData)) {
      posData.filter(p => parseFloat(p.positionAmt) !== 0).forEach(p => {
        const size    = Math.abs(parseFloat(p.positionAmt));
        const entry   = parseFloat(p.entryPrice);
        const mark    = parseFloat(p.markPrice);
        const lev     = parseInt(p.leverage) || 1;
        const notional= parseFloat(p.notional) || size * mark;
        const pnl     = parseFloat(p.unRealizedProfit);
        const margin  = Math.abs(notional) / lev;
        const liqPrice= parseFloat(p.liquidationPrice) || 0;
        const dir     = parseFloat(p.positionAmt) > 0 ? 'long' : 'short';

        positions.push({
          exchange:    'BINANCE',
          type:        'futures',
          ticker:      p.symbol.replace('USDT', '').replace('BUSD', ''),
          symbol:      p.symbol,
          dir,
          entry,
          mark,
          pnl:         Math.round(pnl * 100) / 100,
          pnlPct:      Math.round(pnl / margin * 10000) / 100,
          posSize:     Math.abs(notional),
          margin:      Math.round(margin * 100) / 100,
          leverage:    lev,
          liquidation: liqPrice,
          sl:          null, // comes from stop orders
          tp1:         null,
          tp2:         null,
          tp3:         null,
          exchangeId:  `bnb-pos-${p.symbol}-${dir}`,
          openTime:    null,
        });
      });
    }

    // Futures open orders (includes SL and TP orders)
    const ts2  = Date.now();
    const q2   = `timestamp=${ts2}`;
    const sig2 = hmac256(secret, q2);
    const r2   = await fetch(`https://fapi.binance.com/fapi/v1/openOrders?${q2}&signature=${sig2}`, {
      headers: { 'X-MBX-APIKEY': key }
    });
    const ordData = await r2.json();

    if(Array.isArray(ordData)) {
      // Match stop orders to positions
      ordData.forEach(o => {
        const type     = o.type; // STOP_MARKET, TAKE_PROFIT_MARKET, LIMIT, etc
        const symbol   = o.symbol;
        const price    = parseFloat(o.stopPrice) || parseFloat(o.price) || 0;
        const ticker   = symbol.replace('USDT','').replace('BUSD','');
        const dir      = o.side === 'BUY' ? 'long' : 'short';
        const isStop   = type.includes('STOP');
        const isTP     = type.includes('TAKE_PROFIT');
        const isLimit  = type === 'LIMIT';

        // Attach SL/TP to position
        const pos = positions.find(p => p.symbol === symbol);
        if(pos && isStop)  { pos.sl  = pos.sl  || price; }
        if(pos && isTP)    {
          if(!pos.tp1)       pos.tp1 = price;
          else if(!pos.tp2)  pos.tp2 = price;
          else if(!pos.tp3)  pos.tp3 = price;
        }

        // Also add as standalone order
        if(isLimit || (!pos && (isStop || isTP))) {
          orders.push({
            exchange:   'BINANCE',
            type:       type,
            ticker,
            symbol,
            dir,
            price,
            origQty:    parseFloat(o.origQty),
            size:       parseFloat(o.origQty) * price,
            status:     'OPEN',
            orderId:    String(o.orderId),
            exchangeId: `bnb-ord-${o.orderId}`,
          });
        }
      });
    }

    state.errors.binance = null;
  } catch(e) {
    state.errors.binance = e.message;
    console.error('Binance sync error:', e.message);
  }

  return { positions, orders };
}

// ── BYBIT ─────────────────────────────────────────────────────────────────────
async function syncBybit() {
  const key    = process.env.BYBIT_KEY;
  const secret = process.env.BYBIT_SECRET;
  if(!key || !secret) return { positions:[], orders:[] };

  const positions = [];
  const orders    = [];

  try {
    // Futures positions
    const ts1  = Date.now().toString();
    const q1   = 'category=linear&settleCoin=USDT';
    const msg1 = ts1 + key + '5000' + q1;
    const sig1 = hmac256(secret, msg1);
    const r1   = await fetch(`https://api.bybit.com/v5/position/list?${q1}`, {
      headers: {
        'X-BAPI-API-KEY':      key,
        'X-BAPI-TIMESTAMP':    ts1,
        'X-BAPI-SIGN':         sig1,
        'X-BAPI-RECV-WINDOW':  '5000',
      }
    });
    const posData = await r1.json();

    if(posData.retCode === 0 && posData.result?.list) {
      posData.result.list.filter(p => parseFloat(p.size) > 0).forEach(p => {
        const entry    = parseFloat(p.avgPrice);
        const mark     = parseFloat(p.markPrice);
        const lev      = parseInt(p.leverage) || 1;
        const notional = parseFloat(p.positionValue) || 0;
        const pnl      = parseFloat(p.unrealisedPnl);
        const margin   = notional / lev;
        const liqPrice = parseFloat(p.liqPrice) || 0;
        const dir      = p.side === 'Buy' ? 'long' : 'short';

        positions.push({
          exchange:    'BYBIT',
          type:        'futures',
          ticker:      p.symbol.replace('USDT', ''),
          symbol:      p.symbol,
          dir,
          entry,
          mark,
          pnl:         Math.round(pnl * 100) / 100,
          pnlPct:      Math.round(pnl / margin * 10000) / 100,
          posSize:     notional,
          margin:      Math.round(margin * 100) / 100,
          leverage:    lev,
          liquidation: liqPrice,
          sl:          parseFloat(p.stopLoss) || null,
          tp1:         parseFloat(p.takeProfit) || null,
          tp2:         null,
          tp3:         null,
          exchangeId:  `bybit-pos-${p.symbol}-${dir}`,
          openTime:    parseInt(p.createdTime) || null,
        });
      });
    }

    // Open orders
    const ts2  = Date.now().toString();
    const q2   = 'category=linear&settleCoin=USDT';
    const msg2 = ts2 + key + '5000' + q2;
    const sig2 = hmac256(secret, msg2);
    const r2   = await fetch(`https://api.bybit.com/v5/order/realtime?${q2}`, {
      headers: {
        'X-BAPI-API-KEY':     key,
        'X-BAPI-TIMESTAMP':   ts2,
        'X-BAPI-SIGN':        sig2,
        'X-BAPI-RECV-WINDOW': '5000',
      }
    });
    const ordData = await r2.json();

    if(ordData.retCode === 0 && ordData.result?.list) {
      ordData.result.list.forEach(o => {
        orders.push({
          exchange:   'BYBIT',
          type:       o.orderType,
          ticker:     o.symbol.replace('USDT', ''),
          symbol:     o.symbol,
          dir:        o.side === 'Buy' ? 'long' : 'short',
          price:      parseFloat(o.price) || parseFloat(o.triggerPrice) || 0,
          origQty:    parseFloat(o.qty),
          size:       parseFloat(o.qty) * (parseFloat(o.price) || 0),
          status:     'OPEN',
          orderId:    o.orderId,
          exchangeId: `bybit-ord-${o.orderId}`,
        });
      });
    }

    state.errors.bybit = null;
  } catch(e) {
    state.errors.bybit = e.message;
    console.error('Bybit sync error:', e.message);
  }

  return { positions, orders };
}

// ── OKX ──────────────────────────────────────────────────────────────────────
async function syncOKX() {
  const key        = process.env.OKX_KEY;
  const secret     = process.env.OKX_SECRET;
  const passphrase = process.env.OKX_PASSPHRASE;
  if(!key || !secret || !passphrase) return { positions:[], orders:[] };

  const positions = [];
  const orders    = [];

  const okxSign = (timestamp, method, path) => {
    const msg = timestamp + method + path;
    return crypto.createHmac('sha256', secret).update(msg).digest('base64');
  };
  const okxHeaders = (path, method='GET') => {
    const ts = new Date().toISOString();
    return {
      'OK-ACCESS-KEY':        key,
      'OK-ACCESS-SIGN':       okxSign(ts, method, path),
      'OK-ACCESS-TIMESTAMP':  ts,
      'OK-ACCESS-PASSPHRASE': passphrase,
      'Content-Type':         'application/json',
    };
  };

  try {
    // Futures positions
    const path1 = '/api/v5/account/positions?instType=SWAP';
    const r1    = await fetch(`https://www.okx.com${path1}`, { headers: okxHeaders(path1) });
    const posData = await r1.json();

    if(posData.code === '0' && posData.data) {
      posData.data.filter(p => parseFloat(p.pos) !== 0).forEach(p => {
        const entry    = parseFloat(p.avgPx);
        const mark     = parseFloat(p.markPx);
        const lev      = parseInt(p.lever) || 1;
        const notional = Math.abs(parseFloat(p.notionalUsd)) || 0;
        const pnl      = parseFloat(p.upl);
        const margin   = parseFloat(p.margin) || notional / lev;
        const liqPrice = parseFloat(p.liqPx) || 0;
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
          pnlPct:      Math.round(pnl / margin * 10000) / 100,
          posSize:     notional,
          margin:      Math.round(margin * 100) / 100,
          leverage:    lev,
          liquidation: liqPrice,
          sl:          null,
          tp1:         null,
          tp2:         null,
          tp3:         null,
          exchangeId:  `okx-pos-${p.instId}-${dir}`,
          openTime:    parseInt(p.cTime) || null,
        });
      });
    }

    // Open orders
    const path2   = '/api/v5/trade/orders-pending?instType=SWAP';
    const r2      = await fetch(`https://www.okx.com${path2}`, { headers: okxHeaders(path2) });
    const ordData = await r2.json();

    if(ordData.code === '0' && ordData.data) {
      ordData.data.forEach(o => {
        const ticker = o.instId.replace('-USDT-SWAP','').replace('-','');
        orders.push({
          exchange:   'OKX',
          type:       o.ordType,
          ticker,
          symbol:     o.instId,
          dir:        o.side === 'buy' ? 'long' : 'short',
          price:      parseFloat(o.px) || parseFloat(o.slTriggerPx) || 0,
          origQty:    parseFloat(o.sz),
          size:       parseFloat(o.sz) * (parseFloat(o.px) || 0),
          status:     'OPEN',
          orderId:    o.ordId,
          exchangeId: `okx-ord-${o.ordId}`,
        });
      });
    }

    state.errors.okx = null;
  } catch(e) {
    state.errors.okx = e.message;
    console.error('OKX sync error:', e.message);
  }

  return { positions, orders };
}

// ── MEXC ─────────────────────────────────────────────────────────────────────
async function syncMEXC() {
  const key    = process.env.MEXC_KEY;
  const secret = process.env.MEXC_SECRET;
  if(!key || !secret) return { positions:[], orders:[] };

  const positions = [];
  const orders    = [];

  try {
    const ts  = Date.now().toString();
    const sig = hmac256(secret, key + ts);

    const r1 = await fetch('https://contract.mexc.com/api/v1/private/position/open_positions', {
      headers: {
        'ApiKey':       key,
        'Request-Time': ts,
        'Signature':    sig,
        'Content-Type': 'application/json',
      }
    });
    const posData = await r1.json();

    if(posData.success && posData.data) {
      posData.data.forEach(p => {
        const entry    = parseFloat(p.openAvgPrice) || 0;
        const mark     = parseFloat(p.markPrice) || entry;
        const lev      = parseInt(p.leverage) || 1;
        const notional = parseFloat(p.positionValue) || 0;
        const pnl      = parseFloat(p.unrealisedPnl) || 0;
        const margin   = notional / lev;
        const liqPrice = parseFloat(p.liquidatePrice) || 0;
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
          pnlPct:      Math.round(pnl / (margin || 1) * 10000) / 100,
          posSize:     notional,
          margin:      Math.round(margin * 100) / 100,
          leverage:    lev,
          liquidation: liqPrice,
          sl:          parseFloat(p.stopLossPrice) || null,
          tp1:         parseFloat(p.takeProfitPrice) || null,
          tp2:         null,
          tp3:         null,
          exchangeId:  `mexc-pos-${p.symbol}-${dir}`,
          openTime:    parseInt(p.openTime) || null,
        });
      });
    }

    state.errors.mexc = null;
  } catch(e) {
    state.errors.mexc = e.message;
    console.error('MEXC sync error:', e.message);
  }

  return { positions, orders };
}

// ── MAIN SYNC LOOP ────────────────────────────────────────────────────────────
async function syncAll() {
  console.log(`[${new Date().toISOString()}] Syncing exchanges...`);
  try {
    const [bnb, bybit, okx, mexc] = await Promise.all([
      syncBinance(), syncBybit(), syncOKX(), syncMEXC()
    ]);

    state.positions = [...bnb.positions, ...bybit.positions, ...okx.positions, ...mexc.positions];
    state.orders    = [...bnb.orders,    ...bybit.orders,    ...okx.orders,    ...mexc.orders];
    state.lastSync  = new Date().toISOString();

    console.log(`✅ Sync done: ${state.positions.length} positions, ${state.orders.length} orders`);

    // Save to Firestore (optional — for persistence)
    if(db) {
      const ref = db.collection('sync').doc('latest');
      await ref.set({
        positions: state.positions,
        orders:    state.orders,
        lastSync:  state.lastSync,
        errors:    state.errors,
      });
    }
  } catch(e) {
    console.error('Sync error:', e.message);
  }
}

// Sync every 10 seconds
setInterval(syncAll, 10000);
syncAll(); // Run immediately on startup

// ── REST API ──────────────────────────────────────────────────────────────────

// Show server's outbound IP (useful for Binance IP whitelist)
app.get('/myip', async (req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const d = await r.json();
    res.json({ ip: d.ip, note: 'Add this IP to Binance API whitelist to enable Futures' });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    lastSync: state.lastSync,
    positions: state.positions.length,
    orders: state.orders.length,
    errors: state.errors,
  });
});

// Get all positions
app.get('/positions', (req, res) => {
  res.json({
    positions: state.positions,
    lastSync:  state.lastSync,
    errors:    state.errors,
  });
});

// Get all orders
app.get('/orders', (req, res) => {
  res.json({
    orders:   state.orders,
    lastSync: state.lastSync,
  });
});

// Get positions + orders + status in one call
app.get('/summary', (req, res) => {
  const totalPnl = state.positions.reduce((s, p) => s + (p.pnl || 0), 0);
  res.json({
    positions:  state.positions,
    orders:     state.orders,
    lastSync:   state.lastSync,
    errors:     state.errors,
    totalPnl:   Math.round(totalPnl * 100) / 100,
    count: {
      positions: state.positions.length,
      orders:    state.orders.length,
    }
  });
});

// Get closed trade history for a date range
app.get('/history', async (req, res) => {
  const { from, to, exchange } = req.query;
  // This endpoint fetches fresh from exchanges
  // TODO: implement per-exchange history fetch
  res.json({ message: 'Use /import-history endpoint', trades: [] });
});

app.listen(PORT, () => {
  console.log(`🚀 MAUex backend running on port ${PORT}`);
  console.log(`   Exchanges configured: ${[
    process.env.BINANCE_KEY ? 'Binance' : null,
    process.env.BYBIT_KEY   ? 'Bybit'   : null,
    process.env.OKX_KEY     ? 'OKX'     : null,
    process.env.MEXC_KEY    ? 'MEXC'    : null,
  ].filter(Boolean).join(', ') || 'none'}`);
});
