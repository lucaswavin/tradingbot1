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
  }
});

// ========== UTILS (LÓGICA OFICIAL DE BINGX) ==========

function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  let base = symbol.replace(/\.P$/, '');
  if (base.endsWith('USDT') && !base.includes('-')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  return base;
}

function getParameters(payload, timestamp, urlEncode = false) {
    let parameters = "";
    for (const key in payload) {
        const value = payload[key];
        if (urlEncode) {
            parameters += `${key}=${encodeURIComponent(value)}&`;
        } else {
            parameters += `${key}=${value}&`;
        }
    }
    if (parameters) {
        parameters = parameters.substring(0, parameters.length - 1);
        parameters = `${parameters}&timestamp=${timestamp}`;
    } else {
        parameters = `timestamp=${timestamp}`;
    }
    return parameters;
}

function sign(paramsString) {
    return crypto.createHmac('sha256', API_SECRET)
                 .update(paramsString)
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

// ========== FUNCIÓN DE COMUNICACIÓN OFICIAL ==========
async function sendRequest(method, path, payload) {
    const timestamp = Date.now();
    const parametersToSign = getParameters(payload, timestamp, false);
    const parametersForUrl = getParameters(payload, timestamp, true);
    const signature = sign(parametersToSign);
    const url = `https://${HOST}${path}?${parametersForUrl}&signature=${signature}`;

    const config = {
        method: method,
        url: url,
        headers: { 'X-BX-APIKEY': API_KEY }
    };
    
    if (method.toUpperCase() === 'POST') {
        config.data = '';
        config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    try {
        const response = await fastAxios(config);
        return response.data;
    } catch (err) {
        console.error(`❌ Error en la petición a ${path}:`, err.response?.data || err.message);
        return err.response?.data || { code: -1, msg: err.message };
    }
}

// ========== FUNCIONES DE LA API ==========

async function setLeverage(symbol, leverage = 5, side = 'LONG') {
  leverage = Math.max(1, Math.min(125, Number(leverage)));
  const payload = { symbol, side, leverage };
  console.log(`🔧 Configurando leverage ${leverage}x para ${symbol} (${side})`);
  const resp = await sendRequest('POST', '/openApi/swap/v2/trade/leverage', payload);
  if (resp.code === 0) {
      console.log(`✅ Leverage configurado exitosamente: ${leverage}x`);
  } else {
      console.log(`⚠️ Respuesta de leverage no exitosa:`, resp.msg);
  }
}

async function getCurrentPrice(symbol) {
  const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
  const res = await fastAxios.get(url);
  if (res.data?.code === 0) return parseFloat(res.data.data.price);
  throw new Error(`No se pudo obtener el precio para ${symbol}: ${JSON.stringify(res.data)}`);
}

async function getContractInfo(symbol) {
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/contracts`;
    const res = await fastAxios.get(url);
    if (res.data?.code === 0) {
      const c = res.data.data.find(x => x.symbol === symbol);
      if (c) {
        return {
          minOrderQty: parseFloat(c.minOrderQty) || 0.001,
          tickSize: parseFloat(c.tickSize) || 0.00001,
          stepSize: parseFloat(c.stepSize) || 0.001,
          minNotional: parseFloat(c.minNotional) || 1,
          maxLeverage: parseInt(c.maxLeverage) || 20
        };
      }
    }
  } catch (e) {
    console.log('⚠️ Error obteniendo contrato:', e.message);
  }
  console.log('⚠️ Usando valores por defecto para', symbol);
  return { 
    minOrderQty: 0.001, 
    tickSize: 0.00001,
    stepSize: 0.001, 
    minNotional: 1, 
    maxLeverage: 20
  };
}

// ========== LIMPIEZA Y VALIDACIÓN ==========
function cleanWebhookData(rawData) {
    const cleanData = {};
    for (const [key, value] of Object.entries(rawData)) {
        if (!cleanData.hasOwnProperty(key)) cleanData[key] = value;
    }
    return cleanData;
}

function validateWebhookData(data) {
    const required = ['symbol', 'side'];
    const missing = required.filter(field => !data[field]);
    if (missing.length > 0) throw new Error(`Campos requeridos faltantes: ${missing.join(', ')}`);
    return data;
}

// ========== GESTIÓN DE POSICIONES ==========

async function getCurrentPositionSize(symbol, positionSide) {
  try {
    const payload = { symbol };
    const response = await sendRequest('GET', '/openApi/swap/v2/user/positions', payload);
    if (response?.code === 0) {
      let positions = Array.isArray(response.data) ? response.data : [response.data].filter(Boolean);
      for (const position of positions) {
        if (position.symbol === symbol) {
          const positionAmt = parseFloat(position.positionAmt);
          if (positionAmt !== 0) {
            const actualSide = position.positionSide || (positionAmt > 0 ? 'LONG' : 'SHORT');
            if (actualSide === positionSide) {
              return { 
                size: Math.abs(positionAmt), 
                entryPrice: parseFloat(position.avgPrice) || parseFloat(position.entryPrice),
                actualSide: actualSide 
              };
            }
          }
        }
      }
    }
    return null;
  } catch (error) {
    console.error('❌ Error en getCurrentPositionSize:', error.message);
    return null;
  }
}

async function checkExistingPosition(symbol, newSide) {
  try {
    const payload = { symbol };
    const response = await sendRequest('GET', '/openApi/swap/v2/user/positions', payload);
    if (response?.code === 0) {
      let positions = Array.isArray(response.data) ? response.data : [response.data].filter(Boolean);
      for (const position of positions) {
        if (position.symbol === symbol && parseFloat(position.positionAmt) !== 0) {
          const positionAmt = parseFloat(position.positionAmt);
          const existingSide = position.positionSide || (positionAmt > 0 ? 'LONG' : 'SHORT');
          return { 
            exists: true, 
            side: existingSide, 
            size: Math.abs(positionAmt), 
            entryPrice: parseFloat(position.avgPrice) || parseFloat(position.entryPrice), 
            isReentry: existingSide === newSide 
          };
        }
      }
    }
    return { exists: false, isReentry: false };
  } catch (error) {
    console.error('❌ Error en checkExistingPosition:', error.message);
    return { exists: false, isReentry: false };
  }
}

async function cancelAllTPSLOrders(symbol) {
  const payload = { symbol };
  const res = await sendRequest('POST', '/openApi/swap/v2/trade/stopOrder/cancelAll', payload);
  if (res.code === 0) {
      const count = res.data.success?.length || 0;
      console.log(`✅ ${count} órdenes TP/SL para ${symbol} canceladas.`);
      return count;
  }
  return 0;
}

async function getUSDTBalance() {
  const res = await sendRequest('GET', '/openApi/swap/v2/user/balance', {});
  if (res.code === 0 && res.data?.balance) {
    return parseFloat(res.data.balance.balance);
  }
  return 0;
}

async function closeAllPositions(symbol) {
  const sym = normalizeSymbol(symbol);
  const payload = { symbol: sym };
  const res = await sendRequest('POST', '/openApi/swap/v2/trade/closeAllPositions', payload);
  console.log(`✅ Solicitud de cerrar todas las posiciones para ${sym} enviada.`);
  return res;
}

// ========== MANEJO DE TP/SL EXISTENTES ==========
async function getExistingTPSLOrders(symbol) {
  try {
    const payload = { symbol };
    const response = await sendRequest('GET', '/openApi/swap/v2/trade/openOrders', payload);
    if (response?.code === 0 && response.data?.orders) {
      const orders = Array.isArray(response.data.orders) ? response.data.orders : [];
      return orders.filter(o => ['TAKE_PROFIT_MARKET', 'STOP_MARKET', 'TAKE_PROFIT', 'STOP'].includes(o.type));
    }
    return [];
  } catch (error) {
    console.error('❌ Error obteniendo órdenes TP/SL:', error.message);
    return [];
  }
}

function calculateTPSLPercentsFromOrders(orders, entryPrice) {
  let tpPercent = null;
  let slPercent = null;
  for (const order of orders) {
    const stopPrice = parseFloat(order.stopPrice);
    if (!stopPrice) continue;
    const priceDiff = Math.abs(stopPrice - entryPrice) / entryPrice * 100;
    if (order.type.includes('TAKE_PROFIT')) tpPercent = priceDiff;
    else if (order.type.includes('STOP')) slPercent = priceDiff;
  }
  return { tpPercent, slPercent };
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
                await sendRequest('POST', '/openApi/swap/v2/trade/order', payload);
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
            const payloadBase = { symbol, positionSide: posSide, type: 'STOP_MARKET', quantity: positionSize, workingType: 'MARK_PRICE' };

            if (posSide === 'LONG') {
                if (price > extremumPrice) extremumPrice = price;
                newSL = roundToTickSizeUltraPrecise(extremumPrice * (1 - minDistancePercent / 100), tickSize);
                if (price >= initialTriggerPrice && newSL > activeSL) {
                    await cancelAllTPSLOrders(symbol);
                    const payload = { ...payloadBase, side: 'SELL', stopPrice: newSL };
                    await sendRequest('POST', '/openApi/swap/v2/trade/order', payload);
                    console.log(`⏩ Trailing LONG SL actualizado: ${newSL} (precio máximo: ${extremumPrice})`);
                    activeSL = newSL;
                }
            } else { // SHORT
                if (price < extremumPrice) extremumPrice = price;
                newSL = roundToTickSizeUltraPrecise(extremumPrice * (1 + minDistancePercent / 100), tickSize);
                if (price <= initialTriggerPrice && newSL < activeSL) {
                    await cancelAllTPSLOrders(symbol);
                    const payload = { ...payloadBase, side: 'BUY', stopPrice: newSL };
                    await sendRequest('POST', '/openApi/swap/v2/trade/order', payload);
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


// ========== FUNCIÓN PRINCIPAL OPTIMIZADA ==========
async function placeOrder(params) {
  console.log('\n🚀 === INICIANDO PROCESO DE ORDEN AVANZADO ===');
  
  const validatedParams = validateWebhookData(cleanWebhookData(params));
  const { 
    symbol: rawSymbol, side, leverage = 5, usdtAmount = 10, type = 'MARKET', 
    tpPercent: newTpPercent, slPercent: newSlPercent, trailingMode, 
    trailingPercent, minDistancePercent 
  } = validatedParams;

  const symbol = normalizeSymbol(rawSymbol);
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  console.log(`🎯 ${symbol} | ${posSide} | ${usdtAmount} USDT @ ${leverage}x`);

  const [contract, marketPrice] = await Promise.all([getContractInfo(symbol), getCurrentPrice(symbol)]);
  
  // 1. VERIFICAR REENTRADA
  const existingPosition = await checkExistingPosition(symbol, posSide);
  let inheritedTpPercent = null, inheritedSlPercent = null;
  
  if (existingPosition.isReentry) {
    console.log(`\n🔄 REENTRADA DETECTADA: ${existingPosition.size} unidades @ ${existingPosition.entryPrice}`);
    const existingOrders = await getExistingTPSLOrders(symbol);
    if (existingOrders.length > 0) {
      const { tpPercent, slPercent } = calculateTPSLPercentsFromOrders(existingOrders, existingPosition.entryPrice);
      inheritedTpPercent = tpPercent;
      inheritedSlPercent = slPercent;
    }
  }

  // 2. CONFIGURAR LEVERAGE Y EJECUTAR ORDEN
  await setLeverage(symbol, leverage, posSide);
  const quantityToOrder = roundToTickSizeUltraPrecise((usdtAmount * leverage) / marketPrice, contract.stepSize);
  if (quantityToOrder < contract.minOrderQty) throw new Error(`Cantidad (${quantityToOrder}) < mínima (${contract.minOrderQty})`);

  const mainPayload = { symbol, side: side.toUpperCase(), positionSide: posSide, type, quantity: quantityToOrder };
  const orderResp = await sendRequest('POST', '/openApi/swap/v2/trade/order', mainPayload);
  if (orderResp.code !== 0) throw new Error(`Error API en orden principal: ${orderResp.msg}`);
  console.log('✅ Orden principal ejecutada.');

  // 3. ESPERAR Y CANCELAR ÓRDENES (SOLO EN REENTRADAS)
  if (existingPosition.isReentry) {
    console.log('⏳ Esperando consolidación y cancelando órdenes TP/SL previas...');
    await new Promise(r => setTimeout(r, 1000));
    await cancelAllTPSLOrders(symbol);
    await new Promise(r => setTimeout(r, 1500));
  }

  // 4. OBTENER POSICIÓN CONSOLIDADA FINAL
  console.log('🔍 Obteniendo posición consolidada final...');
  let confirmedPosition = null;
  for (let i = 0; i < 10; i++) {
    const pos = await getCurrentPositionSize(symbol, posSide);
    if (pos) { confirmedPosition = pos; break; }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!confirmedPosition) throw new Error("No se pudo confirmar la posición consolidada tras la orden.");
  console.log(`✅ Posición consolidada: ${confirmedPosition.size} @ ${confirmedPosition.entryPrice}`);

  // 5. DETERMINAR TP/SL FINAL
  const finalTpPercent = newTpPercent ?? inheritedTpPercent;
  const finalSlPercent = newSlPercent ?? inheritedSlPercent;

  // 6. CONFIGURAR TP/SL/TRAILING
  const { size: totalPositionSize, entryPrice: avgEntryPrice } = confirmedPosition;

  if (trailingMode) {
    console.log("\n▶️ Iniciando Trailing Stop en segundo plano...");
    const trailingParams = { symbol, avgEntryPrice, posSide, positionSize: totalPositionSize, tickSize: contract.tickSize, trailingPercent, minDistancePercent };
    (trailingMode === 'dynamic' ? dynamicTrailingStop(trailingParams) : trailingStopToBE(trailingParams));
  } else if (finalTpPercent || finalSlPercent) {
    console.log('\n🎯 CONFIGURANDO TP/SL FINALES...');
    const sltpSide = posSide === 'LONG' ? 'SELL' : 'BUY';
    const orderPromises = [];

    if (finalTpPercent > 0) {
      const finalTpPrice = roundToTickSizeUltraPrecise(avgEntryPrice * (posSide === 'LONG' ? 1 + finalTpPercent / 100 : 1 - finalTpPercent / 100), contract.tickSize);
      const payload = { symbol, positionSide: posSide, side: sltpSide, type: 'TAKE_PROFIT_MARKET', quantity: totalPositionSize, stopPrice: finalTpPrice, workingType: 'MARK_PRICE' };
      console.log(`📤 Configurando TP: ${finalTpPrice}`);
      orderPromises.push(sendRequest('POST', '/openApi/swap/v2/trade/order', payload));
    }
    
    if (finalSlPercent > 0) {
      const finalSlPrice = roundToTickSizeUltraPrecise(avgEntryPrice * (posSide === 'LONG' ? 1 - finalSlPercent / 100 : 1 + finalSlPercent / 100), contract.tickSize);
      const payload = { symbol, positionSide: posSide, side: sltpSide, type: 'STOP_MARKET', quantity: totalPositionSize, stopPrice: finalSlPrice, workingType: 'MARK_PRICE' };
      console.log(`📤 Configurando SL: ${finalSlPrice}`);
      orderPromises.push(sendRequest('POST', '/openApi/swap/v2/trade/order', payload));
    }
    await Promise.all(orderPromises);
    console.log('✅ TP/SL configurados.');
  }

  console.log('\n✅ === PROCESO DE ORDEN FINALIZADO ===');
  return { mainOrder: orderResp, finalPosition: confirmedPosition, trailingActivated: !!trailingMode, isReentry: existingPosition.isReentry, tpPercent: finalTpPercent, slPercent: finalSlPercent };
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
  getExistingTPSLOrders,
  calculateTPSLPercentsFromOrders,
  trailingStopToBE,
  dynamicTrailingStop
};
