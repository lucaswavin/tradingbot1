const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = 'https://open-api.bingx.com';

const fastAxios = axios.create({
  httpsAgent: new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    timeout: 3000
  }),
  timeout: 8000,
  headers: { 'Connection': 'keep-alive', 'Content-Type': 'application/x-www-form-urlencoded' }
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
    return urlEncode ? `${k}=${encodeURIComponent(v)}` : `${v}`;
  }).join('&');
  return str ? `${str}×tamp=${timestamp}` : `timestamp=${timestamp}`;
}

function signParams(rawParams) {
  return crypto.createHmac('sha256', API_SECRET)
    .update(rawParams)
    .digest('hex');
}

function getDecimalPlaces(tickSize) {
  const str = tickSize.toString();
  if (str.includes('.')) return str.split('.')[1].length;
  return 0;
}

function roundToTickSize(price, tickSize) {
  const decimalPlaces = getDecimalPlaces(tickSize);
  const factor = 1 / tickSize;
  const rounded = Math.round(price * factor) / factor;
  return parseFloat(rounded.toFixed(decimalPlaces));
}

// ========== CONTRATO & PRECIO ==========

async function getContractInfo(symbol) {
  const url = `${HOST}/openApi/swap/v2/quote/contracts`;
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
  throw new Error(`No se pudo obtener la información del contrato para ${symbol}`);
}

async function getCurrentPrice(symbol) {
  const url = `${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
  const res = await fastAxios.get(url);
  if (res.data?.code === 0) return parseFloat(res.data.data.price);
  throw new Error(`Precio inválido: ${JSON.stringify(res.data)}`);
}

// ========== CANCELACIÓN TP/SL ==========

async function robustCancelTPSL(symbol, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const payload = { symbol };
    const ts = Date.now();
    const raw = buildParams(payload, ts);
    const sig = signParams(raw);
    const qp = `${buildParams(payload, ts, true)}&signature=${sig}`;
    const url = `${HOST}/openApi/swap/v2/trade/stopOrder/cancelAll`;
    
    try {
      const res = await fastAxios.post(url, qp, { headers: { 'X-BX-APIKEY': API_KEY } });
      if (res.data.code === 0) {
        // Verificar que ya no queden órdenes TP/SL
        const checkTs = Date.now();
        const checkPayload = { symbol };
        const checkRaw = buildParams(checkPayload, checkTs);
        const checkSig = signParams(checkRaw);
        const checkQp = `${buildParams(checkPayload, checkTs, true)}&signature=${checkSig}`;
        const checkUrl = `${HOST}/openApi/swap/v2/trade/openOrders?${checkQp}`;
        const checkRes = await fastAxios.get(checkUrl, { headers: { 'X-BX-APIKEY': API_KEY } });
        const orders = Array.isArray(checkRes.data?.data?.orders) ? checkRes.data.data.orders : [];
        const tpsl = orders.filter(o => ['TAKE_PROFIT_MARKET', 'STOP_MARKET'].includes(o.type));
        if (tpsl.length === 0) return true; // Cancelación exitosa
      }
    } catch (e) {
      // Ignorar error y reintentar
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

// ========== POSICIONES ==========

async function checkExistingPosition(symbol, newSide) {
  const ts = Date.now();
  const raw = `timestamp=${ts}`;
  const sig = signParams(raw);
  const url = `${HOST}/openApi/swap/v2/user/positions?${raw}&signature=${sig}`;
  const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
  if (res.data?.code === 0 && Array.isArray(res.data.data)) {
    const pos = res.data.data.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
    if (pos) {
      const amt = parseFloat(pos.positionAmt);
      const side = amt > 0 ? 'LONG' : 'SHORT';
      return { exists: true, side, size: Math.abs(amt), entryPrice: parseFloat(pos.avgPrice), isReentry: side === newSide };
    }
  }
  return { exists: false, isReentry: false };
}

async function getCurrentPositionSize(symbol, positionSide) {
  const ts = Date.now();
  const raw = `timestamp=${ts}`;
  const sig = signParams(raw);
  const url = `${HOST}/openApi/swap/v2/user/positions?${raw}&signature=${sig}`;
  const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
  if (res.data?.code === 0 && Array.isArray(res.data.data)) {
    const pos = res.data.data.find(p => p.symbol === symbol);
    if (pos) {
      const amt = parseFloat(pos.positionAmt);
      const absSize = Math.abs(amt);
      const actualSide = amt > 0 ? 'LONG' : 'SHORT';
      if (actualSide === positionSide && absSize > 0) {
        return { size: absSize, side: actualSide, entryPrice: parseFloat(pos.avgPrice) };
      }
    }
  }
  return null;
}

// ========== TRAILING STOPS (CÓDIGO ORIGINAL) ==========

async function trailingStopToBE({ symbol, side, avgEntryPrice, posSide, positionSize, tickSize, trailingPercent = 1, pollMs = 4000, maxAttempts = 60 }) {
  if (!trailingPercent) return;
  console.log(`🚦 Trailing BE: Mover SL a BE si avanza ${trailingPercent}%`);
  let attempts = 0;
  const targetPrice = posSide === 'LONG' ? avgEntryPrice * (1 + trailingPercent / 100) : avgEntryPrice * (1 - trailingPercent / 100);
  
  while (++attempts <= maxAttempts) {
    await new Promise(r => setTimeout(r, pollMs));
    const price = await getCurrentPrice(symbol);
    if ((posSide === 'LONG' && price >= targetPrice) || (posSide === 'SHORT' && price <= targetPrice)) {
      await robustCancelTPSL(symbol);
      const newSL = roundToTickSize(avgEntryPrice, tickSize);
      const payload = { symbol, side: posSide === 'LONG' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', quantity: positionSize, stopPrice: newSL, workingType: 'MARK_PRICE' };
      const ts = Date.now();
      const raw = buildParams(payload, ts);
      const sig = signParams(raw);
      const qp = `${buildParams(payload, ts, true)}&signature=${sig}`;
      const slUrl = `${HOST}/openApi/swap/v2/trade/order`;
      await fastAxios.post(slUrl, qp, { headers: { 'X-BX-APIKEY': API_KEY } });
      console.log(`✅ SL movido a BE (${newSL}) tras avance de ${trailingPercent}%`);
      return true;
    }
  }
  console.log('⏳ Trailing stop BE: No se alcanzó el trigger.');
  return false;
}

async function dynamicTrailingStop({ symbol, side, avgEntryPrice, posSide, positionSize, tickSize, trailingPercent = 1, pollMs = 4000, maxAttempts = 200, minDistancePercent = 0.3 }) {
  if (!trailingPercent) return;
  console.log(`🚦 Trailing dinámico: SL sigue al precio, distancia ${minDistancePercent}%`);
  let attempts = 0;
  let extremumPrice = avgEntryPrice; // Precio más favorable (máximo para LONG, mínimo para SHORT)
  let activeSL = 0; // Se establece en el primer trigger
  
  const initialTriggerPrice = posSide === 'LONG' ? avgEntryPrice * (1 + trailingPercent / 100) : avgEntryPrice * (1 - trailingPercent / 100);

  while (++attempts <= maxAttempts) {
    await new Promise(r => setTimeout(r, pollMs));
    const price = await getCurrentPrice(symbol);

    if (posSide === 'LONG') {
      if (price > extremumPrice) extremumPrice = price;
      const newSL = roundToTickSize(extremumPrice * (1 - minDistancePercent / 100), tickSize);
      if (price >= initialTriggerPrice && newSL > activeSL) {
        await robustCancelTPSL(symbol);
        const payload = { symbol, side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', quantity: positionSize, stopPrice: newSL, workingType: 'MARK_PRICE' };
        const ts = Date.now();
        const raw = buildParams(payload, ts);
        const sig = signParams(raw);
        const qp = `${buildParams(payload, ts, true)}&signature=${sig}`;
        const slUrl = `${HOST}/openApi/swap/v2/trade/order`;
        await fastAxios.post(slUrl, qp, { headers: { 'X-BX-APIKEY': API_KEY } });
        console.log(`⏩ Trailing LONG SL actualizado: ${newSL} (precio máximo: ${extremumPrice})`);
        activeSL = newSL;
      }
    } else { // SHORT
      if (price < extremumPrice) extremumPrice = price;
      const newSL = roundToTickSize(extremumPrice * (1 + minDistancePercent / 100), tickSize);
      if (price <= initialTriggerPrice && (newSL < activeSL || activeSL === 0)) {
        await robustCancelTPSL(symbol);
        const payload = { symbol, side: 'BUY', positionSide: 'SHORT', type: 'STOP_MARKET', quantity: positionSize, stopPrice: newSL, workingType: 'MARK_PRICE' };
        const ts = Date.now();
        const raw = buildParams(payload, ts);
        const sig = signParams(raw);
        const qp = `${buildParams(payload, ts, true)}&signature=${sig}`;
        const slUrl = `${HOST}/openApi/swap/v2/trade/order`;
        await fastAxios.post(slUrl, qp, { headers: { 'X-BX-APIKEY': API_KEY } });
        console.log(`⏩ Trailing SHORT SL actualizado: ${newSL} (precio mínimo: ${extremumPrice})`);
        activeSL = newSL;
      }
    }
  }
  console.log('⏳ Trailing dinámico: finalizó el tiempo máximo.');
  return false;
}

// ========== LEVERAGE ==========

async function setLeverage(symbol, leverage = 5, side = 'LONG') {
  leverage = Math.max(1, Math.min(125, Math.round(Number(leverage))));
  const payload = { symbol, side, leverage };
  const ts = Date.now();
  const raw = buildParams(payload, ts);
  const sig = signParams(raw);
  const qp = `${buildParams(payload, ts, true)}&signature=${sig}`;
  const url = `${HOST}/openApi/swap/v2/trade/leverage`;
  await fastAxios.post(url, qp, { headers: { 'X-BX-APIKEY': API_KEY } });
}

// ========== PRINCIPAL: ORDEN UNIFICADA CON TRAILING (CORREGIDA) ==========

async function placeOrderTrailing(params) {
  const { symbol: rawSymbol, side, leverage = 5, usdtAmount = 10, type = 'MARKET', limitPrice, tpPercent, slPercent, trailingMode, trailingPercent, trailingPollMs, trailingMaxAttempts, minDistancePercent } = params;

  if (!API_KEY || !API_SECRET) throw new Error("API_KEY o API_SECRET no están configuradas.");

  const symbol = normalizeSymbol(rawSymbol);
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';

  console.log(`\n--- INICIANDO ORDEN: ${symbol} | ${posSide} | ${usdtAmount} USDT @ ${leverage}x ---`);
  
  // 1. Obtener información de contrato y precio
  const [contract, marketPrice] = await Promise.all([getContractInfo(symbol), getCurrentPrice(symbol)]);
  console.log(`Precio: ${marketPrice}, MinQty: ${contract.minOrderQty}, StepSize: ${contract.stepSize}`);

  // 2. Verificar y gestionar reentradas
  if ((await checkExistingPosition(symbol, posSide)).isReentry) {
    console.log(`🔄 REENTRADA DETECTADA. Cancelando órdenes TP/SL existentes...`);
    await robustCancelTPSL(symbol);
    console.log("Órdenes previas canceladas.");
  } else {
    console.log('🌱 Es una entrada inicial.');
  }

  // 3. Configurar apalancamiento
  await setLeverage(symbol, leverage, posSide);
  console.log(`Apalancamiento configurado a ${leverage}x.`);

  // 4. Calcular cantidad y VALIDARLA
  const quantityToOrder = parseFloat(
    (Math.floor((usdtAmount * leverage / marketPrice) / contract.stepSize) * contract.stepSize)
    .toFixed(getDecimalPlaces(contract.stepSize))
  );
  console.log(`Cantidad calculada para ordenar: ${quantityToOrder}`);

  // *** CORRECCIÓN CRÍTICA 1: VALIDAR CANTIDAD MÍNIMA ***
  if (quantityToOrder < contract.minOrderQty) {
    throw new Error(`Error de Cantidad: La cantidad calculada (${quantityToOrder}) es MENOR que la mínima permitida por el contrato (${contract.minOrderQty}). Aumente el usdtAmount o el leverage.`);
  }

  // 5. Ejecutar orden principal
  let mainPayload = { symbol, side: side.toUpperCase(), positionSide: posSide, type: type.toUpperCase(), quantity: quantityToOrder };
  if (type.toUpperCase() === 'LIMIT' && limitPrice) {
    mainPayload.price = Number(limitPrice);
  }
  const ts1 = Date.now();
  const raw1 = buildParams(mainPayload, ts1);
  const sig1 = signParams(raw1);
  const qp1 = `${buildParams(mainPayload, ts1, true)}&signature=${sig1}`;
  const mainUrl = `${HOST}/openApi/swap/v2/trade/order`;
  
  console.log('Enviando orden principal...');
  const orderResp = await fastAxios.post(mainUrl, qp1, { headers: { 'X-BX-APIKEY': API_KEY } });
  if (orderResp.data?.code !== 0) {
    throw new Error(`Error de la API al colocar la orden principal: ${orderResp.data.msg}`);
  }
  console.log('✅ Orden principal ejecutada con éxito.');

  // 6. *** CORRECCIÓN CRÍTICA 2: ESPERAR POSICIÓN CONSOLIDADA CON REINTENTOS ***
  console.log('Esperando confirmación de la posición consolidada del exchange...');
  let confirmedPosition = null;
  for (let i = 0; i < 15; i++) { // Intentar por hasta 30 segundos
    await new Promise(r => setTimeout(r, 2000));
    confirmedPosition = await getCurrentPositionSize(symbol, posSide);
    if (confirmedPosition) {
      console.log(`✅ Posición confirmada: Tamaño Total=${confirmedPosition.size}, Precio Promedio=${confirmedPosition.entryPrice}`);
      break;
    }
    console.log(`Intento ${i + 1}/15: Aún no se confirma la posición...`);
  }

  if (!confirmedPosition) {
    throw new Error("Fallo crítico: No se pudo verificar la posición para establecer TP/SL después de múltiples intentos.");
  }
  
  const { size: posQty, entryPrice: avgEntryPrice } = confirmedPosition;

  // 7. Crear TP/SL unificados basados en la posición REAL
  const sltpSide = posSide === 'LONG' ? 'SELL' : 'BUY';
  const sltpOrders = [];
  if (tpPercent > 0) {
    const multiplier = posSide === 'LONG' ? (1 + tpPercent / 100) : (1 - tpPercent / 100);
    const finalTpPrice = roundToTickSize(avgEntryPrice * multiplier, contract.tickSize);
    sltpOrders.push({ type: 'TAKE_PROFIT_MARKET', stopPrice: finalTpPrice });
  }
  if (slPercent > 0) {
    const multiplier = posSide === 'LONG' ? (1 - slPercent / 100) : (1 + slPercent / 100);
    const finalSlPrice = roundToTickSize(avgEntryPrice * multiplier, contract.tickSize);
    sltpOrders.push({ type: 'STOP_MARKET', stopPrice: finalSlPrice });
  }

  for (const order of sltpOrders) {
    const payload = { symbol, positionSide: posSide, side: sltpSide, type: order.type, quantity: posQty, stopPrice: order.stopPrice, workingType: 'MARK_PRICE' };
    const ts = Date.now();
    const raw = buildParams(payload, ts);
    const sig = signParams(raw);
    const qp = `${buildParams(payload, ts, true)}&signature=${sig}`;
    const url = `${HOST}/openApi/swap/v2/trade/order`;
    fastAxios.post(url, qp, { headers: { 'X-BX-APIKEY': API_KEY } })
      .then(res => console.log(`✅ Orden ${order.type} establecida en ${order.stopPrice}.`))
      .catch(err => console.error(`❌ Error estableciendo ${order.type}:`, err.response?.data || err.message));
  }

  // 8. Iniciar Trailing Stop (si está configurado) en segundo plano (sin await)
  if (trailingMode) {
    const trailingParams = { symbol, side, avgEntryPrice, posSide, positionSize: posQty, tickSize: contract.tickSize, trailingPercent, pollMs: trailingPollMs, maxAttempts: trailingMaxAttempts };
    if (trailingMode === 'dynamic') {
      dynamicTrailingStop({ ...trailingParams, minDistancePercent });
    } else if (trailingMode === 'be') {
      trailingStopToBE(trailingParams);
    }
  }

  console.log('--- ✅ PROCESO DE ORDEN FINALIZADO ---');
  return {
    mainOrder: orderResp.data,
    finalPosition: confirmedPosition,
    trailingActivated: !!trailingMode
  };
}

// ========== UTILIDADES EXTRA ==========

async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  const ts = Date.now();
  const raw = `timestamp=${ts}`;
  const sig = crypto.createHmac('sha256', API_SECRET).update(raw).digest('hex');
  const url = `${HOST}/openApi/swap/v2/user/balance?${raw}&signature=${sig}`;
  const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
  if (res.data.code === 0 && res.data.data?.balance) {
      return parseFloat(res.data.data.balance.balance);
  }
  throw new Error(`Formato de balance inesperado: ${JSON.stringify(res.data)}`);
}

async function closeAllPositions(symbol) {
  const sym = normalizeSymbol(symbol);
  const payload = { symbol: sym };
  const ts = Date.now();
  const raw = buildParams(payload, ts);
  const sig = signParams(raw);
  const qp = `${buildParams(payload, ts, true)}&signature=${sig}`;
  const url = `${HOST}/openApi/swap/v2/trade/closeAllPositions`;
  try {
    const res = await fastAxios.post(url, qp, { headers: { 'X-BX-APIKEY': API_KEY } });
    return res.data;
  } catch (err) {
    console.error('❌ Error closeAllPositions:', err.response?.data || err.message);
    throw err;
  }
}

// ========== LIMPIEZA Y VALIDACIÓN DE DATOS (PARA WEBHOOKS) ==========

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
  if (missing.length > 0) throw new Error(`Campos requeridos faltantes: ${missing.join(', ')}`);
  
  const validSides = ['BUY', 'SELL'];
  if (!validSides.includes(data.side?.toUpperCase())) throw new Error(`Side inválido: ${data.side}.`);
  
  if (data.leverage && (isNaN(data.leverage) || data.leverage < 1 || data.leverage > 125)) data.leverage = 5;
  if (data.tpPercent && (isNaN(data.tpPercent) || data.tpPercent <= 0)) delete data.tpPercent;
  if (data.slPercent && (isNaN(data.slPercent) || data.slPercent <= 0)) delete data.slPercent;
  
  return data;
}

// ========== EXPORT ==========

module.exports = {
  getUSDTBalance,
  placeOrder: placeOrderTrailing, // Renombrado para consistencia si se desea
  placeOrderTrailing,
  normalizeSymbol,
  setLeverage,
  getCurrentPrice,
  getContractInfo,
  closeAllPositions,
  cleanWebhookData,
  validateWebhookData,
  robustCancelTPSL,
  checkExistingPosition,
  getCurrentPositionSize,
  trailingStopToBE,
  dynamicTrailingStop,
  roundToTickSize
};


