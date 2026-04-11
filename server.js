/**
 * MAUex Railway Server — Binance only
 * IP: 54.176.137.56 (whitelisted in Binance)
 * 
 * Environment variables in Railway:
 *   BINANCE_KEY, BINANCE_SECRET, PORT
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const hmac256 = (secret, msg) =>
  crypto.createHmac('sha256', secret).update(msg).digest('hex');

const safeFetch = async (url, opts = {}) => {
  try {
    const r    = await fetch(url, { timeout: 10000, ...opts });
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
    catch(e) { return { ok: false, status: r.status, data: null, raw: text.slice(0,300) }; }
  } catch(e) {
    return { ok: false, status: 0, data: null, raw: e.message };
  }
};

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  positions: [],
  orders:    [],
  lastSync:  null,
  error:     null,
};

// ── Binance sync ──────────────────────────────────────────────────────────────
async function syncBinance() {
  const key = (process.env.BINANCE_KEY    || '').trim();
  const sec = (process.env.BINANCE_SECRET || '').trim();
  if (!key || !sec) { state.error = 'No keys'; return; }

  const positions = [];
  const orders    = [];

  try {
    // Detect hedge mode
    const ts0 = Date.now();
    const q0  = `timestamp=${ts0}`;
    const r0  = await safeFetch(
      `https://fapi.binance.com/fapi/v1/positionSide/dual?${q0}&signature=${hmac256(sec,q0)}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );
    const isHedge = r0.data?.dualSidePosition === true;
    console.log(`Binance mode: ${isHedge ? 'HEDGE' : 'ONE-WAY'}`);

    // Positions
    const ts1 = Date.now();
    const q1  = `timestamp=${ts1}`;
    const r1  = await safeFetch(
      `https://fapi.binance.com/fapi/v2/positionRisk?${q1}&signature=${hmac256(sec,q1)}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    if (!r1.ok || !Array.isArray(r1.data)) {
      throw new Error(`positionRisk: ${r1.status} ${r1.raw || JSON.stringify(r1.data)}`);
    }

    const open = r1.data.filter(p =>
      Math.abs(parseFloat(p.positionAmt)) > 0 ||
      Math.abs(parseFloat(p.notional || 0)) > 0.01
    );
    console.log(`Binance: ${r1.data.length} total, ${open.length} open`);

    for (const p of open) {
      const amt      = parseFloat(p.positionAmt);
      const entry    = parseFloat(p.entryPrice);
      const mark     = parseFloat(p.markPrice);
      const lev      = parseInt(p.leverage) || 1;
      const notional = Math.abs(parseFloat(p.notional) || Math.abs(amt) * mark);
      const pnl      = parseFloat(p.unRealizedProfit);
      const margin   = notional / lev;
      const liq      = parseFloat(p.liquidationPrice) || 0;
      const dir      = isHedge
        ? (p.positionSide === 'LONG' ? 'long' : 'short')
        : (amt >= 0 ? 'long' : 'short');

      positions.push({
        exchange: 'BINANCE', type: 'futures',
        ticker:      p.symbol.replace('USDT','').replace('BUSD',''),
        symbol:      p.symbol, dir, entry, mark,
        pnl:         Math.round(pnl * 100) / 100,
        pnlPct:      margin > 0 ? Math.round(pnl / margin * 10000) / 100 : 0,
        posSize:     Math.round(notional * 100) / 100,
        margin:      Math.round(margin * 100) / 100,
        leverage:    lev, liquidation: liq,
        sl: null, tp1: null, tp2: null, tp3: null,
        exchangeId: `bnb-pos-${p.symbol}-${dir}`,
      });
    }

    // Open orders → attach SL/TP
    const ts2 = Date.now();
    const q2  = `timestamp=${ts2}`;
    const r2  = await safeFetch(
      `https://fapi.binance.com/fapi/v1/openOrders?${q2}&signature=${hmac256(sec,q2)}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    if (r2.ok && Array.isArray(r2.data)) {
      for (const o of r2.data) {
        const price  = parseFloat(o.stopPrice) || parseFloat(o.price) || 0;
        const type   = o.type || '';
        const isStop = type.includes('STOP');
        const isTP   = type.includes('TAKE_PROFIT');
        const isLim  = type === 'LIMIT';
        const oDir   = isHedge
          ? (o.positionSide === 'LONG' ? 'long' : 'short')
          : (o.side === 'BUY' ? 'long' : 'short');

        // In one-way mode: STOP/TP orders have OPPOSITE side to close the position
        // e.g. SHORT position closed by BUY stop order
        // Match by symbol; for hedge mode also match direction
        let pos;
        if (isHedge) {
          pos = positions.find(p => p.symbol === o.symbol && p.dir === oDir);
        } else {
          // One-way: stop/tp orders are for closing, so opposite side
          const closingDir = o.side === 'BUY' ? 'short' : 'long';
          pos = positions.find(p =>
            p.symbol === o.symbol &&
            ((isStop || isTP) ? p.dir === closingDir : true)
          );
        }

        if (pos) {
          if (isStop) pos.sl = price;
          if (isTP) {
            if (!pos._tpList) pos._tpList = [];
            if (!pos._tpList.includes(price)) pos._tpList.push(price);
          }
        }
        if (isLim) {
          orders.push({
            exchange: 'BINANCE', type,
            ticker:     o.symbol.replace('USDT',''),
            symbol:     o.symbol,
            dir:        o.side === 'BUY' ? 'long' : 'short',
            price, origQty: parseFloat(o.origQty),
            size:       parseFloat(o.origQty) * price,
            exchangeId: `bnb-ord-${o.orderId}`,
          });
        }
      }
    }

    // Also fetch conditional orders (TP/SL combined orders — different endpoint)
    const ts3 = Date.now();
    const q3  = `timestamp=${ts3}`;
    const r3  = await safeFetch(
      `https://fapi.binance.com/fapi/v1/conditional/openOrders?${q3}&signature=${hmac256(sec,q3)}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    console.log(`Conditional orders response: ok=${r3.ok} status=${r3.status} isArray=${Array.isArray(r3.data)} raw=${r3.raw||JSON.stringify(r3.data)?.slice(0,100)}`);
    if (r3.ok && Array.isArray(r3.data)) {
      console.log(`Conditional orders: ${r3.data.length} total`);
      for (const o of r3.data) {
        const sym    = o.symbol;
        const tp     = parseFloat(o.activatePrice) || parseFloat(o.stopPrice) || 0;
        const sl     = parseFloat(o.stopPrice) || 0;
        const tpVal  = parseFloat(o.priceProtect ? o.activatePrice : 0) || 0;

        // Conditional order has both TP and SL in one order
        // Fields: activatePrice (TP trigger), stopPrice (SL trigger)
        const tpPrice = parseFloat(o.takeProfit?.triggerPrice || o.triggerPrice || 0);
        const slPrice = parseFloat(o.stopLoss?.triggerPrice   || o.stopPrice    || 0);

        const closingDir = o.side === 'BUY' ? 'short' : 'long';
        const pos = positions.find(p =>
          p.symbol === sym && p.dir === closingDir
        );

        if (pos) {
          if (slPrice && slPrice > 0) pos.sl = slPrice;
          if (tpPrice && tpPrice > 0) {
            if (!pos._tpList) pos._tpList = [];
            if (!pos._tpList.includes(tpPrice)) pos._tpList.push(tpPrice);
          }
          console.log(`  Conditional ${sym}: TP=${tpPrice} SL=${slPrice} → pos ${pos.dir}`);
        }
      }
    }

    // Sort TPs by distance from entry and assign
    for (const pos of positions) {
      if (pos._tpList && pos._tpList.length) {
        const sorted = pos._tpList.sort((a, b) =>
          pos.dir === 'long' ? a - b : b - a
        );
        pos.tp1 = sorted[0] || null;
        pos.tp2 = sorted[1] || null;
        pos.tp3 = sorted[2] || null;
        delete pos._tpList;
      }
    }

    state.positions = positions;
    state.orders    = orders;
    state.lastSync  = new Date().toISOString();
    state.error     = null;
    console.log(`✅ ${positions.length} positions, ${orders.length} orders`);

  } catch(e) {
    state.error = e.message;
    console.error('❌ Binance:', e.message);
  }
}

// Sync every 10 seconds
setInterval(syncBinance, 10000);
syncBinance();

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:    'ok',
  lastSync:  state.lastSync,
  positions: state.positions.length,
  orders:    state.orders.length,
  error:     state.error,
  exchange:  'BINANCE',
}));

app.get('/myip', async (req, res) => {
  try {
    const r = await fetch('https://api4.ipify.org?format=json');
    const d = await r.json();
    res.json({ ip: d.ip });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/binance-positions', (req, res) => res.json({
  positions: state.positions,
  lastSync:  state.lastSync,
  error:     state.error,
}));

app.get('/binance-orders', (req, res) => res.json({
  orders:   state.orders,
  lastSync: state.lastSync,
}));

app.get('/binance-history', async (req, res) => {
  const key = (process.env.BINANCE_KEY    || '').trim();
  const sec = (process.env.BINANCE_SECRET || '').trim();
  if (!key || !sec) return res.json({ trades: [], error: 'No keys' });

  const startTs = parseInt(req.query.from) || new Date('2026-01-01').getTime();
  const endTs   = parseInt(req.query.to)   || Date.now();
  const trades  = [];

  try {
    const ts  = Date.now();
    const q   = `startTime=${startTs}&endTime=${endTs}&limit=1000&timestamp=${ts}`;
    const sig = hmac256(sec, q);
    const r   = await safeFetch(
      `https://fapi.binance.com/fapi/v1/userTrades?${q}&signature=${sig}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    if (!r.ok || !Array.isArray(r.data)) {
      return res.json({ trades: [], error: `${r.status} ${r.raw || ''}` });
    }

    const byOrder = {};
    r.data.forEach(t => {
      if (!byOrder[t.orderId]) byOrder[t.orderId] = {
        trades: [], symbol: t.symbol, side: t.side,
        realizedPnl: 0, commission: 0, time: t.time
      };
      byOrder[t.orderId].trades.push(t);
      byOrder[t.orderId].realizedPnl += parseFloat(t.realizedPnl);
      byOrder[t.orderId].commission  += parseFloat(t.commission);
    });

    Object.values(byOrder).filter(o => o.realizedPnl !== 0).forEach(o => {
      const pnl  = Math.round(o.realizedPnl * 100) / 100;
      const fees = Math.round(o.commission  * 100) / 100;
      trades.push({
        exchangeSource: 'BINANCE',
        exchangeId:     `bnb-${o.trades[0].orderId}`,
        ticker:         o.symbol.replace('USDT','').replace('BUSD',''),
        dir:            o.side === 'BUY' ? 'long' : 'short',
        exchange:       'BINANCE',
        type:           'futures',
        entry:          parseFloat(o.trades[0]?.price) || 0,
        closePrice:     parseFloat(o.trades[o.trades.length-1]?.price) || 0,
        pnl:            pnl - fees,
        fees,
        posSize:        Math.abs(parseFloat(o.trades[0]?.quoteQty || 0)),
        status:         'closed',
        createdAt:      new Date(o.time).toISOString(),
        closeDate:      new Date(o.time).toISOString().split('T')[0],
        closeNotes:     'Importado de Binance Futures',
      });
    });

    res.json({ trades, total: trades.length });
  } catch(e) {
    res.json({ trades: [], error: e.message });
  }
});

// Binance closed position history
app.get('/binance-position-history', async (req, res) => {
  const key = (process.env.BINANCE_KEY    || '').trim();
  const sec = (process.env.BINANCE_SECRET || '').trim();
  if (!key || !sec) return res.json({ trades: [], error: 'No keys' });

  const startTs = parseInt(req.query.from) || new Date('2026-01-01').getTime();
  const endTs   = parseInt(req.query.to)   || Date.now();
  const trades  = [];

  try {
    // Binance futures income history — REALIZED_PNL type gives closed position PnL
    const ts  = Date.now();
    const q   = `incomeType=REALIZED_PNL&startTime=${startTs}&endTime=${endTs}&limit=1000&timestamp=${ts}`;
    const sig = hmac256(sec, q);
    const r   = await safeFetch(
      `https://fapi.binance.com/fapi/v1/income?${q}&signature=${sig}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    if (!r.ok || !Array.isArray(r.data)) {
      return res.json({ trades: [], error: `${r.status} ${r.raw || ''}` });
    }

    // Group by symbol to combine multiple partial closes
    const bySymTime = {};
    r.data.forEach(item => {
      const key2 = `${item.symbol}-${item.tradeId}`;
      if (!bySymTime[key2]) bySymTime[key2] = { ...item, income: 0 };
      bySymTime[key2].income += parseFloat(item.income);
    });

    // Also get trade history for entry prices
    const ts2  = Date.now();
    const q2   = `startTime=${startTs}&endTime=${endTs}&limit=1000&timestamp=${ts2}`;
    const sig2 = hmac256(sec, q2);
    const r2   = await safeFetch(
      `https://fapi.binance.com/fapi/v1/userTrades?${q2}&signature=${sig2}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    // Group trades by orderId
    const byOrder = {};
    if (r2.ok && Array.isArray(r2.data)) {
      r2.data.forEach(t => {
        if (!byOrder[t.orderId]) byOrder[t.orderId] = {
          trades: [], symbol: t.symbol, side: t.side,
          realizedPnl: 0, commission: 0, qty: 0, time: t.time,
        };
        byOrder[t.orderId].trades.push(t);
        byOrder[t.orderId].realizedPnl += parseFloat(t.realizedPnl);
        byOrder[t.orderId].commission  += parseFloat(t.commission);
        byOrder[t.orderId].qty         += parseFloat(t.qty);
      });

      Object.values(byOrder)
        .filter(o => o.realizedPnl !== 0)
        .forEach(o => {
          const pnl  = Math.round(o.realizedPnl * 100) / 100;
          const fees = Math.round(o.commission  * 100) / 100;
          const firstTrade = o.trades[0];
          const lastTrade  = o.trades[o.trades.length - 1];
          trades.push({
            exchangeSource: 'BINANCE',
            exchangeId:     `bnb-pos-${firstTrade.orderId}`,
            ticker:         o.symbol.replace('USDT','').replace('BUSD',''),
            dir:            o.side === 'BUY' ? 'long' : 'short',
            exchange:       'BINANCE',
            type:           'futures',
            entry:          parseFloat(firstTrade.price) || 0,
            closePrice:     parseFloat(lastTrade.price)  || 0,
            pnl:            pnl - fees,
            pnlRaw:         pnl,
            fees,
            posSize:        parseFloat(firstTrade.quoteQty || 0),
            leverage:       1,
            status:         'closed',
            createdAt:      new Date(o.time).toISOString(),
            closeDate:      new Date(o.time).toISOString().split('T')[0],
            closeNotes:     'Importado de Binance Futures',
          });
        });
    }

    res.json({ trades, total: trades.length });
  } catch(e) {
    res.json({ trades: [], error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 MAUex Binance server on port ${PORT}`);
  console.log(`   Key: ${process.env.BINANCE_KEY ? '✅' : '❌ not set'}`);
});
