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

async function sendRequest(method, path, payload) {
    const timestamp = Date.now();
    const parametersToSign = getParameters(payload, timestamp, false);
    const parametersForUrl = getParameters(payload, timestamp, true);
    const signature = sign(parametersToSign);
    const url = `https://${HOST}${path}?${parametersForUrl}&signature=${signature}`;

    const config = {
        method: method,
        url: url,
        headers: { 'X-BX-APIKEY': API_KEY },
        // 🚀 CRÍTICO: Manejo correcto de BigInt para Order IDs
        transformResponse: [(data) => {
            // NO usar JSON.parse automático que corrompe los BigInt
            return data; // Retornar string crudo
        }]
    };
    
    if (method.toUpperCase() === 'POST' || method.toUpperCase() === 'DELETE') {
        config.data = '';
        config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    try {
        const response = await fastAxios(config);
        
        // 🔧 Parseo manual conservando BigInt como string
        let responseData;
        if (typeof response.data === 'string') {
            // Reemplazar números grandes con strings para evitar corrupción
            const safeJson = response.data.replace(
                /"orderId":\s*(\d{16,})/g, 
                '"orderId":"$1"'
            ).replace(
                /"cancelOrderId":\s*(\d{16,})/g,
                '"cancelOrderId":"$1"'
            );
            
            try {
                responseData = JSON.parse(safeJson);
            } catch (e) {
                console.log('📄 Raw response data:', response.data);
                responseData = JSON.parse(response.data);
            }
        } else {
            responseData = response.data;
        }
        
        return responseData;
    } catch (err) {
        console.error(`❌ Error en la petición a ${path}:`, err.response?.data || err.message);
        return err.response?.data || { code: -1, msg: err.message };
    }
}

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

function cleanWebhookData(rawData) { return { ...rawData }; }

function validateWebhookData(data) {
    if (!data.symbol || !data.side) throw new Error(`Campos requeridos faltantes: symbol y side`);
    return data;
}

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

// 🚀 FUNCIÓN ULTRA RÁPIDA OPTIMIZADA
async function modifyPositionTPSL(params) {
  console.log('\n🔄 === INICIANDO MODIFICACIÓN DE TP/SL ULTRA RÁPIDA ===');
  const { symbol: rawSymbol, side, tpPercent, slPercent } = params;

  if (!tpPercent && !slPercent) {
    throw new Error('No se proporcionaron nuevos porcentajes de TP o SL para modificar.');
  }

  const symbol = normalizeSymbol(rawSymbol);
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  
  console.log(`   - Obteniendo detalles de la posición actual para ${symbol} (${posSide})...`);
  const currentPosition = await getPositionDetails(symbol, posSide);
  if (!currentPosition) {
    throw new Error(`No se encontró una posición ${posSide} abierta para ${symbol}.`);
  }
  console.log(`   - Posición encontrada: Tamaño Total=${currentPosition.size}, Disponible=${currentPosition.availableSize}, Precio Entrada=${currentPosition.entryPrice}`);

  console.log('\n🔍 === VERIFICANDO ÓRDENES TP/SL EXISTENTES ===');
  const existingOrders = await getExistingTPSLOrders(symbol);
  console.log(`   - Se encontraron ${existingOrders.length} órdenes TP/SL existentes`);
  
  if (existingOrders.length > 0) {
    // Mostrar detalles de órdenes existentes
    existingOrders.forEach((order, i) => {
      console.log(`     [${i+1}] ID: ${order.orderId}, Type: ${order.type}, Stop: ${order.stopPrice}`);
    });
  }

  const contract = await getContractInfo(symbol);
  
  // 🚀 OPTIMIZACIÓN 1: SALTARSE EL BATCH - IR DIRECTO A CANCELACIÓN RÁPIDA
  if (existingOrders.length > 0) {
    console.log('\n⚡ === CANCELACIÓN PARALELA ULTRA RÁPIDA ===');
    
    // 🔥 OPTIMIZACIÓN 2: CANCELAR TODAS SIMULTÁNEAMENTE (SIN DELAYS)
    const cancelPromises = existingOrders.map((order, i) => {
      const orderIdString = typeof order.orderId === 'string' ? order.orderId : order.orderId.toString();
      console.log(`     - [${i+1}] Enviando cancelación paralela para ID: ${orderIdString}`);
      
      return sendRequest('DELETE', '/openApi/swap/v2/trade/order', {
        symbol: order.symbol,
        orderId: orderIdString
      }).then(res => ({
        orderId: orderIdString,
        success: res.code === 0,
        error: res.msg
      }));
    });
    
    console.log(`   - 🚀 Ejecutando ${existingOrders.length} cancelaciones en paralelo...`);
    const cancelResults = await Promise.all(cancelPromises);
    
    // Mostrar resultados de cancelación
    let canceledCount = 0;
    cancelResults.forEach((result, i) => {
      if (result.success) {
        console.log(`     [${i+1}] ✅ Cancelada: ${result.orderId}`);
        canceledCount++;
      } else {
        console.log(`     [${i+1}] ❌ Error: ${result.error}`);
      }
    });
    
    console.log(`   - 📊 Canceladas: ${canceledCount}/${existingOrders.length}`);
    
    // 🔥 OPTIMIZACIÓN 3: TIMEOUT REDUCIDO (1.5s en lugar de 3s)
    console.log('   - ⚡ Esperando 1.5 segundos optimizados para procesamiento...');
    await new Promise(r => setTimeout(r, 1500));
  }
  
  // 🚀 OPTIMIZACIÓN 4: CREACIÓN PARALELA DE ÓRDENES TP/SL
  console.log('\n⚡ === CREACIÓN PARALELA DE NUEVAS ÓRDENES TP/SL ===');
  
  const createPromises = [];
  
  if (tpPercent && tpPercent > 0) {
    console.log(`   - 🎯 Preparando TP (${tpPercent}%) para creación paralela...`);
    createPromises.push(
      createSingleTPSLOrder(symbol, posSide, currentPosition, contract, true, tpPercent)
        .then(result => ({ type: 'TP', success: result.success, error: result.error }))
    );
  }
  
  if (slPercent && slPercent > 0) {
    console.log(`   - 🛡️ Preparando SL (${slPercent}%) para creación paralela...`);
    createPromises.push(
      createSingleTPSLOrder(symbol, posSide, currentPosition, contract, false, slPercent)
        .then(result => ({ type: 'SL', success: result.success, error: result.error }))
    );
  }
  
  if (createPromises.length > 0) {
    console.log(`   - ⚡ Ejecutando ${createPromises.length} creaciones en paralelo...`);
    const createResults = await Promise.all(createPromises);
    
    // Procesar resultados
    let tpSuccess = false, slSuccess = false;
    let errors = [];
    
    createResults.forEach(result => {
      if (result.type === 'TP') {
        tpSuccess = result.success;
        if (result.success) {
          console.log(`     - ✅ TP creado exitosamente en paralelo`);
        } else {
          console.log(`     - ❌ Error creando TP: ${result.error}`);
          errors.push(result.error);
        }
      } else if (result.type === 'SL') {
        slSuccess = result.success;
        if (result.success) {
          console.log(`     - ✅ SL creado exitosamente en paralelo`);
        } else {
          console.log(`     - ❌ Error creando SL: ${result.error}`);
          errors.push(result.error);
        }
      }
    });
    
    console.log('\n⚡ === PROCESO ULTRA RÁPIDO COMPLETADO ===');
    return {
      summary: {
        mainSuccess: tpSuccess || slSuccess,
        finalTPStatus: tpSuccess,
        finalSLStatus: slSuccess,
        optimized: true,
        parallelProcessing: true
      },
      error: errors.length > 0 ? errors.join(', ') : null
    };
  }
  
  console.log('\n⚠️ === NO HAY ÓRDENES QUE CREAR ===');
  return {
    summary: {
      mainSuccess: false,
      finalTPStatus: false,
      finalSLStatus: false,
      optimized: true
    },
    error: 'No se especificaron porcentajes válidos'
  };
}

// Nueva función auxiliar para crear una sola orden TP o SL
async function createSingleTPSLOrder(symbol, posSide, currentPosition, contract, isTP, percent) {
  const sltpSide = posSide === 'LONG' ? 'SELL' : 'BUY';
  const orderType = isTP ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
  const label = isTP ? 'TP' : 'SL';
  
  // Calcular precio
  const price = currentPosition.entryPrice * (1 + (isTP ? 1 : -1) * (posSide === 'LONG' ? 1 : -1) * percent / 100);
  const stopPrice = roundToTickSizeUltraPrecise(price, contract.tickSize);
  
  const payload = {
    symbol, 
    positionSide: posSide, 
    side: sltpSide,
    type: orderType,
    quantity: currentPosition.size,
    stopPrice: stopPrice,
    workingType: 'MARK_PRICE'
  };

  console.log(`     - Creando ${label} individual a ${stopPrice}...`);
  const res = await sendRequest('POST', '/openApi/swap/v2/trade/order', payload);
  
  if (res.code === 0) {
    console.log(`     - ✅ ${label} creado exitosamente`);
    return { success: true, order: res.data };
  } else {
    console.log(`     - ❌ Error creando ${label}: ${res.msg}`);
    return { success: false, error: res.msg };
  }
}

async function placeOrder(params) {
  console.log('\n🚀 === INICIANDO PROCESO DE ORDEN AVANZADO ===');
  const { symbol: rawSymbol, side, leverage = 5, usdtAmount = 10, type = 'MARKET', tpPercent: newTpPercent, slPercent: newSlPercent } = validateWebhookData(cleanWebhookData(params));
  const symbol = normalizeSymbol(rawSymbol);
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  console.log(`🎯 ${symbol} | ${posSide} | ${usdtAmount} USDT @ ${leverage}x`);

  const [contract, marketPrice] = await Promise.all([getContractInfo(symbol), getCurrentPrice(symbol)]);
  
  const existingPosition = await checkExistingPosition(symbol, posSide);
  let inheritedTpPercent = null, inheritedSlPercent = null;
  if (existingPosition.isReentry) {
    console.log(`\n🔄 === REENTRADA DETECTADA. Posición actual: ${existingPosition.size} @ ${existingPosition.entryPrice}`);
    
    // 🧠 LÓGICA INTELIGENTE: Heredar TP/SL si no se especifican nuevos
    const existingOrders = await getExistingTPSLOrders(symbol);
    if (existingOrders.length > 0) {
      const percents = calculateTPSLPercentsFromOrders(existingOrders, existingPosition.entryPrice);
      inheritedTpPercent = percents.tpPercent; 
      inheritedSlPercent = percents.slPercent;
      
      console.log(`   - 📊 TP/SL actuales detectados: TP=${inheritedTpPercent?.toFixed(2)}%, SL=${inheritedSlPercent?.toFixed(2)}%`);
      
      // 🎯 Decidir qué porcentajes usar (nuevos tienen prioridad)
      const finalTpPercent = newTpPercent ?? inheritedTpPercent;
      const finalSlPercent = newSlPercent ?? inheritedSlPercent;
      
      if (!newTpPercent && !newSlPercent) {
        console.log(`   - 🧠 MODO HERENCIA: Usando porcentajes actuales para posición expandida`);
      } else {
        console.log(`   - 🔄 MODO CAMBIO: Aplicando nuevos porcentajes a posición expandida`);
      }
      
      console.log(`   - ✅ Porcentajes finales: TP=${finalTpPercent?.toFixed(2)}%, SL=${finalSlPercent?.toFixed(2)}%`);
    }
  }

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

  if (existingPosition.isReentry) {
    console.log('\n🗑️ === CANCELACIÓN INTELIGENTE DE TP/SL ANTIGUOS ===');
    
    // 🚀 OPTIMIZACIÓN: Cancelación paralela ultra rápida para reentradas
    const existingOrders = await getExistingTPSLOrders(symbol);
    if (existingOrders.length > 0) {
      console.log(`   - 🔍 Encontradas ${existingOrders.length} órdenes TP/SL que actualizar`);
      
      const cancelPromises = existingOrders.map((order, i) => {
        const orderIdString = typeof order.orderId === 'string' ? order.orderId : order.orderId.toString();
        console.log(`     - [${i+1}] Cancelando ID: ${orderIdString} en paralelo`);
        
        return sendRequest('DELETE', '/openApi/swap/v2/trade/order', {
          symbol: order.symbol,
          orderId: orderIdString
        }).then(res => ({
          orderId: orderIdString,
          success: res.code === 0,
          error: res.msg
        }));
      });
      
      console.log(`   - ⚡ Ejecutando cancelaciones paralelas...`);
      const cancelResults = await Promise.all(cancelPromises);
      
      let canceledCount = 0;
      cancelResults.forEach((result, i) => {
        if (result.success) {
          console.log(`     [${i+1}] ✅ Cancelada correctamente`);
          canceledCount++;
        } else {
          console.log(`     [${i+1}] ❌ Error: ${result.error}`);
        }
      });
      
      console.log(`   - 📊 Resultado: ${canceledCount}/${existingOrders.length} canceladas exitosamente`);
      console.log('   - ⚡ Esperando 1.5s optimizado para procesamiento...');
      await new Promise(r => setTimeout(r, 1500));
    } else {
      console.log('   - ℹ️ No hay órdenes TP/SL que cancelar');
    }
  }

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

  const finalTpPercent = newTpPercent ?? inheritedTpPercent;
  const finalSlPercent = newSlPercent ?? inheritedSlPercent;
  if (!finalTpPercent && !finalSlPercent) {
    console.log('\nℹ️ No se configuraron TP/SL (no especificados ni heredados).');
    return { mainOrder: orderResp, finalPosition: confirmedPosition };
  }
  
  console.log(`\n🎯 === CONFIGURANDO TP/SL INTELIGENTES ===`);
  
  // 🧠 Mostrar lógica aplicada
  if (existingPosition.isReentry) {
    if (!newTpPercent && !newSlPercent) {
      console.log(`   - 🧠 MODO HERENCIA: Aplicando porcentajes existentes al 100% de la posición expandida`);
    } else if (newTpPercent || newSlPercent) {
      console.log(`   - 🔄 MODO ACTUALIZACIÓN: Aplicando nuevos porcentajes al 100% de la posición expandida`);
    }
  } else {
    console.log(`   - 🆕 MODO NUEVA POSICIÓN: Aplicando porcentajes especificados`);
  }
  
  console.log(`   - 📊 Cantidad total de posición: ${confirmedPosition.size}`);
  console.log(`   - 🎯 TP: ${finalTpPercent?.toFixed(2)}% | SL: ${finalSlPercent?.toFixed(2)}%`);
  
  // 🚀 Creación paralela de TP/SL (ultra optimizada)
  const createPromises = [];
  
  if (finalTpPercent && finalTpPercent > 0) {
    console.log(`   - 🎯 Preparando TP (${finalTpPercent}%) para toda la posición...`);
    createPromises.push(
      createSingleTPSLOrder(symbol, posSide, confirmedPosition, contract, true, finalTpPercent)
        .then(result => ({ type: 'TP', success: result.success, error: result.error }))
    );
  }
  
  if (finalSlPercent && finalSlPercent > 0) {
    console.log(`   - 🛡️ Preparando SL (${finalSlPercent}%) para toda la posición...`);
    createPromises.push(
      createSingleTPSLOrder(symbol, posSide, confirmedPosition, contract, false, finalSlPercent)
        .then(result => ({ type: 'SL', success: result.success, error: result.error }))
    );
  }
  
  if (createPromises.length > 0) {
    console.log(`   - ⚡ Ejecutando ${createPromises.length} creaciones TP/SL en paralelo...`);
    const createResults = await Promise.all(createPromises);
    
    // Procesar resultados
    let tpSuccess = false, slSuccess = false;
    createResults.forEach(result => {
      if (result.type === 'TP') {
        tpSuccess = result.success;
        if (result.success) {
          console.log(`   - ✅ TP configurado exitosamente para toda la posición`);
        } else {
          console.log(`   - ❌ Error configurando TP: ${result.error}`);
        }
      } else if (result.type === 'SL') {
        slSuccess = result.success;
        if (result.success) {
          console.log(`   - ✅ SL configurado exitosamente para toda la posición`);
        } else {
          console.log(`   - ❌ Error configurando SL: ${result.error}`);
        }
      }
    });
    
    console.log('\n🎯 === TP/SL INTELIGENTES CONFIGURADOS ===');
  }

  console.log('\n✅ === PROCESO DE ORDEN FINALIZADO ===');
  return { mainOrder: orderResp, finalPosition: confirmedPosition };
}

module.exports = {
  placeOrder,
  modifyPositionTPSL,
  closeAllPositions,
  getUSDTBalance,
  getCurrentPrice,
  getContractInfo,
  getPositionDetails,
  checkExistingPosition,
  getExistingTPSLOrders,
  setLeverage,
  normalizeSymbol,
  cleanWebhookData,
  validateWebhookData,
  calculateTPSLPercentsFromOrders
};
