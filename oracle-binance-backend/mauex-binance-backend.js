const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const BINANCE_KEY = (process.env.BINANCE_KEY || '').trim();
const BINANCE_SECRET = (process.env.BINANCE_SECRET || '').trim();
const KUCOIN_KEY = (process.env.KUCOIN_KEY || '').trim();
const KUCOIN_SECRET = (process.env.KUCOIN_SECRET || '').trim();
const KUCOIN_PASSPHRASE = (process.env.KUCOIN_PASSPHRASE || '').trim();
const KUCOIN_KEY_VERSION = (process.env.KUCOIN_KEY_VERSION || '2').trim();
const IBKR_GATEWAY_URL = (process.env.IBKR_GATEWAY_URL || 'https://127.0.0.1:5000').replace(/\/+$/, '');
const IBKR_ACCOUNT_ID = (process.env.IBKR_ACCOUNT_ID || '').trim();

if (process.env.IBKR_ALLOW_SELF_SIGNED !== '0') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function hmac256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function hmac256Base64(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    const text = await response.text();

    try {
      return { ok: response.ok, status: response.status, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, data: null, raw: text.slice(0, 300) };
    }
  } catch (error) {
    return { ok: false, status: 0, data: null, raw: error.message };
  }
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function getPublicIp() {
  const r = await safeFetch('https://api4.ipify.org?format=json');
  if (r.ok && r.data?.ip) return r.data.ip;

  const r2 = await fetch('https://ipv4.icanhazip.com');
  return (await r2.text()).trim();
}

async function getBinanceBalance() {
  if (!BINANCE_KEY || !BINANCE_SECRET) {
    return { error: 'BINANCE_KEY/BINANCE_SECRET not set' };
  }

  const futuresQuery = `recvWindow=10000&timestamp=${Date.now()}`;
  const futuresSignature = hmac256(BINANCE_SECRET, futuresQuery);
  const response = await safeFetch(
    `https://fapi.binance.com/fapi/v2/account?${futuresQuery}&signature=${futuresSignature}`,
    { headers: { 'X-MBX-APIKEY': BINANCE_KEY } }
  );

  if (!response.ok || !response.data) {
    return { error: `${response.status} ${response.raw || 'no data'}` };
  }

  if (response.data.code) {
    return { error: `${response.data.code}: ${response.data.msg || 'Binance error'}` };
  }

  const assets = response.data.assets || [];
  let total = 0;
  let wallet = 0;
  let free = 0;
  let margin = 0;
  let orders = 0;
  let pnl = 0;
  let USDT = 0;
  let USDC = 0;

  if (assets.length) {
    for (const asset of assets) {
      const walletBalance = Number(asset.walletBalance || 0);
      const marginBalance = Number(asset.marginBalance || 0);
      if (walletBalance === 0 && marginBalance === 0) continue;

      const available = Number(asset.availableBalance || 0);
      const positionMargin = Number(asset.positionInitialMargin || 0);
      const orderMargin = Number(asset.openOrderInitialMargin || 0);
      const unrealizedPnl = Number(asset.unrealizedProfit || 0);

      total += marginBalance;
      wallet += walletBalance;
      free += available;
      margin += positionMargin;
      orders += orderMargin;
      pnl += unrealizedPnl;

      if (asset.asset === 'USDT') USDT += marginBalance || walletBalance;
      if (asset.asset === 'USDC') USDC += marginBalance || walletBalance;
    }
  } else {
    total = Number(response.data.totalMarginBalance || 0);
    wallet = Number(response.data.totalWalletBalance || 0);
    free = Number(response.data.availableBalance || 0);
    margin = Number(response.data.totalInitialMargin || 0);
    pnl = Number(response.data.totalUnrealizedProfit || 0);
    USDT = total;
  }

  const spotQuery = `recvWindow=10000&timestamp=${Date.now()}`;
  const spotSignature = hmac256(BINANCE_SECRET, spotQuery);
  const spotResponse = await safeFetch(
    `https://api.binance.com/api/v3/account?${spotQuery}&signature=${spotSignature}`,
    { headers: { 'X-MBX-APIKEY': BINANCE_KEY } }
  );

  if (spotResponse.ok && spotResponse.data?.balances) {
    for (const asset of spotResponse.data.balances) {
      if (asset.asset !== 'USDT' && asset.asset !== 'USDC') continue;
      const freeSpot = Number(asset.free || 0);
      const lockedSpot = Number(asset.locked || 0);
      const spotTotal = freeSpot + lockedSpot;
      if (spotTotal <= 0) continue;

      total += spotTotal;
      wallet += spotTotal;
      free += freeSpot;
      orders += lockedSpot;
      if (asset.asset === 'USDT') USDT += spotTotal;
      if (asset.asset === 'USDC') USDC += spotTotal;
    }
  }

  return {
    exchange: 'BINANCE',
    total: round(total),
    wallet: round(wallet),
    free: round(free),
    margin: round(margin),
    orders: round(orders),
    pnl: round(pnl),
    USDT: round(USDT),
    USDC: round(USDC),
    updatedAt: new Date().toISOString(),
  };
}

async function kucoinGet(baseUrl, path) {
  const timestamp = Date.now().toString();
  const signature = hmac256Base64(KUCOIN_SECRET, timestamp + 'GET' + path);
  const passphrase = KUCOIN_KEY_VERSION === '2'
    ? hmac256Base64(KUCOIN_SECRET, KUCOIN_PASSPHRASE)
    : KUCOIN_PASSPHRASE;

  return safeFetch(`${baseUrl}${path}`, {
    headers: {
      'KC-API-KEY': KUCOIN_KEY,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': timestamp,
      'KC-API-PASSPHRASE': passphrase,
      'KC-API-KEY-VERSION': KUCOIN_KEY_VERSION,
      'Content-Type': 'application/json',
    },
  });
}

async function getKucoinUsdPrice(currency) {
  if (currency === 'USDT' || currency === 'USDC') return 1;

  for (const quote of ['USDT', 'USDC']) {
    const response = await safeFetch(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${currency}-${quote}`);
    if (response.ok && response.data?.code === '200000') {
      const price = Number(response.data.data?.price || 0);
      if (price > 0) return price;
    }
  }

  return 0;
}

async function getKucoinBalance() {
  if (!KUCOIN_KEY || !KUCOIN_SECRET || !KUCOIN_PASSPHRASE) {
    return { error: 'KUCOIN_KEY/KUCOIN_SECRET/KUCOIN_PASSPHRASE not set' };
  }

  let total = 0;
  let free = 0;
  let margin = 0;
  let orders = 0;
  let pnl = 0;
  let USDT = 0;
  let USDC = 0;
  let positionEquity = 0;
  let positionUsdt = 0;
  let positionUsdc = 0;
  const requestErrors = [];

  const addStable = (currency, equity, available = 0, hold = 0) => {
    const value = Number(equity || 0);
    const freeValue = Number(available || 0);
    const holdValue = Number(hold || 0);
    total += value;
    free += freeValue;
    orders += holdValue;
    if (currency === 'USDT') USDT += value;
    if (currency === 'USDC') USDC += value;
  };

  for (const currency of ['USDT', 'USDC']) {
    const path = `/api/v1/account-overview?currency=${currency}`;
    const response = await kucoinGet('https://api-futures.kucoin.com', path);

    if (response.ok && response.data?.code === '200000' && response.data?.data) {
      const data = response.data.data;
      const equity = Number(data.accountEquity || data.marginBalance || 0);
      const available = Number(data.availableBalance || data.availableMargin || 0);
      const positionMargin = Number(data.positionMargin || 0);
      const orderMargin = Number(data.orderMargin || data.frozenFunds || 0);
      const unrealizedPnl = Number(data.unrealisedPNL || data.unrealizedPNL || 0);

      total += equity;
      free += available;
      margin += positionMargin;
      orders += orderMargin;
      pnl += unrealizedPnl;
      if (currency === 'USDT') USDT += equity;
      if (currency === 'USDC') USDC += equity;
    } else {
      requestErrors.push(`futures ${currency}: ${response.data?.msg || response.raw || response.status}`);
    }
  }

  const spotResponse = await kucoinGet('https://api.kucoin.com', '/api/v1/accounts');
  if (spotResponse.ok && spotResponse.data?.code === '200000' && Array.isArray(spotResponse.data.data)) {
    for (const account of spotResponse.data.data) {
      const balance = Number(account.balance || 0);
      const available = Number(account.available || 0);
      const holds = Number(account.holds || 0);
      if (balance === 0 && available === 0 && holds === 0) continue;

      if (account.currency === 'USDT' || account.currency === 'USDC') {
        addStable(account.currency, balance, available, holds);
      } else {
        const usdPrice = await getKucoinUsdPrice(account.currency);
        if (usdPrice > 0) {
          const usdBalance = balance * usdPrice;
          total += usdBalance;
          free += available * usdPrice;
          orders += holds * usdPrice;
          USDT += usdBalance;
        } else {
          requestErrors.push(`spot ${account.currency}: no USD price`);
        }
      }
    }
  } else {
    requestErrors.push(`spot: ${spotResponse.data?.msg || spotResponse.raw || spotResponse.status}`);
  }

  const positionsResponse = await kucoinGet('https://api-futures.kucoin.com', '/api/v1/positions');
  if (positionsResponse.ok && positionsResponse.data?.code === '200000' && Array.isArray(positionsResponse.data.data)) {
    for (const position of positionsResponse.data.data) {
      if (position.isOpen === false || Number(position.currentQty || 0) === 0) continue;
      const settle = position.settleCurrency || 'USDT';
      const markValue = Math.abs(Number(position.markValue || position.currentCost || position.posCost || 0));
      const positionMargin = Math.abs(Number(position.posMargin || position.posInit || 0));
      const unrealizedPnl = Number(position.unrealisedPnl || position.unrealizedPnl || 0);
      const equityValue = positionMargin + unrealizedPnl;

      margin += positionMargin;
      pnl += unrealizedPnl;

      positionEquity += equityValue || markValue;
      if (settle === 'USDT') positionUsdt += equityValue || markValue;
      if (settle === 'USDC') positionUsdc += equityValue || markValue;
    }
  } else {
    requestErrors.push(`positions: ${positionsResponse.data?.msg || positionsResponse.raw || positionsResponse.status}`);
  }

  const utaOverview = await kucoinGet('https://api.kucoin.com', '/api/ua/v1/unified/account/overview');
  const utaBalance = await kucoinGet('https://api.kucoin.com', '/api/ua/v1/unified/account/balance');
  const utaPositions = await kucoinGet('https://api.kucoin.com', '/api/ua/v1/unified/position/open-list?pageNumber=1&pageSize=200');
  let utaUsdt = 0;
  let utaUsdc = 0;
  let utaFree = 0;
  let utaHolds = 0;

  if (utaBalance.ok && utaBalance.data?.code === '200000') {
    const accounts = utaBalance.data.data?.accounts || [];
    for (const account of accounts) {
      for (const currency of (account.currencies || [])) {
        if (currency.currency !== 'USDT' && currency.currency !== 'USDC') continue;
        const equity = Number(currency.equity || currency.balance || 0);
        const available = Number(currency.available || 0);
        const hold = Number(currency.hold || 0);
        if (currency.currency === 'USDT') utaUsdt += equity;
        if (currency.currency === 'USDC') utaUsdc += equity;
        utaFree += available;
        utaHolds += hold;
      }
    }
  } else {
    requestErrors.push(`uta balance: ${utaBalance.data?.msg || utaBalance.raw || utaBalance.status}`);
  }

  if (utaPositions.ok && utaPositions.data?.code === '200000' && Array.isArray(utaPositions.data.data)) {
    for (const position of utaPositions.data.data) {
      if (Number(position.size || 0) === 0) continue;
      const positionMargin = Math.abs(Number(position.initialMargin || 0));
      const unrealizedPnl = Number(position.unrealizedPnL || position.unrealisedPnl || 0);
      const positionValue = Math.abs(Number(position.positionValue || 0));
      const equityValue = positionMargin + unrealizedPnl;

      margin += positionMargin;
      pnl += unrealizedPnl;
      positionEquity += equityValue || positionValue;
      positionUsdt += equityValue || positionValue;
    }
  } else {
    requestErrors.push(`uta positions: ${utaPositions.data?.msg || utaPositions.raw || utaPositions.status}`);
  }

  if (utaOverview.ok && utaOverview.data?.code === '200000' && utaOverview.data?.data) {
    const data = utaOverview.data.data;
    const utaTotal = Number(data.equity || data.adjustedEquity || 0);
    const utaAvailable = Number(data.availableMargin || 0);
    const utaMargin = Number(data.im || 0);
    total += utaTotal || (utaUsdt + utaUsdc);
    free += utaAvailable || utaFree;
    margin += utaMargin;
    orders += utaHolds;
    USDT += utaUsdt || (utaTotal && !utaUsdc ? utaTotal : 0);
    USDC += utaUsdc;
  } else if (utaUsdt || utaUsdc) {
    total += utaUsdt + utaUsdc;
    free += utaFree;
    orders += utaHolds;
    USDT += utaUsdt;
    USDC += utaUsdc;
  } else {
    requestErrors.push(`uta overview: ${utaOverview.data?.msg || utaOverview.raw || utaOverview.status}`);
  }

  const positionAlreadyCovered = Math.max(0, total - free);
  const positionShortfall = Math.max(0, positionEquity - positionAlreadyCovered);
  if (positionShortfall > 0) {
    total += positionShortfall;
    if (positionUsdt >= positionUsdc) USDT += positionShortfall;
    else USDC += positionShortfall;
  }

  if (total === 0 && USDT === 0 && USDC === 0 && requestErrors.length) {
    return { error: requestErrors.join('; ') };
  }

  return {
    exchange: 'KUCOIN',
    total: round(total || USDT + USDC),
    free: round(free),
    margin: round(margin),
    orders: round(orders),
    pnl: round(pnl),
    USDT: round(USDT),
    USDC: round(USDC),
    updatedAt: new Date().toISOString(),
  };
}

async function getKucoinDebug() {
  if (!KUCOIN_KEY || !KUCOIN_SECRET || !KUCOIN_PASSPHRASE) {
    return { error: 'KUCOIN_KEY/KUCOIN_SECRET/KUCOIN_PASSPHRASE not set' };
  }

  const summarize = (response, pick = x => x) => ({
    ok: response.ok,
    status: response.status,
    code: response.data?.code,
    msg: response.data?.msg || response.raw || null,
    data: pick(response.data?.data),
  });

  const classicPositions = await kucoinGet('https://api-futures.kucoin.com', '/api/v1/positions');
  const utaPositions = await kucoinGet('https://api.kucoin.com', '/api/ua/v1/unified/position/open-list?pageNumber=1&pageSize=200');
  const utaOverview = await kucoinGet('https://api.kucoin.com', '/api/ua/v1/unified/account/overview');
  const utaBalance = await kucoinGet('https://api.kucoin.com', '/api/ua/v1/unified/account/balance');
  const spotAccounts = await kucoinGet('https://api.kucoin.com', '/api/v1/accounts');

  return {
    classicPositions: summarize(classicPositions, data => Array.isArray(data) ? data.map(p => ({
      symbol: p.symbol,
      isOpen: p.isOpen,
      currentQty: p.currentQty,
      settleCurrency: p.settleCurrency,
      posMargin: p.posMargin,
      posInit: p.posInit,
      markValue: p.markValue,
      unrealisedPnl: p.unrealisedPnl,
    })) : data),
    utaPositions: summarize(utaPositions, data => Array.isArray(data) ? data.map(p => ({
      symbol: p.symbol,
      size: p.size,
      positionValue: p.positionValue,
      initialMargin: p.initialMargin,
      unrealizedPnL: p.unrealizedPnL,
      leverage: p.leverage,
    })) : data),
    utaOverview: summarize(utaOverview, data => data),
    utaBalance: summarize(utaBalance, data => data?.accounts?.map(account => ({
      currencies: (account.currencies || []).filter(c => ['USDT', 'USDC', 'XMR'].includes(c.currency)),
    })) || data),
    spotAccounts: summarize(spotAccounts, data => Array.isArray(data) ? data
      .filter(account => Number(account.balance || 0) !== 0 || Number(account.available || 0) !== 0 || Number(account.holds || 0) !== 0)
      .map(account => ({
        type: account.type,
        currency: account.currency,
        balance: account.balance,
        available: account.available,
        holds: account.holds,
      })) : data),
  };
}

function parseMoney(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/,/g, '').replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function metricAmount(value) {
  if (value == null) return 0;
  if (typeof value !== 'object') return parseMoney(value);

  const direct = parseMoney(value.amount ?? value.value ?? value.val ?? value.current ?? value.balance);
  if (direct) return direct;

  for (const nested of Object.values(value)) {
    const n = metricAmount(nested);
    if (n) return n;
  }
  return 0;
}

function pickMetric(source, names) {
  if (!source) return 0;
  const keys = Object.keys(source);
  for (const name of names) {
    const key = keys.find(k => k.toLowerCase() === name.toLowerCase());
    if (!key) continue;
    return metricAmount(source[key]);
  }
  return 0;
}

function pickAccountId(accounts) {
  const list = Array.isArray(accounts)
    ? accounts
    : Array.isArray(accounts?.accounts)
      ? accounts.accounts
      : Array.isArray(accounts?.data)
        ? accounts.data
        : [];

  if (!list.length) return '';
  if (IBKR_ACCOUNT_ID) {
    const configured = list.find(account => {
      const id = account.id || account.accountId || account.account || account.acctId || account.accountVan;
      return String(id || '').trim() === IBKR_ACCOUNT_ID;
    });
    if (configured) return IBKR_ACCOUNT_ID;
  }

  const first = list[0];
  return String(first.id || first.accountId || first.account || first.acctId || first.accountVan || '').trim();
}

async function ibkrGet(path) {
  return safeFetch(`${IBKR_GATEWAY_URL}${path}`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'MAUex/1.0',
    },
  });
}

async function getIbkrStatus() {
  const tickle = await ibkrGet('/v1/api/tickle');
  const auth = await ibkrGet('/v1/api/iserver/auth/status');
  return {
    gatewayUrl: IBKR_GATEWAY_URL,
    accountId: IBKR_ACCOUNT_ID || null,
    tickle: tickle.data || tickle.raw || tickle.status,
    auth: auth.data || auth.raw || auth.status,
  };
}

async function getIbkrBalance() {
  const status = await getIbkrStatus();
  const authData = status.auth || {};
  const authenticated = authData.authenticated !== false && authData.connected !== false;
  if (!authenticated) {
    return {
      error: 'IBKR Gateway no esta autenticado. Hay que iniciar sesion en Client Portal Gateway y volver a probar.',
      status,
    };
  }

  const accountsResponse = await ibkrGet('/v1/api/portfolio/accounts');
  if (!accountsResponse.ok || !accountsResponse.data) {
    return { error: `IBKR accounts: ${accountsResponse.raw || accountsResponse.status}`, status };
  }

  const accountId = pickAccountId(accountsResponse.data);
  if (!accountId) {
    return { error: 'IBKR no devolvio ningun accountId', accounts: accountsResponse.data, status };
  }

  const encodedAccount = encodeURIComponent(accountId);
  const summaryResponse = await ibkrGet(`/v1/api/portfolio/${encodedAccount}/summary`);
  const ledgerResponse = await ibkrGet(`/v1/api/portfolio/${encodedAccount}/ledger`);
  const pnlResponse = await ibkrGet('/v1/api/iserver/account/pnl/partitioned');

  const summary = summaryResponse.data || {};
  const ledger = ledgerResponse.data || {};

  const ledgerUsd = ledger.USD || ledger.usd || {};
  const total = pickMetric(summary, [
    'netliquidation',
    'netliquidation-c',
    'equitywithloanvalue',
    'totalcashvalue',
  ]) || pickMetric(ledgerUsd, [
    'netliquidationvalue',
    'cashbalance',
    'stockmarketvalue',
  ]);

  const free = pickMetric(summary, [
    'availablefunds',
    'excessliquidity',
    'totalcashvalue',
    'settledcash',
  ]) || pickMetric(ledgerUsd, [
    'cashbalance',
    'settledcash',
  ]);

  const margin = pickMetric(summary, [
    'initmarginreq',
    'maintmarginreq',
    'fullinitmarginreq',
    'fullmaintmarginreq',
  ]);

  let pnl = pickMetric(summary, ['unrealizedpnl', 'realizedpnl']);
  if (!pnl && pnlResponse.ok && pnlResponse.data) {
    const partition = pnlResponse.data.upnl || pnlResponse.data.pnl || pnlResponse.data;
    const accountPnl = partition[accountId] || Object.values(partition).find(v => v && typeof v === 'object');
    pnl = parseMoney(accountPnl?.uPnl ?? accountPnl?.unrealizedPnL ?? accountPnl?.dailyPnL ?? accountPnl?.dpl);
  }

  const safeTotal = total || Math.max(0, free + margin);
  return {
    exchange: 'IBKR',
    accountId,
    total: round(safeTotal),
    wallet: round(safeTotal),
    free: round(free || Math.max(0, safeTotal - margin)),
    margin: round(margin),
    orders: 0,
    pnl: round(pnl),
    USDT: round(safeTotal),
    USDC: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function getIbkrDebug() {
  const status = await getIbkrStatus();
  const accountsResponse = await ibkrGet('/v1/api/portfolio/accounts');
  const accountId = pickAccountId(accountsResponse.data || {});
  const encodedAccount = accountId ? encodeURIComponent(accountId) : '';
  const summaryResponse = encodedAccount ? await ibkrGet(`/v1/api/portfolio/${encodedAccount}/summary`) : null;
  const ledgerResponse = encodedAccount ? await ibkrGet(`/v1/api/portfolio/${encodedAccount}/ledger`) : null;
  const pnlResponse = await ibkrGet('/v1/api/iserver/account/pnl/partitioned');

  return {
    status,
    accountId,
    accounts: accountsResponse?.data || accountsResponse?.raw || accountsResponse?.status,
    summary: summaryResponse?.data || summaryResponse?.raw || summaryResponse?.status,
    ledger: ledgerResponse?.data || ledgerResponse?.raw || ledgerResponse?.status,
    pnl: pnlResponse?.data || pnlResponse?.raw || pnlResponse?.status,
  };
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/health') {
      sendJson(res, {
        status: 'ok',
        service: 'mauex-binance-backend',
        hasBinanceKey: Boolean(BINANCE_KEY),
        hasKucoinKey: Boolean(KUCOIN_KEY),
        hasIbkrGateway: Boolean(IBKR_GATEWAY_URL),
      });
      return;
    }

    if (url.pathname === '/myip') {
      sendJson(res, { ip: await getPublicIp() });
      return;
    }

    if (url.pathname === '/binance-balance') {
      sendJson(res, await getBinanceBalance());
      return;
    }

    if (url.pathname === '/kucoin-balance') {
      sendJson(res, await getKucoinBalance());
      return;
    }

    if (url.pathname === '/kucoin-debug') {
      sendJson(res, await getKucoinDebug());
      return;
    }

    if (url.pathname === '/ibkr-health') {
      sendJson(res, await getIbkrStatus());
      return;
    }

    if (url.pathname === '/ibkr-balance') {
      sendJson(res, await getIbkrBalance());
      return;
    }

    if (url.pathname === '/ibkr-debug') {
      sendJson(res, await getIbkrDebug());
      return;
    }

    sendJson(res, { error: 'Not found' }, 404);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MAUex Binance backend listening on port ${PORT}`);
});
