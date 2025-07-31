const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = 'open-api.bingx.com';

// Pool HTTP rápido
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
    'Connection': 'keep-alive'
  }
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

// Construye parámetros ordenados + timestamp
function buildParams(payload, timestamp, urlEncode = false) {
  const clone = { ...payload };
  const keys = Object.keys(clone).sort();
  let str = keys.map(k => {
    const v = typeof clone[k] === 'object' ? JSON.stringify(clone[k]) : clone[k];
    return urlEncode ? `${k}=${encodeURIComponent(v)}` : `${k}=${v}`;
  }).join('&');
  return str ? `${str}&timestamp=${timestamp}` : `timestamp=${timestamp}`;
}

// Firma la query
function signParams(rawParams) {
  return crypto.createHmac('sha256', API_SECRET)
               .update(rawParams)
               .digest('hex');
}

// Establece leverage (GET, firmado)
async function setLeverage(symbol, leverage = 5, side = 'LONG') {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  const payload = { symbol, side, leverage };
  const ts = Date.now();
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${qp}`;

  const resp = await fastAxios.get(url, {
    headers: { 'X-BX-APIKEY': API_KEY }
  });
  return resp.data;
}

// Precio de mercado actual
async function getCurrentPrice(symbol) {
  const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
  const res = await fastAxios.get(url);
  if (res.data?.code === 0) return parseFloat(res.data.data.price);
  throw new Error(`Precio inválido: ${JSON.stringify(res.data)}`);
}

// Detalles del contrato (minNotional, etc)
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

// -------- ORDEN CORRECTA --------
async function placeOrderInternal({
  symbol,
  side,
  leverage = 5,
  usdtAmount = 1,
  type = 'MARKET',
  limitPrice,         // para LIMIT
  tpPercent,          // TP %
  slPercent,          // SL %
  tpPrice,            // TP absoluto
  slPrice,            // SL absoluto
  trailingPercent     // Trailing en %
}) {
  symbol = normalizeSymbol(symbol);

  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  // 1) Establece leverage
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  await setLeverage(symbol, leverage, posSide);

  // 2) Precio actual
  const price = await getCurrentPrice(symbol);

  // 3) Cantidad (ajustando a múltiplos de stepSize)
  const contract = await getContractInfo(symbol);
  let quantity = Math.max(contract.minOrderQty,
    Math.round((usdtAmount * leverage / price) / contract.stepSize) * contract.stepSize
  );
  quantity = Number(quantity.toFixed(3));

  // 4) Cálculo de TP/SL en precio si se pasan porcentajes
  let takeProfit, stopLoss;
  if (tpPrice) {
    takeProfit = Number(tpPrice);
  } else if (tpPercent) {
    takeProfit = side.toUpperCase() === 'BUY'
      ? +(price * (1 + Number(tpPercent)/100)).toFixed(6)
      : +(price * (1 - Number(tpPercent)/100)).toFixed(6);
  }
  if (slPrice) {
    stopLoss = Number(slPrice);
  } else if (slPercent) {
    stopLoss = side.toUpperCase() === 'BUY'
      ? +(price * (1 - Number(slPercent)/100)).toFixed(6)
      : +(price * (1 + Number(slPercent)/100)).toFixed(6);
  }

  // 5) Construir payload según tipo de orden
  let payload = {
    symbol,
    side: side.toUpperCase(),
    positionSide: posSide,
    type: type.toUpperCase(),
    quantity
  };

  // LIMIT: requiere price
  if (type.toUpperCase() === 'LIMIT' && limitPrice) {
    payload.price = Number(limitPrice);
    payload.timeInForce = 'GTC';
  }

  // Añadir TP/SL si se han calculado
  if (takeProfit) payload.takeProfit = takeProfit.toString();
  if (stopLoss) payload.stopLoss = stopLoss.toString();

  // Trailing stop (BingX requiere parámetro adicional, consultar docs)
  if (trailingPercent) {
    // Trailing stop market (ejemplo)
    payload.trailingStop = {
      type: "TRAILING_STOP_MARKET",
      callbackRate: Number(trailingPercent),
      workingType: "MARK_PRICE"
    };
  }

  // 6) Firma y query
  const ts = Date.now();
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/trade/order?${qp}`;

  // 7) POST con body null (BingX exige query, NO body)
  try {
    console.log('🚀 placeOrderInternal =>', JSON.stringify({
      symbol, side, leverage, usdtAmount, type, limitPrice, tpPercent, slPercent, tpPrice, slPrice, trailingPercent
    }, null, 2));
    console.log('📋 Orden (payload/query):', payload);
    console.log('🔗 URL:', url);
    const res = await fastAxios.post(url, null, {
      headers: { 'X-BX-APIKEY': API_KEY }
    });
    console.log('📨 BingX response:', res.data);
    return res.data;
  } catch (err) {
    console.error('❌ Error placeOrderInternal:', err.response?.data || err.message);
    throw err;
  }
}

// Retry mínimo inteligente
async function placeOrderWithSmartRetry(params) {
  const {
    symbol, side, leverage = 5, usdtAmount = 1, ...rest
  } = params;
  const sym = normalizeSymbol(symbol);
  let result = await placeOrderInternal({ symbol: sym, side, leverage, usdtAmount, ...rest });
  if (result.code === 0) return result;

  const msg = result.msg || result.message || '';
  if (/min|min notional|insufficient/.test(msg.toLowerCase())) {
    let minUSDT;
    const m = msg.match(/([\d.]+)\s+([A-Z]+)/);
    if (m) {
      const [, q] = m;
      minUSDT = parseFloat(q) * await getCurrentPrice(sym);
    }
    if (!minUSDT) {
      const info = await getContractInfo(sym);
      minUSDT = info.minNotional;
    }
    const retryAmt = Math.ceil(minUSDT * 1.1 * 100) / 100;
    result = await placeOrderInternal({ symbol: sym, side, leverage, usdtAmount: retryAmt, ...rest });
  }
  return result;
}

// Expone función principal que recibe todos los params opcionales
async function placeOrder(params) {
  return placeOrderWithSmartRetry(params);
}

// Balance USDT
async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  const ts = Date.now();
  const raw = `timestamp=${ts}`;
  const sig = crypto.createHmac('sha256', API_SECRET).update(raw).digest('hex');
  const url = `https://${HOST}/openApi/swap/v2/user/balance?${raw}&signature=${sig}`;
  const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (data.code === 0) {
    if (Array.isArray(data.data)) {
      const u = data.data.find(x => x.asset === 'USDT');
      return parseFloat(u?.balance || 0);
    }
    if (data.data.balance?.balance) return parseFloat(data.data.balance.balance);
  }
  throw new Error(`Formato inesperado: ${JSON.stringify(data)}`);
}

// Cierra todas posiciones (POST body null, todo en query)
async function closeAllPositions(symbol) {
  const ts = Date.now();
  const sym = normalizeSymbol(symbol);
  const payload = { symbol: sym, side: 'BOTH', type: 'MARKET' };
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/trade/closeAllPositions?${qp}`;
  try {
    const res = await fastAxios.post(url, null, { headers: { 'X-BX-APIKEY': API_KEY } });
    return res.data;
  } catch (err) {
    console.error('❌ Error closeAllPositions:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  getUSDTBalance,
  placeOrder,
  normalizeSymbol,
  setLeverage,
  getCurrentPrice,
  getContractInfo,
  closeAllPositions
};



