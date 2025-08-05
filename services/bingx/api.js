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

// 🔧 FUNCIÓN OFICIAL DE BINGX (basada en su documentación)
function getParameters(payload, timestamp, urlEncode = false) {
    let parameters = "";
    
    // 1. Recorrer payload en orden de inserción (NO ordenar alfabéticamente)
    for (const key in payload) {
        const value = payload[key];
        if (urlEncode) {
            parameters += `${key}=${encodeURIComponent(value)}&`;
        } else {
            parameters += `${key}=${value}&`;
        }
    }
    
    // 2. Quitar el último '&' si hay parámetros
    if (parameters) {
        parameters = parameters.substring(0, parameters.length - 1);
        // 3. Añadir timestamp AL FINAL (NO ordenado)
        parameters = `${parameters}&timestamp=${timestamp}`;
    } else {
        // 4. Si no hay parámetros, solo timestamp
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
    
    // 1. Parámetros para firma (sin encoding)
    const parametersToSign = getParameters(payload, timestamp, false);
    
    // 2. Parámetros para URL (con encoding)
    const parametersForUrl = getParameters(payload, timestamp, true);
    
    // 3. Crear firma
    const signature = sign(parametersToSign);
    
    // 4. Construir URL final
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
        
        // Verificar que no hay NaN
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

// ========== GESTIÓN DE POSICIONES MEJORADA (CON LOGS DETALLADOS) ==========

async function getCurrentPositionSize(symbol, positionSide) {
  try {
    console.log(`🔍 [DEBUG] Buscando posición: ${symbol} ${positionSide}`);
    
    // 1. Petición específica por símbolo (más directo)
    const payload = { symbol };
    const response = await sendRequest('GET', '/openApi/swap/v2/user/positions', payload);
    
    console.log(`📡 [DEBUG] Respuesta API positions:`, JSON.stringify(response, null, 2));
    
    if (response?.code === 0) {
      // 2. Manejar tanto array como objeto único
      let positions = response.data;
      if (!Array.isArray(positions)) {
        positions = positions ? [positions] : [];
      }
      
      console.log(`📊 [DEBUG] Posiciones encontradas: ${positions.length}`);
      
      // 3. Buscar la posición específica
      for (const position of positions) {
        console.log(`🔎 [DEBUG] Evaluando posición:`, {
          symbol: position.symbol,
          positionAmt: position.positionAmt,
          avgPrice: position.avgPrice,
          entryPrice: position.entryPrice
        });
        
        if (position.symbol === symbol) {
          const positionAmt = parseFloat(position.positionAmt);
          console.log(`💰 [DEBUG] positionAmt parseado: ${positionAmt}`);
          
          if (positionAmt !== 0) {
            const absSize = Math.abs(positionAmt);
            // ✅ USAR EL CAMPO positionSide DE LA API (NO calcular desde positionAmt)
            const actualSide = position.positionSide || (positionAmt > 0 ? 'LONG' : 'SHORT');
            
            console.log(`📈 [DEBUG] Comparación de lados:`, {
              actualSide,
              expectedSide: positionSide,
              match: actualSide === positionSide,
              apiPositionSide: position.positionSide
            });
            
            if (actualSide === positionSide) {
              // 4. Obtener precio de entrada (probar múltiples campos)
              let entryPrice = parseFloat(position.avgPrice) || parseFloat(position.entryPrice) || parseFloat(position.markPrice);
              
              console.log(`✅ [DEBUG] Posición encontrada:`, {
                size: absSize,
                entryPrice: entryPrice,
                actualSide: actualSide
              });
              
              return { 
                size: absSize, 
                entryPrice: entryPrice,
                actualSide: actualSide 
              };
            } else {
              console.log(`⚠️ [DEBUG] Lado no coincide: esperado ${positionSide}, encontrado ${actualSide}`);
            }
          } else {
            console.log(`⚠️ [DEBUG] Posición con cantidad 0: ${positionAmt}`);
          }
        }
      }
      
      console.log(`❌ [DEBUG] No se encontró posición válida para ${symbol} ${positionSide}`);
    } else {
      console.log(`❌ [DEBUG] Error en respuesta API:`, response);
    }
    
    return null;
  } catch (error) {
    console.error('❌ [DEBUG] Error en getCurrentPositionSize:', error.message);
    return null;
  }
}

async function checkExistingPosition(symbol, newSide) {
  try {
    console.log(`🔍 [DEBUG] Verificando posición existente: ${symbol} para ${newSide}`);
    
    const payload = { symbol };
    const response = await sendRequest('GET', '/openApi/swap/v2/user/positions', payload);
    
    console.log(`📡 [DEBUG] Respuesta checkExistingPosition:`, JSON.stringify(response, null, 2));
    
    if (response?.code === 0) {
      let positions = response.data;
      if (!Array.isArray(positions)) {
        positions = positions ? [positions] : [];
      }
      
      for (const position of positions) {
        if (position.symbol === symbol) {
          const positionAmt = parseFloat(position.positionAmt);
          
          if (positionAmt !== 0) {
            // ✅ USAR EL CAMPO positionSide DE LA API
            const existingSide = position.positionSide || (positionAmt > 0 ? 'LONG' : 'SHORT');
            const size = Math.abs(positionAmt);
            const entryPrice = parseFloat(position.avgPrice) || parseFloat(position.entryPrice);
            const isReentry = existingSide === newSide;
            
            console.log(`📊 [DEBUG] Posición existente encontrada:`, {
              side: existingSide,
              size: size,
              entryPrice: entryPrice,
              isReentry: isReentry
            });
            
            return { 
              exists: true, 
              side: existingSide, 
              size: size, 
              entryPrice: entryPrice, 
              isReentry: isReentry 
            };
          }
        }
      }
    }
    
    console.log(`📊 [DEBUG] No existe posición previa para ${symbol}`);
    return { exists: false, isReentry: false };
  } catch (error) {
    console.error('❌ [DEBUG] Error en checkExistingPosition:', error.message);
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

// ========== NUEVAS FUNCIONES PARA MANEJO DE TP/SL EXISTENTES ==========
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

function calculateTPSLPercentsFromOrders(orders, entryPrice, positionSide) {
  let tpPercent = null;
  let slPercent = null;
  
  for (const order of orders) {
    const stopPrice = parseFloat(order.stopPrice);
    if (!stopPrice) continue;
    
    const priceDiff = Math.abs(stopPrice - entryPrice) / entryPrice * 100;
    
    if (order.type === 'TAKE_PROFIT_MARKET' || order.type === 'TAKE_PROFIT') {
      tpPercent = priceDiff;
      console.log(`📊 TP existente detectado: ${priceDiff.toFixed(2)}% (precio: ${stopPrice})`);
    } else if (order.type === 'STOP_MARKET' || order.type === 'STOP') {
      slPercent = priceDiff;
      console.log(`📊 SL existente detectado: ${priceDiff.toFixed(2)}% (precio: ${stopPrice})`);
    }
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

// ========== FUNCIÓN PRINCIPAL OPTIMIZADA PARA REENTRADAS ==========
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
  console.log(`🎯 ${symbol} | ${posSide} | ${usdtAmount} USDT @ ${leverage}x`);

  const [contract, marketPrice] = await Promise.all([getContractInfo(symbol), getCurrentPrice(symbol)]);
  console.log(`📊 Mercado: Precio=${marketPrice}, MinQty=${contract.minOrderQty}, StepSize=${contract.stepSize}, TickSize=${contract.tickSize}`);

  // ========== PASO 1: VERIFICAR SI ES REENTRADA ==========
  const existingPosition = await checkExistingPosition(symbol, posSide);
  let isReentry = false;
  let inheritedTpPercent = null;
  let inheritedSlPercent = null;
  
  if (existingPosition.isReentry) {
    console.log(`\n🔄 === REENTRADA DETECTADA ===`);
    console.log(`📊 Posición existente: ${existingPosition.size} unidades @ ${existingPosition.entryPrice}`);
    isReentry = true;
    
    // Obtener las órdenes TP/SL existentes ANTES de cancelarlas
    const existingOrders = await getExistingTPSLOrders(symbol);
    if (existingOrders.length > 0) {
      const existingPercents = calculateTPSLPercentsFromOrders(
        existingOrders, 
        existingPosition.entryPrice, 
        posSide
      );
      inheritedTpPercent = existingPercents.tpPercent;
      inheritedSlPercent = existingPercents.slPercent;
      console.log(`📊 Porcentajes TP/SL heredados: TP=${inheritedTpPercent?.toFixed(2)}%, SL=${inheritedSlPercent?.toFixed(2)}%`);
    }
  }

  // ========== PASO 2: CONFIGURAR LEVERAGE Y EJECUTAR ORDEN ==========
  await setLeverage(symbol, leverage, posSide);

  const quantityToOrder = roundToTickSizeUltraPrecise((usdtAmount * leverage) / marketPrice, contract.stepSize);
  console.log(`📏 Cantidad calculada: ${quantityToOrder}`);
  if (quantityToOrder < contract.minOrderQty) {
    throw new Error(`Error de Cantidad: La cantidad calculada (${quantityToOrder}) es menor que la mínima permitida por el contrato (${contract.minOrderQty}).`);
  }

  const mainPayload = { 
    symbol, 
    side: side.toUpperCase(), 
    positionSide: posSide, 
    type, 
    quantity: quantityToOrder 
  };
  
  console.log('\n📤 Enviando orden principal...');
  const orderResp = await sendRequest('POST', '/openApi/swap/v2/trade/order', mainPayload);
  if (orderResp.code !== 0) throw new Error(`Error API en orden principal: ${orderResp.msg}`);
  console.log('✅ Orden principal ejecutada exitosamente.');

  // ========== PASO 3: ESPERAR Y CANCELAR ÓRDENES EXISTENTES (SOLO EN REENTRADAS) ==========
  if (isReentry) {
    console.log('\n⏳ Esperando 1 segundo para consolidación...');
    await new Promise(r => setTimeout(r, 1000));
    
    console.log('🗑️ Cancelando TODAS las órdenes TP/SL existentes...');
    const cancelCount = await cancelAllTPSLOrders(symbol);
    if (cancelCount > 0) {
      console.log(`✅ ${cancelCount} órdenes canceladas. Esperando procesamiento...`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // ========== PASO 4: OBTENER POSICIÓN CONSOLIDADA FINAL ==========
  console.log('\n🔍 Obteniendo posición consolidada final...');
  let confirmedPosition = null;
  let maxAttempts = 15;
  
  for (let i = 0; i < maxAttempts; i++) {
    console.log(`🔄 Intento ${i + 1}/${maxAttempts} verificando posición consolidada...`);
    
    const response = await sendRequest('GET', '/openApi/swap/v2/user/positions', { symbol });
    
    if (response?.code === 0) {
      let positions = Array.isArray(response.data) ? response.data : [response.data];
      const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
      if (position) {
        const positionAmt = parseFloat(position.positionAmt);
        const availableAmt = parseFloat(position.availableAmt) || Math.abs(positionAmt);
        const avgPrice = parseFloat(position.avgPrice) || parseFloat(position.entryPrice);
        
        confirmedPosition = {
          size: Math.abs(positionAmt),
          availableSize: availableAmt,
          entryPrice: avgPrice,
          actualSide: position.positionSide || (positionAmt > 0 ? 'LONG' : 'SHORT')
        };
        
        console.log(`✅ Posición consolidada confirmada:`);
        console.log(`   - Tamaño total: ${confirmedPosition.size}`);
        console.log(`   - Disponible: ${confirmedPosition.availableSize}`);
        console.log(`   - Precio promedio: ${confirmedPosition.entryPrice}`);
        console.log(`   - Lado: ${confirmedPosition.actualSide}`);
        
        // Verificar que la consolidación está completa
        if (isReentry) {
          const expectedSize = existingPosition.size + quantityToOrder;
          const tolerance = 0.1; // Tolerancia del 0.1%
          
          if (Math.abs(confirmedPosition.size - expectedSize) / expectedSize < tolerance / 100) {
            console.log(`✅ Consolidación verificada: ${confirmedPosition.size} ≈ ${expectedSize}`);
            break;
          } else if (i < 5) {
            console.log(`⏳ Esperando consolidación completa... (${confirmedPosition.size} vs ${expectedSize} esperado)`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
        } else {
          break; // Para nuevas posiciones, aceptar inmediatamente
        }
      }
    }
    
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  if (!confirmedPosition) {
    // Fallback si no se puede confirmar la posición
    console.log('⚠️ No se pudo confirmar la posición consolidada, usando valores calculados...');
    const totalSize = isReentry ? existingPosition.size + quantityToOrder : quantityToOrder;
    confirmedPosition = {
      size: totalSize,
      availableSize: totalSize,
      entryPrice: marketPrice,
      actualSide: posSide
    };
  }

  // ========== PASO 5: DETERMINAR QUÉ TP/SL USAR ==========
  let finalTpPercent = newTpPercent;
  let finalSlPercent = newSlPercent;
  
  if (isReentry) {
    // Si la nueva orden NO especifica TP/SL, heredar los anteriores
    if (newTpPercent === undefined || newTpPercent === null) {
      finalTpPercent = inheritedTpPercent;
      if (inheritedTpPercent !== null) {
        console.log(`📊 Heredando TP anterior: ${finalTpPercent?.toFixed(2)}%`);
      }
    } else {
      console.log(`📊 Usando NUEVO TP: ${finalTpPercent}%`);
    }
    
    if (newSlPercent === undefined || newSlPercent === null) {
      finalSlPercent = inheritedSlPercent;
      if (inheritedSlPercent !== null) {
        console.log(`📊 Heredando SL anterior: ${finalSlPercent?.toFixed(2)}%`);
      }
    } else {
      console.log(`📊 Usando NUEVO SL: ${finalSlPercent}%`);
    }
  }

  // ========== PASO 6: CONFIGURAR TP/SL CON VALORES FINALES ==========
  const { size: totalPositionSize, entryPrice: avgEntryPrice, availableSize } = confirmedPosition;
  const quantityForTPSL = Math.min(totalPositionSize, availableSize);

  if (trailingMode) {
    console.log("\n▶️ Iniciando Trailing Stop en segundo plano...");
    const trailingParams = { 
      symbol, 
      avgEntryPrice, 
      posSide, 
      positionSize: quantityForTPSL,
      tickSize: contract.tickSize, 
      trailingPercent, 
      minDistancePercent 
    };
    if (trailingMode === 'dynamic') {
      dynamicTrailingStop(trailingParams);
    } else if (trailingMode === 'be') {
      trailingStopToBE(trailingParams);
    }
  } else if (finalTpPercent || finalSlPercent) {
    console.log('\n🎯 === CONFIGURANDO TP/SL FINALES ===');
    console.log(`📏 Cantidad para TP/SL: ${quantityForTPSL} unidades`);
    console.log(`💰 Precio promedio ponderado: ${avgEntryPrice}`);
    
    const sltpSide = posSide === 'LONG' ? 'SELL' : 'BUY';
    const orderPromises = [];
    
    if (finalTpPercent && finalTpPercent > 0) {
      const finalTpPrice = roundToTickSizeUltraPrecise(
        avgEntryPrice * (posSide === 'LONG' ? 1 + finalTpPercent / 100 : 1 - finalTpPercent / 100), 
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
      
      console.log(`📤 Configurando TP: ${finalTpPrice} (${finalTpPercent}% desde ${avgEntryPrice})`);
      orderPromises.push(
        sendRequest('POST', '/openApi/swap/v2/trade/order', payload)
          .then(res => {
            if (res.code === 0) {
              console.log(`✅ TP configurado exitosamente en ${finalTpPrice}`);
            } else {
              console.log(`❌ Error configurando TP: ${res.msg}`);
            }
            return res;
          })
      );
    }
    
    if (finalSlPercent && finalSlPercent > 0) {
      const finalSlPrice = roundToTickSizeUltraPrecise(
        avgEntryPrice * (posSide === 'LONG' ? 1 - finalSlPercent / 100 : 1 + finalSlPercent / 100), 
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
      
      console.log(`📤 Configurando SL: ${finalSlPrice} (${finalSlPercent}% desde ${avgEntryPrice})`);
      orderPromises.push(
        sendRequest('POST', '/openApi/swap/v2/trade/order', payload)
          .then(res => {
            if (res.code === 0) {
              console.log(`✅ SL configurado exitosamente en ${finalSlPrice}`);
            } else {
              console.log(`❌ Error configurando SL: ${res.msg}`);
            }
            return res;
          })
      );
    }
    
    const results = await Promise.all(orderPromises);
    const allSuccess = results.every(r => r.code === 0);
    
    if (allSuccess) {
      console.log('✅ === TODAS LAS ÓRDENES TP/SL CONFIGURADAS EXITOSAMENTE ===');
    } else {
      console.log('⚠️ Algunas órdenes TP/SL no se pudieron configurar');
    }
  } else {
    console.log('ℹ️ No se configuraron TP/SL (no especificados)');
  }

  console.log('\n✅ === PROCESO DE ORDEN FINALIZADO ===');
  
  // Resumen final
  if (isReentry) {
    console.log('\n📊 === RESUMEN DE REENTRADA ===');
    console.log(`   Posición anterior: ${existingPosition.size} @ ${existingPosition.entryPrice}`);
    console.log(`   Nueva orden: ${quantityToOrder} @ ${marketPrice}`);
    console.log(`   Posición final: ${totalPositionSize} @ ${avgEntryPrice}`);
    if (finalTpPercent) console.log(`   TP: ${finalTpPercent}%`);
    if (finalSlPercent) console.log(`   SL: ${finalSlPercent}%`);
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
  getCurrentPositionSize,
  getExistingTPSLOrders,
  calculateTPSLPercentsFromOrders,
  trailingStopToBE,
  dynamicTrailingStop
};
