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

    // Build leverage map from positionRisk (already fetched in r1)
    const leverageMap = {};
    if (Array.isArray(r1.data)) {
      for (const p of r1.data) {
        leverageMap[p.symbol] = parseInt(p.leverage) || 1;
      }
    }

    // Open orders → attach SL/TP to positions AND build pending order groups
    const ts2 = Date.now();
    const q2  = `timestamp=${ts2}`;
    const r2  = await safeFetch(
      `https://fapi.binance.com/fapi/v1/openOrders?${q2}&signature=${hmac256(sec,q2)}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    // pendingGroups: keyed by "SYMBOL-DIR" to group entry+SL+TPs together
    const pendingGroups = {};

    if (r2.ok && Array.isArray(r2.data)) {
      console.log('RAW orders sample:', JSON.stringify(r2.data.slice(0,4)));
      for (const o of r2.data) {
        const price  = parseFloat(o.stopPrice) || parseFloat(o.price) || 0;
        const type   = o.type || '';
        const isStop = type.includes('STOP');
        const isTP   = type.includes('TAKE_PROFIT');
        const isLim  = type === 'LIMIT';

        // Direction: in hedge mode use positionSide; in one-way use side
        // For LIMIT (entry): side tells us the direction directly
        // For STOP/TP (closing): side is OPPOSITE to the position direction
        let dir;
        if (isHedge) {
          dir = o.positionSide === 'LONG' ? 'long' : 'short';
        } else {
          if (isLim) {
            dir = o.side === 'BUY' ? 'long' : 'short';
          } else {
            // closing order — opposite side = position direction
            dir = o.side === 'BUY' ? 'short' : 'long';
          }
        }

        const groupKey = `${o.symbol}-${dir}`;
        if (!pendingGroups[groupKey]) {
          pendingGroups[groupKey] = {
            exchange: 'BINANCE',
            ticker:   o.symbol.replace('USDT','').replace('BUSD',''),
            symbol:   o.symbol,
            dir,
            leverage: leverageMap[o.symbol] || null,
            entry:    null,
            totalQty: 0,
            totalSize: 0,
            sl:       null,
            _tpList:  [],
            tp1: null, tp2: null, tp3: null,
            status:   'PENDIENTE',
          };
        }

        const g = pendingGroups[groupKey];

        if (isLim) {
          // Entry order — accumulate qty/size in case of multiple partials
          const qty = parseFloat(o.origQty) || 0;
          g.totalQty  += qty;
          g.totalSize += qty * price;
          // Use first entry price found (or average if multiple)
          g.entry = g.totalQty > 0 ? g.totalSize / g.totalQty : price;
        }

        if (isStop && price > 0) {
          // Keep the SL closest to entry (for shorts: lowest above entry; for longs: highest below entry)
          if (!g.sl) {
            g.sl = price;
          } else {
            g.sl = dir === 'long'
              ? Math.max(g.sl, price)
              : Math.min(g.sl, price);
          }
        }

        if (isTP && price > 0) {
          if (!g._tpList.includes(price)) g._tpList.push(price);
        }

        // Also attach SL/TP to open positions as before
        const oDir = dir;
        let pos;
        if (isHedge) {
          pos = positions.find(p => p.symbol === o.symbol && p.dir === oDir);
        } else {
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
      }
    }

    // Finalize pending groups: sort TPs, assign tp1/2/3, only include groups with an entry
    for (const g of Object.values(pendingGroups)) {
      if (g.entry === null) continue; // no LIMIT order = skip (only SL/TP orphans)
      if (g._tpList.length) {
        const sorted = g._tpList.sort((a, b) => g.dir === 'long' ? a - b : b - a);
        g.tp1 = sorted[0] || null;
        g.tp2 = sorted[1] || null;
        g.tp3 = sorted[2] || null;
      }
      delete g._tpList;
      g.entry    = Math.round(g.entry    * 10000) / 10000;
      g.totalSize = Math.round(g.totalSize * 100) / 100;
      orders.push(g);
    }

    // ── ATTEMPT: bapi strategy endpoint with API key ──────────────────────────
    try {
      const rStrat = await safeFetch(
        'https://www.binance.com/bapi/futures/v1/private/future/strategy/query-open-strategy-batch',
        {
          method:  'POST',
          headers: {
            'X-MBX-APIKEY': key,
            'Content-Type': 'application/json',
            'clienttype':   'web',
            'lang':         'en',
          },
          body: '{}',
        }
      );
      console.log(`BAPI strategy: status=${rStrat.status} ok=${rStrat.ok}`);
      console.log(`BAPI strategy raw: ${JSON.stringify(rStrat.data)?.slice(0,500)}`);

      if (rStrat.ok && rStrat.data?.success && rStrat.data?.data?.strategyOrders) {
        const strategyOrders = rStrat.data.data.strategyOrders;
        console.log(`BAPI strategy: ${strategyOrders.length} strategies found`);
        for (const strat of strategyOrders) {
          const subOrders = strat.subOrders || [];
          const entryOrder = subOrders.find(s => s.type === 'LIMIT' && s.status === 'NEW');
          if (!entryOrder) continue;
          const sym = entryOrder.symbol;
          const dir = entryOrder.side === 'SELL' ? 'short' : 'long';
          const g   = orders.find(o => o.symbol === sym && o.dir === dir);
          if (!g) continue;
          const tpList = subOrders
            .filter(s => s.type === 'TAKE_PROFIT_MARKET' && parseFloat(s.stopPrice) > 0)
            .map(s => parseFloat(s.stopPrice))
            .sort((a, b) => dir === 'long' ? a - b : b - a);
          const slSub = subOrders.find(s => s.type === 'STOP_MARKET' && parseFloat(s.stopPrice) > 0);
          if (slSub)   g.sl  = parseFloat(slSub.stopPrice);
          if (tpList[0]) g.tp1 = tpList[0];
          if (tpList[1]) g.tp2 = tpList[1];
          if (tpList[2]) g.tp3 = tpList[2];
          console.log(`Strategy enriched: ${sym} ${dir} sl=${g.sl} tp1=${g.tp1} tp2=${g.tp2} tp3=${g.tp3}`);
        }
      }
    } catch(e) {
      console.log(`BAPI strategy error: ${e.message}`);
    }


    // Also fetch conditional orders (TP/SL combined orders — different endpoint)
    const ts3 = Date.now();
    const q3  = `timestamp=${ts3}`;
    const r3  = await safeFetch(
      `https://fapi.binance.com/fapi/v1/openAlgoOrders?${q3}&signature=${hmac256(sec,q3)}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    if (r3.ok && r3.data) {
      const algoOrders = r3.data.orders || (Array.isArray(r3.data) ? r3.data : []);
      console.log(`Algo orders: ${algoOrders.length} found`);
      console.log(`Algo orders: ${algoOrders.length} total`);
      for (const o of algoOrders) {
        const sym      = o.symbol;
        // triggerPrice is the key field — orderType tells us if it's TP or SL
        const triggerPrice = parseFloat(o.triggerPrice || 0);
        const isTP = o.orderType === 'TAKE_PROFIT' || o.orderType === 'TAKE_PROFIT_MARKET';
        const isSL = o.orderType === 'STOP'        || o.orderType === 'STOP_MARKET';

        // In one-way mode, closing orders have opposite side
        const closingDir = o.side === 'BUY' ? 'short' : 'long';
        const pos = positions.find(p => p.symbol === sym && p.dir === closingDir);

        if (pos && triggerPrice > 0) {
          if (isTP) {
            if (!pos._tpList) pos._tpList = [];
            if (!pos._tpList.includes(triggerPrice)) pos._tpList.push(triggerPrice);
          }
          if (isSL) {
            // For LONG: SL must be BELOW entry — keep highest below entry (closest)
            // For SHORT: SL must be ABOVE entry — keep lowest above entry (closest)
            const entry = pos.entry || 0;
            const validSL = closingDir === 'long'
              ? triggerPrice < entry   // SL must be below entry for LONG
              : triggerPrice > entry;  // SL must be above entry for SHORT
            if (validSL) {
              if (!pos.sl) {
                pos.sl = triggerPrice;
              } else {
                pos.sl = closingDir === 'long'
                  ? Math.max(pos.sl, triggerPrice)  // closest to entry = highest
                  : Math.min(pos.sl, triggerPrice); // closest to entry = lowest
              }
            }
          }
        }
      }
    } else {
      console.log(`Algo orders raw: status=${r3.status} ok=${r3.ok} data=${JSON.stringify(r3.data)?.slice(0,200)} raw=${r3.raw?.slice(0,200)}`);
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
// ═════════════════════════════════════════════════════════════════════════════
// FILLS POLLING — detects trade executions and saves to Firestore
// ═════════════════════════════════════════════════════════════════════════════

// Track last processed fill time per exchange
const lastFillTime = {
  binance: Date.now() - 60000, // start 1 min ago
  bybit:   Date.now() - 60000,
  okx:     Date.now() - 60000,
};

async function pollBinanceFills() {
  const key = (process.env.BINANCE_KEY    || '').trim();
  const sec = (process.env.BINANCE_SECRET || '').trim();
  if (!key || !sec) return;

  try {
    const since = lastFillTime.binance;
    const ts    = Date.now();
    const q     = `startTime=${since}&limit=100&timestamp=${ts}`;
    const sig   = hmac256(sec, q);
    const r     = await safeFetch(
      `https://fapi.binance.com/fapi/v1/userTrades?${q}&signature=${sig}`,
      { headers: { 'X-MBX-APIKEY': key } }
    );

    if (!r.ok || !Array.isArray(r.data)) return;
    if (r.data.length === 0) return;

    console.log(`Binance fills: ${r.data.length} new fills since ${new Date(since).toISOString()}`);

    // Group fills by orderId
    const byOrder = {};
    r.data.forEach(f => {
      if (!byOrder[f.orderId]) byOrder[f.orderId] = {
        fills: [], symbol: f.symbol, side: f.side,
        realizedPnl: 0, commission: 0, qty: 0,
        time: f.time, orderId: f.orderId,
      };
      byOrder[f.orderId].fills.push(f);
      byOrder[f.orderId].realizedPnl += parseFloat(f.realizedPnl || 0);
      byOrder[f.orderId].commission  += parseFloat(f.commission  || 0);
      byOrder[f.orderId].qty         += parseFloat(f.qty         || 0);
    });

    // Only process orders with realized PnL (closing trades)
    const closingOrders = Object.values(byOrder).filter(o => o.realizedPnl !== 0);

    for (const o of closingOrders) {
      const pnl    = Math.round(o.realizedPnl * 100) / 100;
      const fees   = Math.round(o.commission  * 100) / 100;
      const ticker = o.symbol.replace('USDT','').replace('BUSD','');
      const dir    = o.side === 'BUY' ? 'long' : 'short';
      const price  = parseFloat(o.fills[o.fills.length-1]?.price) || 0;
      const qty    = o.qty;
      const notional = qty * price;

      const trade = {
        exchangeSource: 'BINANCE',
        exchangeId:     `bnb-fill-${o.orderId}`,
        ticker,
        dir,
        exchange:       'BINANCE',
        type:           'futures',
        closePrice:     price,
        pnl:            pnl - fees,
        pnlRaw:         pnl,
        fees,
        posSize:        Math.round(notional * 100) / 100,
        qty:            qty,
        status:         'pending_review',
        closeDate:      new Date(o.time).toISOString().split('T')[0],
        createdAt:      new Date(o.time).toISOString(),
        closeNotes:     'Auto-detectado via fills',
        source:         'auto',
      };

      await saveFillToFirestore(trade);
    }

    // Update last fill time to latest fill
    lastFillTime.binance = Math.max(...r.data.map(f => f.time)) + 1;

  } catch(e) {
    console.error('Binance fills error:', e.message);
  }
}

async function pollBybitFills() {
  const key = (process.env.BYBIT_KEY || '').trim();
  const sec = (process.env.BYBIT_SECRET || '').trim();
  if (!key || !sec) return;

  try {
    const since = lastFillTime.bybit;
    const ts    = Date.now().toString();
    const q     = `category=linear&startTime=${since}&limit=100`;
    const msg   = ts + key + '5000' + q;
    const sig   = hmac256(sec, msg);

    const r = await safeFetch(
      `https://api.bybit.com/v5/execution/list?${q}`,
      { headers: {
        'X-BAPI-API-KEY': key, 'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': '5000'
      }}
    );

    if (!r.ok || r.data?.retCode !== 0) return;
    const list = r.data.result?.list || [];
    if (list.length === 0) return;

    console.log(`Bybit fills: ${list.length} new fills`);

    // Group by orderId
    const byOrder = {};
    list.forEach(f => {
      if (!byOrder[f.orderId]) byOrder[f.orderId] = {
        fills: [], symbol: f.symbol, side: f.side,
        pnl: 0, fees: 0, qty: 0, time: parseInt(f.execTime),
      };
      byOrder[f.orderId].fills.push(f);
      byOrder[f.orderId].pnl  += parseFloat(f.closedPnl || 0);
      byOrder[f.orderId].fees += parseFloat(f.execFee   || 0);
      byOrder[f.orderId].qty  += parseFloat(f.execQty   || 0);
    });

    const closingOrders = Object.values(byOrder).filter(o => o.pnl !== 0);

    for (const o of closingOrders) {
      const pnl    = Math.round(o.pnl  * 100) / 100;
      const fees   = Math.round(Math.abs(o.fees) * 100) / 100;
      const price  = parseFloat(o.fills[o.fills.length-1]?.execPrice) || 0;
      const ticker = o.symbol.replace('USDT','');

      const trade = {
        exchangeSource: 'BYBIT',
        exchangeId:     `bybit-fill-${o.fills[0].orderId}`,
        ticker,
        dir:            o.side === 'Buy' ? 'long' : 'short',
        exchange:       'BYBIT',
        type:           'futures',
        closePrice:     price,
        pnl:            pnl - fees,
        pnlRaw:         pnl,
        fees,
        posSize:        price * o.qty,
        qty:            o.qty,
        status:         'pending_review',
        closeDate:      new Date(o.time).toISOString().split('T')[0],
        createdAt:      new Date(o.time).toISOString(),
        closeNotes:     'Auto-detectado via fills',
        source:         'auto',
      };

      await saveFillToFirestore(trade);
    }

    if (list.length > 0) {
      lastFillTime.bybit = Math.max(...list.map(f => parseInt(f.execTime))) + 1;
    }

  } catch(e) {
    console.error('Bybit fills error:', e.message);
  }
}

async function pollOKXFills() {
  const key  = (process.env.OKX_KEY        || '').trim();
  const sec  = (process.env.OKX_SECRET     || '').trim();
  const pass = (process.env.OKX_PASSPHRASE || '').trim();
  if (!key || !sec || !pass) return;

  try {
    const path = '/api/v5/trade/fills?instType=SWAP&limit=100';
    const ts   = new Date().toISOString();
    const sig  = require('crypto')
      .createHmac('sha256', sec)
      .update(ts + 'GET' + path)
      .digest('base64');

    const r = await safeFetch(`https://www.okx.com${path}`, {
      headers: {
        'OK-ACCESS-KEY': key, 'OK-ACCESS-SIGN': sig,
        'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': pass,
        'Content-Type': 'application/json',
      }
    });

    if (!r.ok || r.data?.code !== '0') return;
    const list = (r.data.data || []).filter(f =>
      parseInt(f.ts) > lastFillTime.okx && parseFloat(f.pnl || 0) !== 0
    );
    if (list.length === 0) return;

    console.log(`OKX fills: ${list.length} new fills`);

    for (const f of list) {
      const pnl    = parseFloat(f.pnl  || 0);
      const fees   = Math.abs(parseFloat(f.fee || 0));
      const ticker = f.instId.replace('-USDT-SWAP','').replace('-','');
      const price  = parseFloat(f.fillPx || 0);
      const qty    = parseFloat(f.fillSz || 0);

      const trade = {
        exchangeSource: 'OKX',
        exchangeId:     `okx-fill-${f.tradeId}`,
        ticker,
        dir:            f.side === 'buy' ? 'long' : 'short',
        exchange:       'OKX',
        type:           'futures',
        closePrice:     price,
        pnl:            Math.round((pnl - fees) * 100) / 100,
        pnlRaw:         Math.round(pnl * 100) / 100,
        fees:           Math.round(fees * 100) / 100,
        posSize:        price * qty,
        qty,
        status:         'pending_review',
        closeDate:      new Date(parseInt(f.ts)).toISOString().split('T')[0],
        createdAt:      new Date(parseInt(f.ts)).toISOString(),
        closeNotes:     'Auto-detectado via fills',
        source:         'auto',
      };

      await saveFillToFirestore(trade);
    }

    if (list.length > 0) {
      lastFillTime.okx = Math.max(...list.map(f => parseInt(f.ts))) + 1;
    }

  } catch(e) {
    console.error('OKX fills error:', e.message);
  }
}

// Save fill to Firestore (only if not already saved)
async function saveFillToFirestore(trade) {
  if (!db) return;
  try {
    const col  = db.collection('trades');
    // Check if already exists
    const snap = await col.where('exchangeId', '==', trade.exchangeId).limit(1).get();
    if (!snap.empty) return; // Already saved

    // Find user — get from sync doc
    const syncDoc = await db.collection('sync').doc('latest').get();
    const userId  = syncDoc.exists ? syncDoc.data()?.userId : null;
    if (!userId) {
      console.warn('No userId found for fill save');
      return;
    }

    await col.add({ ...trade, userId });
    console.log(`✅ Saved fill: ${trade.exchange} ${trade.ticker} PnL=${trade.pnl}`);
  } catch(e) {
    console.error('Firestore save error:', e.message);
  }
}

// Poll fills every 30 seconds
setInterval(async () => {
  await Promise.all([
    pollBinanceFills(),
    pollBybitFills(),
    pollOKXFills(),
  ]);
}, 30000);

// Initial poll after 10 seconds
setTimeout(async () => {
  await Promise.all([
    pollBinanceFills(),
    pollBybitFills(),
    pollOKXFills(),
  ]);
}, 10000);

// Receive userId from frontend to associate fills
app.post('/set-user', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.json({ error: 'No userId' });
  // Save userId to Firestore sync doc so fills can be attributed
  if (db) {
    await db.collection('sync').doc('latest').set({ userId }, { merge: true });
  }
  res.json({ ok: true });
});

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
