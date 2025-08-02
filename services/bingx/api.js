// --- DEPENDENCIAS Y CONFIGURACIÓN INICIAL ---
require('dotenv').config();
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
  timeout: 8000,
  headers: {
    'Connection': 'keep-alive',
    'Content-Type': 'application/x-www-form-urlencoded'
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
  let str = keys.map(k => `${k}=${clone[k]}`).join('&');
  return str ? `${str}×tamp=${timestamp}` : `timestamp=${timestamp}`;
}

function buildQueryString(payload, timestamp) {
    const clone = { ...payload };
    const keys = Object.keys(clone).sort();
    let str = keys.map(k => `${k}=${encodeURIComponent(clone[k])}`).join('&');
    return str ? `${str}×tamp=${timestamp}` : `timestamp=${timestamp}`;
}

function signParams(rawParams) {
  return crypto.createHmac('sha256', API_SECRET)
               .update(rawParams)
               .digest('hex');
}

function getDecimalPlacesForTickSize(tickSize) {
    const str = tickSize.toString();
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

// ========== LIMPIEZA Y VALIDACIÓN DE DATOS ==========
function cleanWebhookData(rawData) {
    console.log('🧹 Limpiando datos del webhook...');
    const cleanData = {};
    for (const [key, value] of Object.entries(rawData)) {
        if (!cleanData.hasOwnProperty(key)) {
            cleanData[key] = value;
        }
    }
    console.log('✅ Datos limpios:', JSON.stringify(cleanData, null, 2));
    return cleanData;
}

function validateWebhookData(data) {
    console.log('🔍 Validando datos del webhook...');
    const required = ['symbol', 'side'];
    const missing = required.filter(field => !data[field]);
    if (missing.length > 0) throw new Error(`Campos requeridos faltantes: ${missing.join(', ')}`);
    return data;
}

// ========== GESTIÓN DE POSICIONES Y ÓRDENES ==========
async function checkExistingPosition(symbol, newSide) {
  try {
    const payload = { symbol };
    const ts = Date.now();
    const raw = buildParams(payload, ts);
    const sig = signParams(raw);
    const url = `https://${HOST}/openApi/swap/v2/user/positions?${buildQueryString(payload, ts)}&signature=${sig}`;
    const response = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });

    if (response.data?.code === 0 && Array.isArray(response.data.data)) {
        const position = response.data.data.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (position) {
            const positionAmt = parseFloat(position.positionAmt);
            const existingSide = positionAmt > 0 ? 'LONG' : 'SHORT';
            return {
                exists: true,
                side: existingSide,
                size: Math.abs(positionAmt),
                entryPrice: parseFloat(position.avgPrice),
                isReentry: existingSide === newSide,
            };
        }
    }
    return { exists: false, isReentry: false };
  } catch (error) {
    console.error('❌ Error verificando posición:', error.response?.data?.msg || error.message);
    return { exists: false, isReentry: false };
  }
}

async function getCurrentPositionSize(symbol, positionSide) {
  try {
    const ts = Date.now();
    const raw = `timestamp=${ts}`;
    const sig = signParams(raw);
    const url = `https://${HOST}/openApi/swap/v2/user/positions?${raw}&signature=${sig}`;
    const response = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });

    if (response.data?.code === 0 && Array.isArray(response.data.data)) {
        const position = response.data.data.find(p => p.symbol === symbol);
        if (position) {
            const positionAmt = parseFloat(position.positionAmt);
            const absSize = Math.abs(positionAmt);
            const actualSide = positionAmt > 0 ? 'LONG' : 'SHORT';
            if (actualSide === positionSide) {
                return { size: absSize, entryPrice: parseFloat(position.avgPrice) };
            }
        }
    }
    return null;
  } catch (error) {
    console.error('❌ Error obteniendo tamaño de posición:', error.response?.data?.msg || error.message);
    return null;
  }
}

async function cancelAllTPSLOrders(symbol) {
  try {
    const payload = { symbol };
    const ts = Date.now();
    const raw = buildParams(payload, ts);
    const sig = signParams(raw);
    const data = `${buildQueryString(payload, ts)}&signature=${sig}`;
    const url = `https://${HOST}/openApi/swap/v2/trade/stopOrder/cancelAll`;
    const res = await fastAxios.post(url, data, { headers: { 'X-BX-APIKEY': API_KEY } });
    if (res.data.code === 0) {
        const count = res.data.data.success?.length || 0;
        console.log(`✅ ${count} órdenes TP/SL para ${symbol} canceladas.`);
        return count;
    }
  } catch (e) {
    console.error(`❌ Error cancelando órdenes TP/SL para ${symbol}:`, e.response?.data?.msg || e.message);
  }
  return 0;
}

async function getUSDTBalance() {
  try {
    const ts = Date.now();
    const raw = `timestamp=${ts}`;
    const sig = signParams(raw);
    const url = `https://${HOST}/openApi/swap/v2/user/balance?${raw}&signature=${sig}`;
    const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
    if (res.data.code === 0 && res.data.data?.balance) {
      return parseFloat(res.data.data.balance.balance);
    }
    return 0;
  } catch (error) {
    console.error('❌ Error obteniendo balance USDT:', error.response?.data?.msg || error.message);
    return 0;
  }
}

async function closeAllPositions(symbol) {
  try {
    const sym = normalizeSymbol(symbol);
    const payload = { symbol: sym };
    const ts = Date.now();
    const raw = buildParams(payload, ts);
    const sig = signParams(raw);
    const data = `${buildQueryString(payload, ts)}&signature=${sig}`;
    const url = `https://${HOST}/openApi/swap/v2/trade/closeAllPositions`;
    const res = await fastAxios.post(url, data, { headers: { 'X-BX-APIKEY': API_KEY } });
    console.log(`✅ Solicitud de cerrar todas las posiciones para ${sym} enviada.`);
    return res.data;
  } catch (err) {
    console.error('❌ Error en closeAllPositions:', err.response?.data || err.message);
    throw err;
  }
}

// ========== TRAILING STOPS ==========
async function trailingStopToBE({ symbol, avgEntryPrice, posSide, positionSize, tickSize, trailingPercent = 1, pollMs = 4000, maxAttempts = 60 }) {
    if (!trailingPercent) return;
    console.log(`🚦 Iniciando Trailing a Break-Even para ${symbol} si avanza ${trailingPercent}%...`);
    let attempts = 0;
    const targetPrice = posSide === 'LONG' ? avgEntryPrice * (1 + trailingPercent / 100) : avgEntryPrice * (1 - trailingPercent / 100);

    while (++attempts <= maxAttempts) {
        await new Promise(r => setTimeout(r, pollMs));
        try {
            const price = await getCurrentPrice(symbol);
            if ((posSide === 'LONG' && price >= targetPrice) || (posSide === 'SHORT' && price <= targetPrice)) {
                await cancelAllTPSLOrders(symbol);
                const newSL = roundToTickSizeUltraPrecise(avgEntryPrice, tickSize);
                const payload = { symbol, side: posSide === 'LONG' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', quantity: positionSize, stopPrice: newSL, workingType: 'MARK_PRICE' };
                const ts = Date.now();
                const raw = buildParams(payload, ts);
                const sig = signParams(raw);
                const data = `${buildQueryString(payload, ts)}&signature=${sig}`;
                await fastAxios.post(`https://${HOST}/openApi/swap/v2/trade/order`, data, { headers: { 'X-BX-APIKEY': API_KEY } });
                console.log(`✅ SL movido a BE (${newSL}) tras avance de ${trailingPercent}%`);
                return true;
            }
        } catch (e) {
            console.error(`Error en el ciclo de Trailing BE: ${e.message}`);
        }
    }
    console.log('⏳ Trailing stop BE: No se alcanzó el trigger en el tiempo definido.');
    return false;
}

async function dynamicTrailingStop({ symbol, avgEntryPrice, posSide, positionSize, tickSize, trailingPercent = 1, pollMs = 4000, maxAttempts = 200, minDistancePercent = 0.3 }) {
    if (!trailingPercent) return;
    console.log(`🚦 Iniciando Trailing Dinámico para ${symbol}, distancia ${minDistancePercent}%`);
    let attempts = 0;
    let extremumPrice = avgEntryPrice;
    let activeSL = posSide === 'LONG' ? 0 : Infinity;

    const initialTriggerPrice = posSide === 'LONG' ? avgEntryPrice * (1 + trailingPercent / 100) : avgEntryPrice * (1 - trailingPercent / 100);

    while (++attempts <= maxAttempts) {
        await new Promise(r => setTimeout(r, pollMs));
        try {
            const price = await getCurrentPrice(symbol);
            let newSL;

            if (posSide === 'LONG') {
                if (price > extremumPrice) extremumPrice = price;
                newSL = roundToTickSizeUltraPrecise(extremumPrice * (1 - minDistancePercent / 100), tickSize);
                if (price >= initialTriggerPrice && newSL > activeSL) {
                    await cancelAllTPSLOrders(symbol);
                    const payload = { symbol, side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', quantity: positionSize, stopPrice: newSL, workingType: 'MARK_PRICE' };
                    const ts = Date.now();
                    const raw = buildParams(payload, ts);
                    const sig = signParams(raw);
                    const data = `${buildQueryString(payload, ts)}&signature=${sig}`;
                    await fastAxios.post(`https://${HOST}/openApi/swap/v2/trade/order`, data, { headers: { 'X-BX-APIKEY': API_KEY } });
                    console.log(`⏩ Trailing LONG SL actualizado: ${newSL} (precio máximo: ${extremumPrice})`);
                    activeSL = newSL;
                }
            } else { // SHORT
                if (price < extremumPrice) extremumPrice = price;
                newSL = roundToTickSizeUltraPrecise(extremumPrice * (1 + minDistancePercent / 100), tickSize);
                if (price <= initialTriggerPrice && newSL < activeSL) {
                    await cancelAllTPSLOrders(symbol);
                    const payload = { symbol, side: 'BUY', positionSide: 'SHORT', type: 'STOP_MARKET', quantity: positionSize, stopPrice: newSL, workingType: 'MARK_PRICE' };
                    const ts = Date.now();
                    const raw = buildParams(payload, ts);
                    const sig = signParams(raw);
                    const data = `${buildQueryString(payload, ts)}&signature=${sig}`;
                    await fastAxios.post(`https://${HOST}/openApi/swap/v2/trade/order`, data, { headers: { 'X-BX-APIKEY': API_KEY } });
                    console.log(`⏩ Trailing SHORT SL actualizado: ${newSL} (precio mínimo: ${extremumPrice})`);
                    activeSL = newSL;
                }
            }
        } catch (e) {
            console.error(`Error en el ciclo de Trailing Dinámico: ${e.message}`);
        }
    }
    console.log('⏳ Trailing dinámico: finalizó el tiempo máximo sin más avances.');
    return false;
}

// ========== FUNCIÓN PRINCIPAL DE ORDEN (VERSIÓN FINAL) ==========
async function placeOrder(params) {
  console.log('\n🚀 === INICIANDO PROCESO DE ORDEN AVANZADO ===');
  
  const validatedParams = validateWebhookData(cleanWebhookData(params));
  const { symbol: rawSymbol, side, leverage = 5, usdtAmount = 10, type = 'MARKET', tpPercent, slPercent, trailingMode, trailingPercent, minDistancePercent } = validatedParams;

  const symbol = normalizeSymbol(rawSymbol);
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  console.log(`🎯 ${symbol} | ${posSide} | ${usdtAmount} USDT @ ${leverage}x`);

  const [contract, marketPrice] = await Promise.all([getContractInfo(symbol), getCurrentPrice(symbol)]);
  console.log(`📊 Mercado: Precio=${marketPrice}, MinQty=${contract.minOrderQty}, StepSize=${contract.stepSize}, TickSize=${contract.tickSize}`);

  const existingPosition = await checkExistingPosition(symbol, posSide);
  if (existingPosition.isReentry) {
    console.log(`\n🔄 REENTRADA DETECTADA: Posición anterior de ${existingPosition.size} @ ${existingPosition.entryPrice}`);
    await cancelAllTPSLOrders(symbol);
  }

  await setLeverage(symbol, leverage, posSide);

  const quantityToOrder = roundToTickSizeUltraPrecise((usdtAmount * leverage) / marketPrice, contract.stepSize);
  console.log(`📏 Cantidad calculada: ${quantityToOrder}`);
  if (quantityToOrder < contract.minOrderQty) {
    throw new Error(`Error de Cantidad: La cantidad calculada (${quantityToOrder}) es menor que la mínima permitida por el contrato (${contract.minOrderQty}).`);
  }

  const mainPayload = { symbol, side: side.toUpperCase(), positionSide: posSide, type, quantity: quantityToOrder };
  const ts1 = Date.now();
  const raw1 = buildParams(mainPayload, ts1);
  const sig1 = signParams(raw1);
  const data1 = `${buildQueryString(mainPayload, ts1)}&signature=${sig1}`;
  const mainUrl = `https://${HOST}/openApi/swap/v2/trade/order`;
  
  console.log('\n📤 Enviando orden principal...');
  const orderResp = await fastAxios.post(mainUrl, data1, { headers: { 'X-BX-APIKEY': API_KEY } });
  if (orderResp.data?.code !== 0) throw new Error(`Error API en orden principal: ${orderResp.data.msg}`);
  console.log('✅ Orden principal ejecutada.');

  console.log('\n⏳ Esperando que BingX confirme y consolide la posición...');
  let confirmedPosition = null;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    confirmedPosition = await getCurrentPositionSize(symbol, posSide);
    if (confirmedPosition) {
      console.log(`✅ Posición confirmada en intento ${i + 1}: Tamaño=${confirmedPosition.size}, Precio=${confirmedPosition.entryPrice}`);
      break;
    }
  }
  if (!confirmedPosition) throw new Error("Fallo crítico: No se pudo verificar la posición para establecer TP/SL.");
  
  const { size: posQty, entryPrice: avgEntryPrice } = confirmedPosition;

  if (trailingMode) {
    console.log("\n▶️ Iniciando Trailing Stop en segundo plano...");
    const trailingParams = { symbol, avgEntryPrice, posSide, positionSize: posQty, tickSize: contract.tickSize, trailingPercent, minDistancePercent };
    if (trailingMode === 'dynamic') {
        dynamicTrailingStop(trailingParams);
    } else if (trailingMode === 'be') {
        trailingStopToBE(trailingParams);
    }
  } else if (tpPercent || slPercent) {
    console.log('\n🎯 Configurando TP/SL fijos...');
    const sltpSide = posSide === 'LONG' ? 'SELL' : 'BUY';
    if (tpPercent > 0) {
      const finalTpPrice = roundToTickSizeUltraPrecise(avgEntryPrice * (posSide === 'LONG' ? 1 + tpPercent / 100 : 1 - tpPercent / 100), contract.tickSize);
      const payload = { symbol, positionSide: posSide, side: sltpSide, type: 'TAKE_PROFIT_MARKET', quantity: posQty, stopPrice: finalTpPrice, workingType: 'MARK_PRICE' };
      const ts = Date.now();
      const raw = buildParams(payload, ts);
      const sig = signParams(raw);
      const data = `${buildQueryString(payload, ts)}&signature=${sig}`;
      fastAxios.post(`https://${HOST}/openApi/swap/v2/trade/order`, data, { headers: { 'X-BX-APIKEY': API_KEY } })
        .then(res => console.log(res.data?.code === 0 ? `✅ TP configurado en ${finalTpPrice}` : `❌ Error TP: ${res.data.msg}`))
        .catch(err => console.error(`❌ Error fatal TP: ${err.message}`));
    }
    if (slPercent > 0) {
      const finalSlPrice = roundToTickSizeUltraPrecise(avgEntryPrice * (posSide === 'LONG' ? 1 - slPercent / 100 : 1 + slPercent / 100), contract.tickSize);
       const payload = { symbol, positionSide: posSide, side: sltpSide, type: 'STOP_MARKET', quantity: posQty, stopPrice: finalSlPrice, workingType: 'MARK_PRICE' };
      const ts = Date.now();
      const raw = buildParams(payload, ts);
      const sig = signParams(raw);
      const data = `${buildQueryString(payload, ts)}&signature=${sig}`;
      fastAxios.post(`https://${HOST}/openApi/swap/v2/trade/order`, data, { headers: { 'X-BX-APIKEY': API_KEY } })
        .then(res => console.log(res.data?.code === 0 ? `✅ SL configurado en ${finalSlPrice}` : `❌ Error SL: ${res.data.msg}`))
        .catch(err => console.error(`❌ Error fatal SL: ${err.message}`));
    }
  }

  console.log('\n✅ === PROCESO DE ORDEN FINALIZADO ===');
  return { mainOrder: orderResp.data, finalPosition: confirmedPosition, trailingActivated: !!trailingMode };
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
