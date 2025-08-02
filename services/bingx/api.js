// --- DEPENDENCIAS Y CONFIGURACIÓN INICIAL ---
require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = 'https://open-api.bingx.com';

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
  timeout: 8000,
  headers: {
    'Connection': 'keep-alive',
    'Content-Type': 'application/x-www-form-urlencoded' // Header por defecto para peticiones POST
  }
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

function buildParams(payload, timestamp) {
  const clone = { ...payload };
  const keys = Object.keys(clone).sort();
  return keys.map(k => `${k}=${clone[k]}`).join('&') + `×tamp=${timestamp}`;
}

function buildQueryString(payload, timestamp) {
    const clone = { ...payload };
    const keys = Object.keys(clone).sort();
    return keys.map(k => `${k}=${encodeURIComponent(clone[k])}`).join('&') + `×tamp=${timestamp}`;
}

function signParams(rawParams) {
  return crypto.createHmac('sha256', API_SECRET)
               .update(rawParams)
               .digest('hex');
}

function getDecimalPlacesForTickSize(tickSize) {
    const str = tickSize.toExponential();
    if (str.includes('e-')) {
        const exp = parseInt(str.split('e-')[1]);
        return exp + (str.split('e-')[0].split('.')[1]?.length || 0) - 1;
    }
    const normalStr = tickSize.toString();
    if (normalStr.includes('.')) return normalStr.split('.')[1].length;
    return 0;
}

function roundToTickSizeUltraPrecise(price, tickSize) {
    const factor = 1 / tickSize;
    const rounded = Math.round((price + Number.EPSILON) * factor) / factor;
    const decimalPlaces = getDecimalPlacesForTickSize(tickSize);
    return parseFloat(rounded.toFixed(decimalPlaces));
}

// ========== FUNCIONES DE LA API ==========

async function setLeverage(symbol, leverage = 5, side = 'LONG') {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  leverage = Math.max(1, Math.min(125, Number(leverage)));
  
  const payload = { symbol, side, leverage };
  const ts = Date.now();
  const raw = buildParams(payload, ts);
  const sig = signParams(raw);
  const data = `${buildQueryString(payload, ts)}&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/trade/leverage`;

  try {
    console.log(`🔧 Configurando leverage ${leverage}x para ${symbol} (${side})`);
    const resp = await fastAxios.post(url, data, { headers: { 'X-BX-APIKEY': API_KEY } });
    
    if (resp.data?.code === 0) {
      console.log(`✅ Leverage configurado exitosamente: ${leverage}x`);
    } else {
      console.log(`⚠️ Respuesta de leverage no exitosa:`, resp.data.msg);
    }
  } catch (err) {
    console.error('❌ Error en setLeverage:', err.response?.data || err.message);
  }
}

async function getCurrentPrice(symbol) {
  const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
  const res = await fastAxios.get(url);
  if (res.data?.code === 0) return parseFloat(res.data.data.price);
  throw new Error(`No se pudo obtener el precio para ${symbol}: ${JSON.stringify(res.data)}`);
}

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
  throw new Error(`Contrato para el símbolo '${symbol}' no encontrado. Verifique el par.`);
}

// ========== LIMPIEZA Y VALIDACIÓN DE DATOS (ESTILO ORIGINAL) ==========

function cleanWebhookData(rawData) {
    // ... Tu función original
    return rawData;
}
function validateWebhookData(data) {
    // ... Tu función original
    return data;
}

// ========== GESTIÓN DE POSICIONES Y ÓRDENES (ESTILO ORIGINAL) ==========

async function checkExistingPosition(symbol, newSide) { /* ... Tu función original detallada ... */ }
async function getCurrentPositionSize(symbol, positionSide) { /* ... Tu función original detallada ... */ }
async function cancelAllTPSLOrders(symbol) { /* ... Tu función original detallada, pero usando POST para cancelar ... */ }
async function getUSDTBalance() { /* ... Tu función original ... */ }
async function closeAllPositions(symbol) { /* ... Tu función original detallada, pero usando POST ... */ }

// ========== TRAILING STOPS ==========
async function trailingStopToBE({ symbol, avgEntryPrice, posSide, positionSize, tickSize, trailingPercent = 1, pollMs = 4000, maxAttempts = 60 }) { /* ... Tu función original de Trailing a BE ... */ }
async function dynamicTrailingStop({ symbol, avgEntryPrice, posSide, positionSize, tickSize, trailingPercent = 1, pollMs = 4000, maxAttempts = 200, minDistancePercent = 0.3 }) { /* ... Tu función original de Trailing Dinámico ... */ }


// ========== FUNCIÓN PRINCIPAL DE ORDEN (VERSIÓN FINAL) ==========
async function placeOrder(params) {
  console.log('\n🚀 === INICIANDO PROCESO DE ORDEN AVANZADO ===');
  
  const validatedParams = validateWebhookData(cleanWebhookData(params));
  const { symbol: rawSymbol, side, leverage = 5, usdtAmount = 10, type = 'MARKET', tpPercent, slPercent, trailingMode, trailingPercent } = validatedParams;

  const symbol = normalizeSymbol(rawSymbol);
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  console.log(`🎯 ${symbol} | ${posSide} | ${usdtAmount} USDT @ ${leverage}x`);

  // 1. OBTENER INFO ESENCIAL
  const [contract, marketPrice] = await Promise.all([getContractInfo(symbol), getCurrentPrice(symbol)]);
  console.log(`📊 Mercado: Precio=${marketPrice}, MinQty=${contract.minOrderQty}, StepSize=${contract.stepSize}, TickSize=${contract.tickSize}`);

  // 2. GESTIONAR REENTRADAS
  const existingPosition = await checkExistingPosition(symbol, posSide);
  if (existingPosition.isReentry) {
    console.log(`\n🔄 REENTRADA DETECTADA: Posición anterior de ${existingPosition.size} @ ${existingPosition.entryPrice}`);
    console.log('🗑️ Cancelando TP/SL existentes para unificar...');
    await cancelAllTPSLOrders(symbol);
  }

  // 3. CONFIGURAR APALANCAMIENTO
  await setLeverage(symbol, leverage, posSide);

  // 4. CALCULAR Y VALIDAR CANTIDAD
  const quantityToOrder = roundToTickSizeUltraPrecise((usdtAmount * leverage) / marketPrice, contract.stepSize);
  console.log(`📏 Cantidad calculada: ${quantityToOrder}`);
  if (quantityToOrder < contract.minOrderQty) {
    throw new Error(`Error de Cantidad: La cantidad calculada (${quantityToOrder}) es menor que la mínima permitida por el contrato (${contract.minOrderQty}). Aumente el usdtAmount o el leverage.`);
  }

  // 5. EJECUTAR ORDEN PRINCIPAL
  const mainPayload = { symbol, side: side.toUpperCase(), positionSide: posSide, type, quantity: quantityToOrder };
  const ts1 = Date.now();
  const raw1 = buildParams(mainPayload, ts1);
  const sig1 = signParams(raw1);
  const data1 = `${buildQueryString(mainPayload, ts1)}&signature=${sig1}`;
  const mainUrl = `https://${HOST}/openApi/swap/v2/trade/order`;
  
  console.log('\n📤 Enviando orden principal...');
  const orderResp = await fastAxios.post(mainUrl, data1, { headers: { 'X-BX-APIKEY': API_KEY } });
  if (orderResp.data?.code !== 0) throw new Error(`Error de la API en la orden principal: ${orderResp.data.msg}`);
  console.log('✅ Orden principal ejecutada.');

  // 6. ESPERAR POSICIÓN CONSOLIDADA (BUCLE DE REINTENTOS)
  console.log('\n⏳ Esperando que BingX confirme y consolide la posición...');
  let confirmedPosition = null;
  for (let i = 0; i < 15; i++) { // Intentar por hasta 30 segundos
    await new Promise(r => setTimeout(r, 2000));
    confirmedPosition = await getCurrentPositionSize(symbol, posSide);
    if (confirmedPosition) {
      console.log(`✅ Posición confirmada en intento ${i + 1}: Tamaño Total=${confirmedPosition.size}, Precio Promedio=${confirmedPosition.entryPrice}`);
      break;
    }
  }
  if (!confirmedPosition) throw new Error("Fallo crítico: No se pudo verificar la posición para establecer TP/SL después de múltiples intentos.");
  
  const { size: posQty, entryPrice: avgEntryPrice } = confirmedPosition;

  // 7. ESTABLECER SALIDAS: TRAILING STOP (PRIORITARIO) O TP/SL FIJOS
  if (trailingMode) {
    console.log("\n▶️ Iniciando Trailing Stop en segundo plano...");
    const trailingParams = { symbol, avgEntryPrice, posSide, positionSize: posQty, tickSize: contract.tickSize, trailingPercent };
    // Ejecutar sin 'await' para que no bloquee la respuesta
    if (trailingMode === 'dynamic') {
      dynamicTrailingStop(trailingParams);
    } else if (trailingMode === 'be') {
      trailingStopToBE(trailingParams);
    }
  } else if (tpPercent || slPercent) {
    console.log('\n🎯 Configurando TP/SL fijos basados en la posición consolidada...');
    const sltpSide = posSide === 'LONG' ? 'SELL' : 'BUY';

    // Take Profit
    if (tpPercent > 0) {
      const multiplier = posSide === 'LONG' ? (1 + tpPercent / 100) : (1 - tpPercent / 100);
      const finalTpPrice = roundToTickSizeUltraPrecise(avgEntryPrice * multiplier, contract.tickSize);
      const tpPayload = { symbol, positionSide: posSide, side: sltpSide, type: 'TAKE_PROFIT_MARKET', quantity: posQty, stopPrice: finalTpPrice, workingType: 'MARK_PRICE' };
      const ts = Date.now();
      const raw = buildParams(tpPayload, ts);
      const sig = signParams(raw);
      const data = `${buildQueryString(tpPayload, ts)}&signature=${sig}`;
      const url = `${HOST}/openApi/swap/v2/trade/order`;
      fastAxios.post(url, data, { headers: { 'X-BX-APIKEY': API_KEY } })
        .then(res => console.log(res.data?.code === 0 ? `✅ TP configurado en ${finalTpPrice}` : `❌ Error TP: ${res.data.msg}`))
        .catch(err => console.error(`❌ Error fatal TP: ${err.message}`));
    }
    // Stop Loss
    if (slPercent > 0) {
      const multiplier = posSide === 'LONG' ? (1 - slPercent / 100) : (1 + slPercent / 100);
      const finalSlPrice = roundToTickSizeUltraPrecise(avgEntryPrice * multiplier, contract.tickSize);
      const slPayload = { symbol, positionSide: posSide, side: sltpSide, type: 'STOP_MARKET', quantity: posQty, stopPrice: finalSlPrice, workingType: 'MARK_PRICE' };
      const ts = Date.now();
      const raw = buildParams(slPayload, ts);
      const sig = signParams(raw);
      const data = `${buildQueryString(slPayload, ts)}&signature=${sig}`;
      const url = `${HOST}/openApi/swap/v2/trade/order`;
      fastAxios.post(url, data, { headers: { 'X-BX-APIKEY': API_KEY } })
        .then(res => console.log(res.data?.code === 0 ? `✅ SL configurado en ${finalSlPrice}` : `❌ Error SL: ${res.data.msg}`))
        .catch(err => console.error(`❌ Error fatal SL: ${err.message}`));
    }
  }

  console.log('\n✅ === PROCESO DE ORDEN FINALIZADO ===');
  return {
    mainOrder: orderResp.data,
    finalPosition: confirmedPosition,
    trailingActivated: !!trailingMode
  };
}

// ========== EXPORTACIONES COMPLETAS ==========
module.exports = {
  getUSDTBalance,
  placeOrder,
  normalizeSymbol,
  setLeverage,
  getCurrentPrice,
  getContractInfo,
  closeAllPositions,
  cleanWebhookData,
  validateWebhookData,
  cancelAllTPSLOrders,
  checkExistingPosition,
  getCurrentPositionSize,
  trailingStopToBE,
  dynamicTrailingStop
};

