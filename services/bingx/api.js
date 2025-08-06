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
    
    // <-- ¡¡¡LA CORRECCIÓN MÁS IMPORTANTE Y DEFINITIVA ESTÁ AQUÍ!!! -->
    if (method.toUpperCase() === 'POST' || method.toUpperCase() === 'DELETE') {
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
  await sendRequest('POST', '/openApi/swap/v2/trade/leverage', payload);
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
  } catch (e) { console.log('⚠️ Error obteniendo contrato:', e.message); }
  return { minOrderQty: 0.001, tickSize: 0.00001, stepSize: 0.001, minNotional: 1, maxLeverage: 20 };
}

// ========== LIMPIEZA Y VALIDACIÓN ==========
function cleanWebhookData(rawData) { return { ...rawData }; }

function validateWebhookData(data) {
    if (!data.symbol || !data.side) throw new Error(`Campos requeridos faltantes: symbol y side`);
    return data;
}

// ========== GESTIÓN DE POSICIONES ==========

async function getPositionDetails(symbol, positionSide) {
  try {
    const payload = { symbol };
    const response = await sendRequest('GET', '/openApi/swap/v2/user/positions', payload);
    if (response?.code === 0) {
      let positions = Array.isArray(response.data) ? response.data : [response.data].filter(Boolean);
      for (const position of positions) {
        const actualSide = position.positionSide || (parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT');
        if (position.symbol === symbol && actualSide === positionSide && parseFloat(position.positionAmt) !== 0) {
          return { 
            size: Math.abs(parseFloat(position.positionAmt)),
            availableSize: Math.abs(parseFloat(position.availableAmt)),
            entryPrice: parseFloat(position.avgPrice) || parseFloat(position.entryPrice),
            side: actualSide
          };
        }
      }
    }
    return null;
  } catch (error) {
    console.error('❌ Error en getPositionDetails:', error.message);
    return null;
  }
}

async function checkExistingPosition(symbol, newSide) {
  const position = await getPositionDetails(symbol, newSide);
  if (position) {
    return { 
      exists: true, 
      side: position.side, 
      size: position.size, 
      entryPrice: position.entryPrice, 
      isReentry: position.side === newSide 
    };
  }
  return { exists: false, isReentry: false };
}

async function cancelManualAllTPSLOrders(symbol) {
    console.log(`   - 1. Obteniendo la lista de órdenes abiertas para ${symbol}...`);
    const listRes = await sendRequest('GET', '/openApi/swap/v2/trade/openOrders', { symbol });

    if (listRes.code !== 0 || !listRes.data?.orders) {
        console.log('   - No se pudieron obtener las órdenes abiertas o no hay ninguna.');
        return;
    }

    const tpslOrders = listRes.data.orders.filter(o => ['TAKE_PROFIT_MARKET', 'STOP_MARKET', 'TAKE_PROFIT', 'STOP'].includes(o.type));
    
    if (tpslOrders.length === 0) {
        console.log('   - No se encontraron órdenes TP/SL para cancelar.');
        return;
    }

    console.log(`   - 2. Se encontraron ${tpslOrders.length} órdenes TP/SL. Procediendo a cancelar una por una...`);
    const cancelPromises = tpslOrders.map(order => {
        console.log(`      - Enviando cancelación para Order ID: ${order.orderId}`);
        return sendRequest('DELETE', '/openApi/swap/v2/trade/order', {
            symbol: order.symbol,
            orderId: order.orderId
        });
    });

    await Promise.all(cancelPromises);
    console.log(`   - 3. Solicitudes de cancelación para ${tpslOrders.length} órdenes enviadas.`);
}


async function getUSDTBalance() {
  const res = await sendRequest('GET', '/openApi/swap/v2/user/balance', {});
  return res.code === 0 && res.data?.balance ? parseFloat(res.data.balance.balance) : 0;
}

async function closeAllPositions(symbol) {
  const res = await sendRequest('POST', '/openApi/swap/v2/trade/closeAllPositions', { symbol: normalizeSymbol(symbol) });
  console.log(`✅ Solicitud de cerrar todas las posiciones para ${symbol} enviada.`);
  return res;
}

async function getExistingTPSLOrders(symbol) {
  const res = await sendRequest('GET', '/openApi/swap/v2/trade/openOrders', { symbol });
  if (res?.code === 0 && res.data?.orders) {
    return res.data.orders.filter(o => ['TAKE_PROFIT_MARKET', 'STOP_MARKET', 'TAKE_PROFIT', 'STOP'].includes(o.type));
  }
  return [];
}

function calculateTPSLPercentsFromOrders(orders, entryPrice) {
  let tpPercent = null, slPercent = null;
  for (const order of orders) {
    const stopPrice = parseFloat(order.stopPrice);
    if (!stopPrice) continue;
    const priceDiff = Math.abs(stopPrice - entryPrice) / entryPrice * 100;
    if (order.type.includes('TAKE_PROFIT')) tpPercent = priceDiff;
    else if (order.type.includes('STOP')) slPercent = priceDiff;
  }
  return { tpPercent, slPercent };
}


// ========== FUNCIÓN PRINCIPAL OPTIMIZADA ==========
async function placeOrder(params) {
  console.log('\n🚀 === INICIANDO PROCESO DE ORDEN AVANZADO ===');
  const { symbol: rawSymbol, side, leverage = 5, usdtAmount = 10, type = 'MARKET', tpPercent: newTpPercent, slPercent: newSlPercent } = validateWebhookData(cleanWebhookData(params));
  const symbol = normalizeSymbol(rawSymbol);
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  console.log(`🎯 ${symbol} | ${posSide} | ${usdtAmount} USDT @ ${leverage}x`);

  const [contract, marketPrice] = await Promise.all([getContractInfo(symbol), getCurrentPrice(symbol)]);
  
  // 1. VERIFICAR REENTRADA
  const existingPosition = await checkExistingPosition(symbol, posSide);
  let inheritedTpPercent = null, inheritedSlPercent = null;
  if (existingPosition.isReentry) {
    console.log(`\n🔄 === REENTRADA DETECTADA. Posición actual: ${existingPosition.size} @ ${existingPosition.entryPrice}`);
    const existingOrders = await getExistingTPSLOrders(symbol);
    if (existingOrders.length > 0) {
      const percents = calculateTPSLPercentsFromOrders(existingOrders, existingPosition.entryPrice);
      inheritedTpPercent = percents.tpPercent; inheritedSlPercent = percents.slPercent;
    }
  }

  // 2. EJECUTAR ORDEN PRINCIPAL
  await setLeverage(symbol, leverage, posSide);
  const orderValue = usdtAmount * leverage;
  if (orderValue < contract.minNotional) {
      throw new Error(`El valor de la orden (${orderValue.toFixed(2)} USDT) es menor que el mínimo nocional requerido por el exchange (${contract.minNotional} USDT).`);
  }
  const quantityToOrder = roundToTickSizeUltraPrecise(orderValue / marketPrice, contract.stepSize);
  if (quantityToOrder < contract.minOrderQty) {
      throw new Error(`La cantidad a ordenar (${quantityToOrder}) es menor que la mínima requerida por el exchange (${contract.minOrderQty}).`);
  }
  const mainPayload = { symbol, side: side.toUpperCase(), positionSide: posSide, type, quantity: quantityToOrder };
  const orderResp = await sendRequest('POST', '/openApi/swap/v2/trade/order', mainPayload);
  if (orderResp.code !== 0) throw new Error(`Error en orden principal: ${orderResp.msg}`);
  console.log('✅ Orden principal ejecutada.');

  // 3. CANCELACIÓN MANUAL Y ROBUSTA (SOLO EN REENTRADAS)
  if (existingPosition.isReentry) {
    console.log('\n🗑️ === PROCESO DE CANCELACIÓN MANUAL Y ROBUSTA ===');
    await cancelManualAllTPSLOrders(symbol);

    console.log('   - 4. Verificando que las órdenes se hayan cancelado...');
    for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1500));
        
        const remainingOrders = await getExistingTPSLOrders(symbol);
        if (remainingOrders.length === 0) {
            console.log('   - ✅ Verificado: Todas las órdenes TP/SL antiguas han sido eliminadas.');
            break; 
        }

        if (i === 7) {
            throw new Error(`No se pudo confirmar la cancelación de ${remainingOrders.length} órdenes antiguas después de varios intentos.`);
        }
        
        console.log(`   - Verificando... Aún quedan ${remainingOrders.length} órdenes abiertas. Reintentando...`);
    }
  }

  // 4. OBTENER POSICIÓN CONSOLIDADA FINAL
  console.log('\n🔍 Obteniendo posición consolidada final...');
  let confirmedPosition;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const pos = await getPositionDetails(symbol, posSide);
    if (pos) {
        if (existingPosition.isReentry && pos.size > existingPosition.size && pos.size === pos.availableSize) {
            confirmedPosition = pos; break;
        } else if (!existingPosition.isReentry && pos.size > 0 && pos.size === pos.availableSize) {
            confirmedPosition = pos; break;
        }
    }
    if (i === 9) throw new Error("No se pudo obtener la posición consolidada y disponible.");
    console.log(`   - Intento ${i + 1}: Posición aún no disponible/consolidada. Reintentando...`);
  }
  console.log(`✅ Posición final confirmada: Tamaño=${confirmedPosition.size}, Disponible=${confirmedPosition.availableSize}, Precio=${confirmedPosition.entryPrice}`);

  // 5. DETERMINAR Y CONFIGURAR TP/SL FINAL
  const finalTpPercent = newTpPercent ?? inheritedTpPercent;
  const finalSlPercent = newSlPercent ?? inheritedSlPercent;
  if (!finalTpPercent && !finalSlPercent) {
    console.log('\nℹ️ No se configuraron TP/SL (no especificados).');
    return { mainOrder: orderResp, finalPosition: confirmedPosition };
  }
  
  console.log(`\n🎯 === CONFIGURANDO NUEVAS ÓRDENES TP/SL ===`);
  console.log(`   - Usando cantidad: ${confirmedPosition.availableSize} | TP: ${finalTpPercent?.toFixed(2)}% | SL: ${finalSlPercent?.toFixed(2)}%`);

  const sltpSide = posSide === 'LONG' ? 'SELL' : 'BUY';
  const placeTPSL = async (isTP, percent) => {
    if (!percent || percent <= 0) return;
    const price = confirmedPosition.entryPrice * (1 + (isTP ? 1 : -1) * (posSide === 'LONG' ? 1 : -1) * percent / 100);
    const stopPrice = roundToTickSizeUltraPrecise(price, contract.tickSize);
    const payload = { 
      symbol, positionSide: posSide, side: sltpSide, 
      type: isTP ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET', 
      quantity: confirmedPosition.availableSize,
      stopPrice, workingType: 'MARK_PRICE' 
    };
    
    for (let i = 0; i < 5; i++) {
        console.log(`   - Enviando ${isTP ? 'TP' : 'SL'} a ${stopPrice} (Intento ${i + 1})...`);
        const res = await sendRequest('POST', '/openApi/swap/v2/trade/order', payload);
        if (res.code === 0) {
            console.log(`   - Respuesta de ${isTP ? 'TP' : 'SL'}: ✅ Éxito`);
            return;
        }
        
        console.log(`   - Respuesta de ${isTP ? 'TP' : 'SL'}: ❌ Fallo: ${res.msg}`);
        if (!res.msg.includes("available amount")) {
            break;
        }
        if (i < 4) await new Promise(r => setTimeout(r, 2000));
    }
  };

  await placeTPSL(true, finalTpPercent);
  await placeTPSL(false, finalSlPercent);

  console.log('\n✅ === PROCESO DE ORDEN FINALIZADO ===');
  return { mainOrder: orderResp, finalPosition: confirmedPosition };
}

// ========== EXPORTACIONES COMPLETAS (PARA MÁXIMA FLEXIBILIDAD) ==========
module.exports = {
  placeOrder,
  closeAllPositions,
  getUSDTBalance,
  getCurrentPrice,
  getContractInfo,
  getPositionDetails,
  checkExistingPosition,
  getExistingTPSLOrders,
  setLeverage,
  cancelManualAllTPSLOrders, // Exportando el nombre correcto
  normalizeSymbol,
  cleanWebhookData,
  validateWebhookData,
  calculateTPSLPercentsFromOrders
};
