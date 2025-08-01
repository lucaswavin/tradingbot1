const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = 'open-api.bingx.com';

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

// Ordena y arma los params (para firma/query)
function buildParams(payload, timestamp, urlEncode = false) {
  const clone = { ...payload };
  const keys = Object.keys(clone).sort();
  let str = keys.map(k => {
    const v = typeof clone[k] === 'object' ? JSON.stringify(clone[k]) : clone[k];
    return urlEncode ? `${k}=${encodeURIComponent(v)}` : `${k}=${v}`;
  }).join('&');
  return str ? `${str}&timestamp=${timestamp}` : `timestamp=${timestamp}`;
}

function signParams(rawParams) {
  return crypto.createHmac('sha256', API_SECRET)
    .update(rawParams)
    .digest('hex');
}

async function setLeverage(symbol, leverage = 5, side = 'LONG') {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  const payload = { symbol, side, leverage };
  const ts = Date.now();
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${qp}`;

  try {
    const resp = await fastAxios.get(url, {
      headers: { 'X-BX-APIKEY': API_KEY }
    });
    console.log(`🔧 Leverage ${leverage}x establecido para ${symbol} (${side})`);
    return resp.data;
  } catch (err) {
    console.error('❌ Error setLeverage:', err.response?.data || err.message);
    throw err;
  }
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

// ORDEN PRINCIPAL + TP/SL (crea 3 órdenes independientes)
async function placeOrderInternal({
  symbol,
  side,
  leverage = 5,
  usdtAmount = 1,
  type = 'MARKET',
  limitPrice,
  tpPercent,
  slPercent,
  takeProfit,
  stopLoss,
  trailingPercent
}) {
  symbol = normalizeSymbol(symbol);
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  // 1. Leverage
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  await setLeverage(symbol, leverage, posSide);

  // 2. Precio y cantidad
  const price = await getCurrentPrice(symbol);
  const contract = await getContractInfo(symbol);
  let quantity = Math.max(contract.minOrderQty,
    Math.round((usdtAmount * leverage / price) / contract.stepSize) * contract.stepSize
  );
  quantity = Number(quantity.toFixed(6));

  // 3. Calcular TP/SL (precio)
  let finalTP, finalSL;
  if (takeProfit) {
    finalTP = Number(takeProfit);
  } else if (tpPercent) {
    finalTP = side.toUpperCase() === 'BUY'
      ? Number((price * (1 + Number(tpPercent) / 100)).toFixed(6))
      : Number((price * (1 - Number(tpPercent) / 100)).toFixed(6));
  }
  if (stopLoss) {
    finalSL = Number(stopLoss);
  } else if (slPercent) {
    finalSL = side.toUpperCase() === 'BUY'
      ? Number((price * (1 - Number(slPercent) / 100)).toFixed(6))
      : Number((price * (1 + Number(slPercent) / 100)).toFixed(6));
  }

  // 4. Orden principal
  let mainPayload = {
    symbol,
    side: side.toUpperCase(),
    positionSide: posSide,
    type: type.toUpperCase(),
    quantity
  };
  if (type.toUpperCase() === 'LIMIT' && limitPrice) {
    mainPayload.price = Number(limitPrice);
    mainPayload.timeInForce = 'GTC';
  }

  // --- Enviar orden principal ---
  const ts1 = Date.now();
  const raw1 = buildParams(mainPayload, ts1, false);
  const sig1 = signParams(raw1);
  const qp1 = buildParams(mainPayload, ts1, true) + `&signature=${sig1}`;
  const mainUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp1}`;

  let orderResp;
  try {
    console.log('🚀 Ejecutando orden principal:', mainPayload);
    orderResp = await fastAxios.post(mainUrl, null, {
      headers: { 'X-BX-APIKEY': API_KEY }
    });
    console.log('📨 Respuesta orden principal:', orderResp.data);
    if (orderResp.data?.code !== 0) {
      throw new Error(`Error en orden principal: ${orderResp.data?.msg || 'Sin detalle'}`);
    }
  } catch (err) {
    console.error('❌ Error orden principal:', err.response?.data || err.message);
    throw err;
  }

  // 5. TP (TAKE_PROFIT_MARKET)
  let tpOrder = null;
  if (finalTP) {
    const tpPayload = {
      symbol,
      side: side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY',
      positionSide: posSide,
      type: 'TAKE_PROFIT_MARKET',
      quantity,
      stopPrice: finalTP,
      workingType: 'MARK_PRICE'
    };
    const ts2 = Date.now();
    const raw2 = buildParams(tpPayload, ts2, false);
    const sig2 = signParams(raw2);
    const qp2 = buildParams(tpPayload, ts2, true) + `&signature=${sig2}`;
    const tpUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp2}`;
    try {
      tpOrder = await fastAxios.post(tpUrl, null, { headers: { 'X-BX-APIKEY': API_KEY } });
      console.log('✅ Take Profit colocado:', finalTP);
    } catch (e) {
      console.error('❌ Error colocando Take Profit:', e.response?.data || e.message);
      tpOrder = { data: { code: -1, msg: e.message } };
    }
  }

  // 6. SL (STOP_MARKET)
  let slOrder = null;
  if (finalSL) {
    const slPayload = {
      symbol,
      side: side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY',
      positionSide: posSide,
      type: 'STOP_MARKET',
      quantity,
      stopPrice: finalSL,
      workingType: 'MARK_PRICE'
    };
    const ts3 = Date.now();
    const raw3 = buildParams(slPayload, ts3, false);
    const sig3 = signParams(raw3);
    const qp3 = buildParams(slPayload, ts3, true) + `&signature=${sig3}`;
    const slUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp3}`;
    try {
      slOrder = await fastAxios.post(slUrl, null, { headers: { 'X-BX-APIKEY': API_KEY } });
      console.log('✅ Stop Loss colocado:', finalSL);
    } catch (e) {
      console.error('❌ Error colocando Stop Loss:', e.response?.data || e.message);
      slOrder = { data: { code: -1, msg: e.message } };
    }
  }

  // 7. Resultado final
  return {
    mainOrder: orderResp.data,
    tpOrder: tpOrder ? tpOrder.data : null,
    slOrder: slOrder ? slOrder.data : null,
    summary: {
      mainSuccess: orderResp.data?.code === 0,
      tpSuccess: tpOrder ? tpOrder.data?.code === 0 : null,
      slSuccess: slOrder ? slOrder.data?.code === 0 : null,
      executedPrice: price,
      executedQuantity: quantity
    }
  };
}

// Retry inteligente por minNotional
async function placeOrderWithSmartRetry(params) {
  const { symbol, side, leverage = 5, usdtAmount = 1, ...rest } = params;
  const sym = normalizeSymbol(symbol);

  let result = await placeOrderInternal({
    symbol: sym, side, leverage, usdtAmount, ...rest
  });

  if (result.mainOrder?.code === 0) return result;

  // Retry solo si error es por cantidad mínima
  const msg = result.mainOrder?.msg || '';
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
    const retryAmt = Math.ceil(minUSDT * 1.2 * 100) / 100;
    result = await placeOrderInternal({
      symbol: sym, side, leverage, usdtAmount: retryAmt, ...rest
    });
  }

  return result;
}

// Función principal exportada
async function placeOrder(params) {
  return placeOrderWithSmartRetry(params);
}

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


