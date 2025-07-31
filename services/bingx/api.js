const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = 'open-api.bingx.com';

// 🔧 Conexión HTTP optimizada
const ultraFastAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 25,
  timeout: 2000,
  freeSocketTimeout: 4000
});

const fastAxios = axios.create({
  httpsAgent: ultraFastAgent,
  timeout: 5000,
  headers: {
    'Connection': 'keep-alive',
    'Content-Type': 'application/json'
  }
});

console.log('🔑 BingX API Keys configuradas:', {
  apiKey: API_KEY ? `${API_KEY.substring(0, 8)}...` : 'NO CONFIGURADA',
  secret: API_SECRET ? `${API_SECRET.substring(0, 8)}...` : 'NO CONFIGURADA'
});

// Normaliza símbolos (BTCUSDT -> BTC-USDT)
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  let base = symbol.replace(/\.P$/, '');
  if (base.endsWith('USDT') && !base.includes('-')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  return base;
}

// Construye y firma parámetros (orden alfabético + timestamp)
function buildParams(payload, timestamp, urlEncode = false) {
  const clone = { ...payload };
  delete clone.timestamp;
  const keys = Object.keys(clone).sort();
  let str = keys.map(k => {
    const v = typeof clone[k] === 'object' ? JSON.stringify(clone[k]) : clone[k];
    return urlEncode ? `${k}=${encodeURIComponent(v)}` : `${k}=${v}`;
  }).join('&');
  str = str ? `${str}&timestamp=${timestamp}` : `timestamp=${timestamp}`;
  return str;
}

function signParams(rawParams) {
  return crypto.createHmac('sha256', API_SECRET)
               .update(rawParams)
               .digest('hex');
}

async function setLeverage(symbol, leverage = 5) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  const payload = { symbol, side: 'LONG', leverage };
  const ts = Date.now();

  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true);
  const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${qp}&signature=${sig}`;

  const resp = await fastAxios.get(url, {
    headers: { 'X-BX-APIKEY': API_KEY }
  });
  return resp.data;
}

async function getCurrentPrice(symbol) {
  const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
  const res = await fastAxios.get(url);
  if (res.data?.code === 0) return parseFloat(res.data.data.price);
  throw new Error(`Precio inválido: ${JSON.stringify(res.data)}`);
}

async function getContractInfo(symbol) {
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/contracts`;
    const res = await fastAxios.get(url);
    if (res.data?.code === 0) {
      const c = res.data.data.find(x => x.symbol === symbol);
      if (c) {
        return {
          minOrderQty: parseFloat(c.minOrderQty || '0.001'),
          tickSize:    parseFloat(c.tickSize    || '0.01'),
          stepSize:    parseFloat(c.stepSize    || '0.001'),
          minNotional: parseFloat(c.minNotional || '1')
        };
      }
    }
  } catch {}
  return { minOrderQty:0.001, tickSize:0.01, stepSize:0.001, minNotional:1 };
}

async function placeOrderInternal({ symbol, side, leverage, usdtAmount }) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  await setLeverage(symbol, leverage);
  const price = await getCurrentPrice(symbol);
  let qty = Math.max(0.001, Math.round((usdtAmount * leverage / price) * 1000) / 1000);

  const payload = {
    symbol,
    side: side.toUpperCase(),
    positionSide: side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
    type: 'MARKET',
    quantity: qty
  };

  const ts = Date.now();
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true);
  const url = `https://${HOST}/openApi/swap/v2/trade/order?${qp}&signature=${sig}`;

  const res = await fastAxios.post(url, null, {
    headers: { 'X-BX-APIKEY': API_KEY }
  });
  return res.data;
}

async function placeOrderWithSmartRetry({ symbol, side, leverage = 5 }) {
  const sym = normalizeSymbol(symbol);
  let result = await placeOrderInternal({ symbol: sym, side, leverage, usdtAmount: 1 });
  if (result.code === 0) return result;

  const msg = result.msg || result.message || '';
  if (/min|min notional|insufficient/.test(msg.toLowerCase())) {
    const match = msg.match(/([\d.]+)\s+([A-Z]+)/);
    let minUSDT;
    if (match) {
      const [_, qty, asset] = match;
      minUSDT = parseFloat(qty) * await getCurrentPrice(sym);
    }
    if (!minUSDT) {
      const info = await getContractInfo(sym);
      minUSDT = info.minNotional;
    }
    const retryAmt = Math.ceil(minUSDT * 1.1 * 100) / 100;
    result = await placeOrderInternal({ symbol: sym, side, leverage, usdtAmount: retryAmt });
  }
  return result;
}

async function placeOrder(params) {
  return placeOrderWithSmartRetry(params);
}

async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  const ts = Date.now();
  const raw = `timestamp=${ts}`;
  const sig = crypto.createHmac('sha256', API_SECRET).update(raw).digest('hex');
  const url = `https://${HOST}/openApi/swap/v2/user/balance?${raw}&signature=${sig}`;
  const res = await fastAxios.get(url, { headers:{ 'X-BX-APIKEY':API_KEY }});
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (data.code === 0) {
    if (Array.isArray(data.data)) {
      const u = data.data.find(x=>x.asset==='USDT');
      return parseFloat(u?.balance||0);
    }
    if (data.data.balance?.balance) return parseFloat(data.data.balance.balance);
  }
  throw new Error(`Formato inesperado: ${JSON.stringify(data)}`);
}

async function closeAllPositions(symbol) {
  const ts = Date.now();
  const sym = normalizeSymbol(symbol);
  const payload = { symbol: sym, side: 'BOTH', type: 'MARKET' };
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true);
  const url = `https://${HOST}/openApi/swap/v2/trade/closeAllPositions?${qp}&signature=${sig}`;
  const res = await fastAxios.post(url, null, { headers:{ 'X-BX-APIKEY':API_KEY }});
  return res.data;
}

module.exports = {
  getUSDTBalance,
  placeOrder,
  normalizeSymbol,
  setLeverage,
  getCurrentPrice,
  closeAllPositions,
  getContractInfo
};

