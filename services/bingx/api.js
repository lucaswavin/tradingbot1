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
        const contractInfo = {
          minOrderQty: parseFloat(c.minOrderQty) || 0.001,
          tickSize: parseFloat(c.tickSize) || 0.00001,
          stepSize: parseFloat(c.stepSize) || 0.001,
          minNotional: parseFloat(c.minNotional) || 1,
          maxLeverage: parseInt(c.maxLeverage) || 20
        };
        if (isNaN(contractInfo.minOrderQty)) contractInfo.minOrderQty = 0.001;
        if (isNaN(contractInfo.tickSize)) contractInfo.tickSize = 0.00001;
        if (isNaN(contractInfo.stepSize)) contractInfo.stepSize = 0.001;
        return contractInfo;
      }
    }
  } catch (e) {
    console.log('⚠️ Error obteniendo contrato:', e.message);
  }
  // Fallback seguro
  console.log('⚠️ Usando valores por defecto para', symbol);
  return { 
    minOrderQty: 0.001, 
    tickSize: 0.00001,
    stepSize: 0.001, 
    minNotional: 1, 
    maxLeverage: 20
  };
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
async function getExistingTPSLOrders(symbol) {
  try {
    const payload = { symbol };
    const response = await sendRequest('GET', '/openApi/swap/v2/trade/openOrders', payload);
    if (response?.code === 0 && response.data) {
      const orders = Array.isArray(response.data.orders) ? response.data.orders : [];
      const tpslOrders = orders.filter(o => 
        o.type === 'TAKE_PROFIT_MARKET' || 
        o.type === 'STOP_MARKET' || 
        o.type === 'TAKE_PROFIT' || 
        o.type === 'STOP'
      );
      console.log(`📋 Órdenes TP/SL existentes encontradas: ${tpslOrders.length}`);
      return tpslOrders;
    }
    return [];
  } catch (error) {
    console.error('❌ Error obteniendo órdenes TP/SL:', error.message);
    return [];
  }
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

// ========== GESTIÓN DE POSICIONES ==========
async function checkExistingPosition(symbol, newSide) {
  try {
    const payload = { symbol };
    const response = await sendRequest('GET', '/openApi/swap/v2/user/positions', payload);
    if (response?.code === 0) {
      let positions = response.data;
      if (!Array.isArray(positions)) positions = positions ? [positions] : [];
      for (const position of positions) {
        if (position.symbol === symbol) {
          const positionAmt = parseFloat(position.positionAmt);
          if (positionAmt !== 0) {
            const existingSide = position.positionSide || (positionAmt > 0 ? 'LONG' : 'SHORT');
            const size = Math.abs(positionAmt);
            const entryPrice = parseFloat(position.avgPrice) || parseFloat(position.entryPrice);
            const isReentry = existingSide === newSide;
            return { exists: true, side: existingSide, size, entryPrice, isReentry };
          }
        }
      }
    }
    return { exists: false, isReentry: false };
  } catch (error) {
    console.error('❌ [DEBUG] Error en checkExistingPosition:', error.message);
    return { exists: false, isReentry: false };
  }
}

// ========== FUNCIÓN PRINCIPAL OPTIMIZADA PARA REENTRADAS Y LATENCIA ==========
async function placeOrder(params) {
  console.log('\n🚀 === INICIANDO PROCESO DE ORDEN AVANZADO ===');
  const validatedParams = validateWebhookData(cleanWebhookData(params));
  const { 
    symbol: rawSymbol, 
    side, 
    leverage = 5, 
    usdtAmount = 10, 
    type = 'MARKET', 
    tpPercent: newTpPercent, 
    slPercent: newSlPercent, 
    trailingMode, 
    trailingPercent, 
    minDistancePercent 
  } = validatedParams;

  const symbol = normalizeSymbol(rawSymbol);
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';

  // Primeros requests paralelos
  const [contract, marketPrice, existingPosition] = await Promise.all([
    getContractInfo(symbol),
    getCurrentPrice(symbol),
    checkExistingPosition(symbol, posSide)
  ]);

  let isReentry = false;
  let inheritedTpPercent = null;
  let inheritedSlPercent = null;
  if (existingPosition.isReentry) {
    isReentry = true;
    // Consultar órdenes y heredar sólo si NO hay nuevos porcentajes
    const existingOrders = await getExistingTPSLOrders(symbol);
    if (existingOrders.length > 0) {
      const existingPercents = calculateTPSLPercentsFromOrders(
        existingOrders, 
        existingPosition.entryPrice, 
        posSide
      );
      inheritedTpPercent = existingPercents.tpPercent;
      inheritedSlPercent = existingPercents.slPercent;
    }
  }

  await setLeverage(symbol, leverage, posSide);

  // CALCULAR tamaño de orden en base a la posición actual para operar SIEMPRE 100% del tamaño
  const quantityToOrder = roundToTickSizeUltraPrecise((usdtAmount * leverage) / marketPrice, contract.stepSize);
  if (quantityToOrder < contract.minOrderQty) throw new Error(`Cantidad calculada (${quantityToOrder}) menor que la mínima (${contract.minOrderQty})`);

  // Enviar orden principal (sin esperas)
  const mainPayload = { 
    symbol, 
    side: side.toUpperCase(), 
    positionSide: posSide, 
    type, 
    quantity: quantityToOrder 
  };
  const orderResp = await sendRequest('POST', '/openApi/swap/v2/trade/order', mainPayload);
  if (orderResp.code !== 0) throw new Error(`Error API en orden principal: ${orderResp.msg}`);

  // ========== CANCELAR TODAS LAS ÓRDENES TP/SL EN REENTRADA ==========  
  if (isReentry) {
    await cancelAllTPSLOrders(symbol);
    await new Promise(r => setTimeout(r, 900)); // Espera mínima para evitar race conditions
  }

  // ========== OBTENER NUEVA POSICIÓN TOTAL ==========
  let confirmedPosition = null;
  for (let i = 0; i < 8; i++) {
    const response = await sendRequest('GET', '/openApi/swap/v2/user/positions', { symbol });
    if (response?.code === 0) {
      let positions = Array.isArray(response.data) ? response.data : [response.data];
      const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      if (position) {
        const positionAmt = parseFloat(position.positionAmt);
        const avgPrice = parseFloat(position.avgPrice) || parseFloat(position.entryPrice);
        confirmedPosition = {
          size: Math.abs(positionAmt),
          entryPrice: avgPrice,
          actualSide: position.positionSide || (positionAmt > 0 ? 'LONG' : 'SHORT')
        };
        break;
      }
    }
    await new Promise(r => setTimeout(r, 350));
  }
  if (!confirmedPosition) {
    confirmedPosition = {
      size: isReentry ? existingPosition.size + quantityToOrder : quantityToOrder,
      entryPrice: marketPrice,
      actualSide: posSide
    };
  }

  // ========== TP/SL FINAL SOBRE 100% DE LA POSICIÓN ==========
  let finalTpPercent = newTpPercent;
  let finalSlPercent = newSlPercent;
  if (isReentry) {
    if (newTpPercent === undefined || newTpPercent === null) finalTpPercent = inheritedTpPercent;
    if (newSlPercent === undefined || newSlPercent === null) finalSlPercent = inheritedSlPercent;
  }
  const quantityForTPSL = confirmedPosition.size;

  // Disparo instantáneo de TP/SL en paralelo (latencia mínima)
  if (trailingMode) {
    const trailingParams = { 
      symbol, 
      avgEntryPrice: confirmedPosition.entryPrice, 
      posSide, 
      positionSize: quantityForTPSL,
      tickSize: contract.tickSize, 
      trailingPercent, 
      minDistancePercent 
    };
    if (trailingMode === 'dynamic') dynamicTrailingStop(trailingParams);
    else if (trailingMode === 'be') trailingStopToBE(trailingParams);
  } else if (finalTpPercent || finalSlPercent) {
    const sltpSide = posSide === 'LONG' ? 'SELL' : 'BUY';
    const orderPromises = [];
    if (finalTpPercent && finalTpPercent > 0) {
      const finalTpPrice = roundToTickSizeUltraPrecise(
        confirmedPosition.entryPrice * (posSide === 'LONG' ? 1 + finalTpPercent / 100 : 1 - finalTpPercent / 100), 
        contract.tickSize
      );
      const payload = { 
        symbol, 
        positionSide: posSide, 
        side: sltpSide, 
        type: 'TAKE_PROFIT_MARKET', 
        quantity: quantityForTPSL,
        stopPrice: finalTpPrice, 
        workingType: 'MARK_PRICE' 
      };
      orderPromises.push(sendRequest('POST', '/openApi/swap/v2/trade/order', payload));
    }
    if (finalSlPercent && finalSlPercent > 0) {
      const finalSlPrice = roundToTickSizeUltraPrecise(
        confirmedPosition.entryPrice * (posSide === 'LONG' ? 1 - finalSlPercent / 100 : 1 + finalSlPercent / 100), 
        contract.tickSize
      );
      const payload = { 
        symbol, 
        positionSide: posSide, 
        side: sltpSide, 
        type: 'STOP_MARKET', 
        quantity: quantityForTPSL,
        stopPrice: finalSlPrice, 
        workingType: 'MARK_PRICE' 
      };
      orderPromises.push(sendRequest('POST', '/openApi/swap/v2/trade/order', payload));
    }
    await Promise.all(orderPromises);
  }

  return { 
    mainOrder: orderResp, 
    finalPosition: confirmedPosition, 
    trailingActivated: !!trailingMode,
    isReentry: isReentry,
    tpPercent: finalTpPercent,
    slPercent: finalSlPercent
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
  getExistingTPSLOrders,
  roundToTickSizeUltraPrecise,
  trailingStopToBE,
  dynamicTrailingStop
};
