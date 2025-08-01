const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = 'open-api.bingx.com';

const fastAxios = axios.create({
  httpsAgent: new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    timeout: 3000
  }),
  timeout: 8000,
  headers: { 'Connection': 'keep-alive' }
});

// ========== UTILS ==========
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  let base = symbol.replace(/\.P$/, '');
  if (base.endsWith('USDT') && !base.includes('-')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  return base;
}

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

function getDecimalPlaces(tickSize) {
  const str = tickSize.toExponential();
  if (str.includes('e-')) {
    const exp = parseInt(str.split('e-')[1]);
    return exp + (str.split('e-')[0].split('.')[1]?.length || 0) - 1;
  }
  const normalStr = tickSize.toString();
  if (normalStr.includes('.')) return normalStr.split('.')[1].length;
  return 0;
}

function roundToTickSize(price, tickSize) {
  const factor = 1 / tickSize;
  const rounded = Math.round((price + Number.EPSILON) * factor) / factor;
  const dp = getDecimalPlaces(tickSize);
  return parseFloat(rounded.toFixed(dp));
}

// ========== CONTRATO & PRECIO ==========

async function getContractInfo(symbol) {
  const url = `https://${HOST}/openApi/swap/v2/quote/contracts`;
  const res = await fastAxios.get(url);
  if (res.data?.code === 0) {
    const c = res.data.data.find(x => x.symbol === symbol);
    if (c) return {
      minOrderQty: parseFloat(c.minOrderQty),
      tickSize: parseFloat(c.tickSize),
      stepSize: parseFloat(c.stepSize),
      minNotional: parseFloat(c.minNotional),
      maxLeverage: parseInt(c.maxLeverage)
    };
  }
  // Defaults ultra-safe
  return { minOrderQty: 0.001, tickSize: 0.0001, stepSize: 0.001, minNotional: 1, maxLeverage: 20 };
}

async function getCurrentPrice(symbol) {
  const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
  const res = await fastAxios.get(url);
  if (res.data?.code === 0) return parseFloat(res.data.data.price);
  throw new Error(`Precio inválido: ${JSON.stringify(res.data)}`);
}

// ========== CANCELACIÓN TP/SL ==========

async function robustCancelTPSL(symbol, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    await cancelAllTPSLOrders(symbol);
    // Chequear si queda alguno
    const ts = Date.now();
    const payload = { symbol };
    const raw = buildParams(payload, ts, false);
    const sig = signParams(raw);
    const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
    const url = `https://${HOST}/openApi/swap/v2/trade/openOrders?${qp}`;
    const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
    const orders = Array.isArray(res.data?.data) ? res.data.data : [];
    const tpsl = orders.filter(o => ['TAKE_PROFIT_MARKET','STOP_MARKET'].includes(o.type));
    if (tpsl.length === 0) return true;
    await new Promise(r => setTimeout(r, 1800));
  }
  return false;
}

async function cancelAllTPSLOrders(symbol) {
  const ts = Date.now();
  const payload = { symbol };
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/trade/openOrders?${qp}`;
  const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
  const orders = Array.isArray(res.data?.data) ? res.data.data : [];
  const tpslOrders = orders.filter(o => ['TAKE_PROFIT_MARKET','STOP_MARKET'].includes(o.type));
  for (const order of tpslOrders) {
    try {
      const cancelPayload = { symbol, orderId: order.orderId };
      const cancelTs = Date.now();
      const cancelRaw = buildParams(cancelPayload, cancelTs, false);
      const cancelSig = signParams(cancelRaw);
      const cancelQp = buildParams(cancelPayload, cancelTs, true) + `&signature=${cancelSig}`;
      const cancelUrl = `https://${HOST}/openApi/swap/v2/trade/order?${cancelQp}`;
      await fastAxios.delete(cancelUrl, { headers: { 'X-BX-APIKEY': API_KEY } });
    } catch (e) { }
  }
  return tpslOrders.length;
}

// ========== POSICIONES ==========

async function checkExistingPosition(symbol, newSide) {
  const payload = { symbol };
  const ts = Date.now();
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/user/positions?${qp}`;
  const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
  if (res.data?.code === 0 && res.data.data) {
    const positions = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
    const pos = positions.find(p => p.symbol === symbol);
    if (pos && parseFloat(pos.positionAmt) !== 0) {
      const amt = parseFloat(pos.positionAmt);
      const side = amt > 0 ? 'LONG' : 'SHORT';
      return { exists: true, side, size: Math.abs(amt), entryPrice: parseFloat(pos.entryPrice), isReentry: side === newSide, data: pos };
    }
  }
  return { exists: false, isReentry: false };
}

async function getCurrentPositionSize(symbol, positionSide) {
  const payload = { symbol };
  const ts = Date.now();
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/user/positions?${qp}`;
  const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
  if (res.data?.code === 0 && res.data.data) {
    const positions = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
    const pos = positions.find(p => p.symbol === symbol);
    if (pos) {
      const amt = parseFloat(pos.positionAmt);
      const absSize = Math.abs(amt);
      const actualSide = amt > 0 ? 'LONG' : 'SHORT';
      if (actualSide === positionSide) {
        return { size: absSize, side: actualSide, entryPrice: parseFloat(pos.entryPrice), positionAmt: amt };
      }
    }
  }
  return null;
}

// ========== TRAILING STOP A BREAKEVEN ==========

async function trailingStopToBE({
  symbol,
  side,
  avgEntryPrice,
  posSide,
  positionSize,
  tickSize,
  trailingPercent = 1,
  pollMs = 4000,
  maxAttempts = 60
}) {
  console.log(`🚦 Trailing activado: mover SL a BE si se avanza ${trailingPercent}%`);
  let attempts = 0;
  const targetPrice = posSide === 'LONG'
    ? avgEntryPrice * (1 + trailingPercent/100)
    : avgEntryPrice * (1 - trailingPercent/100);
  while (++attempts <= maxAttempts) {
    await new Promise(r => setTimeout(r, pollMs));
    const price = await getCurrentPrice(symbol);
    if ((posSide === 'LONG' && price >= targetPrice) || (posSide === 'SHORT' && price <= targetPrice)) {
      // Sube SL a BE
      await robustCancelTPSL(symbol, 2);
      // Crear nuevo SL al precio de entrada promedio
      const newSL = roundToTickSize(avgEntryPrice, tickSize);
      const size = positionSize;
      const payload = {
        symbol,
        side: posSide === 'LONG' ? 'SELL' : 'BUY',
        positionSide: posSide,
        type: 'STOP_MARKET',
        quantity: size,
        stopPrice: newSL,
        workingType: 'MARK_PRICE'
      };
      const ts = Date.now();
      const raw = buildParams(payload, ts, false);
      const sig = signParams(raw);
      const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
      const slUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp}`;
      await fastAxios.post(slUrl, null, { headers: { 'X-BX-APIKEY': API_KEY } });
      console.log(`✅ SL movido a BE (${newSL}) tras avance de ${trailingPercent}%`);
      return true;
    }
  }
  console.log('⏳ Trailing stop: No se alcanzó el trigger en el tiempo definido');
  return false;
}

// ========== LEVERAGE ==========

async function setLeverage(symbol, leverage = 5, side = 'LONG') {
  leverage = Math.max(1, Math.min(125, Number(leverage)));
  const payload = { symbol, side, leverage };
  const ts = Date.now();
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${qp}`;
  await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
}

// ========== PRINCIPAL: ORDEN UNIFICADA CON TRAILING ==========

async function placeOrderTrailing(params) {
  const {
    symbol: rawSymbol,
    side,
    leverage = 5,
    usdtAmount = 10,
    type = 'MARKET',
    limitPrice,
    tpPercent,
    slPercent,
    tpPrice,
    slPrice,
    takeProfit,
    stopLoss,
    quantity
  } = params;

  const symbol = normalizeSymbol(rawSymbol);
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';

  // 1. Verificar posición y reentradas
  const existingPosition = await checkExistingPosition(symbol, posSide);

  // 2. Cancelar todos los TP/SL si hay reentrada
  if (existingPosition.exists && existingPosition.isReentry) {
    await robustCancelTPSL(symbol, 3);
  }

  // 3. Configurar leverage
  await setLeverage(symbol, leverage, posSide);

  // 4. Precio y contrato
  const marketPrice = await getCurrentPrice(symbol);
  const contract = await getContractInfo(symbol);

  // 5. Cantidad
  let finalQuantity;
  if (quantity && !isNaN(parseFloat(quantity))) {
    finalQuantity = parseFloat(quantity);
  } else {
    finalQuantity = Math.max(
      contract.minOrderQty,
      Math.round((usdtAmount * leverage / marketPrice) / contract.stepSize) * contract.stepSize
    );
  }
  finalQuantity = Number(finalQuantity.toFixed(6));

  // 6. Ejecutar orden principal
  let mainPayload = {
    symbol,
    side: side.toUpperCase(),
    positionSide: posSide,
    type: type.toUpperCase(),
    quantity: finalQuantity
  };
  if (type.toUpperCase() === 'LIMIT' && limitPrice) {
    mainPayload.price = Number(limitPrice);
    mainPayload.timeInForce = 'GTC';
  }
  const ts1 = Date.now();
  const raw1 = buildParams(mainPayload, ts1, false);
  const sig1 = signParams(raw1);
  const qp1 = buildParams(mainPayload, ts1, true) + `&signature=${sig1}`;
  const mainUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp1}`;
  const orderResp = await fastAxios.post(mainUrl, null, { headers: { 'X-BX-APIKEY': API_KEY } });

  // 7. Precio de entrada promediado
  let newExecutionPrice = marketPrice;
  let newExecutedQuantity = finalQuantity;
  if (orderResp.data?.data?.order?.avgPrice && parseFloat(orderResp.data.data.order.avgPrice) > 0) {
    newExecutionPrice = parseFloat(orderResp.data.data.order.avgPrice);
    newExecutedQuantity = parseFloat(orderResp.data.data.order.executedQty) || finalQuantity;
  }

  // 8. Calcular precio promedio (reentrada)
  let avgEntryPrice, totalQuantity;
  if (existingPosition.exists && existingPosition.isReentry) {
    const existingValue = existingPosition.size * existingPosition.entryPrice;
    const newValue = newExecutedQuantity * newExecutionPrice;
    totalQuantity = existingPosition.size + newExecutedQuantity;
    avgEntryPrice = (existingValue + newValue) / totalQuantity;
  } else {
    avgEntryPrice = newExecutionPrice;
    totalQuantity = newExecutedQuantity;
  }

  // 9. Crear TP/SL unificados
  let finalTpPrice, finalSlPrice;
  if (tpPrice) {
    finalTpPrice = roundToTickSize(parseFloat(tpPrice), contract.tickSize);
  } else if (takeProfit) {
    finalTpPrice = roundToTickSize(parseFloat(takeProfit), contract.tickSize);
  } else if (tpPercent) {
    const multiplier = posSide === 'LONG' ? (1 + tpPercent / 100) : (1 - tpPercent / 100);
    finalTpPrice = roundToTickSize(avgEntryPrice * multiplier, contract.tickSize);
  }
  if (slPrice) {
    finalSlPrice = roundToTickSize(parseFloat(slPrice), contract.tickSize);
  } else if (stopLoss) {
    finalSlPrice = roundToTickSize(parseFloat(stopLoss), contract.tickSize);
  } else if (slPercent) {
    const multiplier = posSide === 'LONG' ? (1 - slPercent / 100) : (1 + slPercent / 100);
    finalSlPrice = roundToTickSize(avgEntryPrice * multiplier, contract.tickSize);
  }

  // Obtenemos la posición real (ya unificada) para TP/SL
  await new Promise(r => setTimeout(r, 5000));
  let realPosition = await getCurrentPositionSize(symbol, posSide);
  let posQty = (realPosition && realPosition.size) ? realPosition.size : totalQuantity;

  // === TP ===
  if (finalTpPrice) {
    const tpPayload = {
      symbol,
      side: posSide === 'LONG' ? 'SELL' : 'BUY',
      positionSide: posSide,
      type: 'TAKE_PROFIT_MARKET',
      quantity: posQty,
      stopPrice: finalTpPrice,
      workingType: 'MARK_PRICE'
    };
    const ts = Date.now();
    const raw = buildParams(tpPayload, ts, false);
    const sig = signParams(raw);
    const qp = buildParams(tpPayload, ts, true) + `&signature=${sig}`;
    const tpUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp}`;
    await fastAxios.post(tpUrl, null, { headers: { 'X-BX-APIKEY': API_KEY } });
  }
  // === SL ===
  if (finalSlPrice) {
    const slPayload = {
      symbol,
      side: posSide === 'LONG' ? 'SELL' : 'BUY',
      positionSide: posSide,
      type: 'STOP_MARKET',
      quantity: posQty,
      stopPrice: finalSlPrice,
      workingType: 'MARK_PRICE'
    };
    const ts = Date.now();
    const raw = buildParams(slPayload, ts, false);
    const sig = signParams(raw);
    const qp = buildParams(slPayload, ts, true) + `&signature=${sig}`;
    const slUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp}`;
    await fastAxios.post(slUrl, null, { headers: { 'X-BX-APIKEY': API_KEY } });
  }

  // === TRAILING SL A BE ===
  if (params.enableTrailing || true) {
    await trailingStopToBE({
      symbol,
      side,
      avgEntryPrice,
      posSide,
      positionSize: posQty,
      tickSize: contract.tickSize,
      trailingPercent: 1, // 1%
      pollMs: 3500,
      maxAttempts: 150
    });
  }

  // === RESPUESTA/LOGS ===
  console.log('✅ ORDEN FINALIZADA con trailing a BE si fue necesario');
  return {
    mainOrder: orderResp.data,
    avgEntryPrice,
    totalQuantity: posQty,
    trailingActivated: true
  };
}

// ========== UTILIDADES EXTRA ==========
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

// ========== LIMPIEZA DE DATOS ==========
function cleanWebhookData(rawData) {
  const cleanData = {};
  const processedKeys = new Set();
  for (const [key, value] of Object.entries(rawData)) {
    if (!processedKeys.has(key)) {
      cleanData[key] = value;
      processedKeys.add(key);
    }
  }
  return cleanData;
}

function validateWebhookData(data) {
  const required = ['symbol', 'side'];
  const missing = required.filter(field => !data[field]);
  if (missing.length > 0) {
    throw new Error(`Campos requeridos faltantes: ${missing.join(', ')}`);
  }
  const validSides = ['BUY', 'SELL', 'LONG', 'SHORT'];
  if (!validSides.includes(data.side?.toUpperCase())) {
    throw new Error(`Side inválido: ${data.side}. Debe ser uno de: ${validSides.join(', ')}`);
  }
  if (data.leverage && (isNaN(data.leverage) || data.leverage < 1 || data.leverage > 125)) {
    data.leverage = 5;
  }
  if (data.tpPercent && (isNaN(data.tpPercent) || data.tpPercent <= 0)) {
    delete data.tpPercent;
  }
  if (data.slPercent && (isNaN(data.slPercent) || data.slPercent <= 0)) {
    delete data.slPercent;
  }
  return data;
}

// ========== EXPORT ==========
module.exports = {
  getUSDTBalance,
  placeOrderTrailing,
  normalizeSymbol,
  setLeverage,
  getCurrentPrice,
  getContractInfo,
  closeAllPositions,
  cleanWebhookData,
  validateWebhookData,
  cancelAllTPSLOrders,
  robustCancelTPSL,
  checkExistingPosition,
  getCurrentPositionSize,
  trailingStopToBE,
  roundToTickSize
};
