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
    'Connection': 'keep-alive'
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
  
  leverage = Math.max(1, Math.min(125, Number(leverage)));
  
  const payload = { symbol, side, leverage };
  const ts = Date.now();
  const raw = buildParams(payload, ts, false);
  const sig = signParams(raw);
  const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
  const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${qp}`;

  try {
    console.log(`🔧 Configurando leverage ${leverage}x para ${symbol} (${side})`);
    const resp = await fastAxios.get(url, {
      headers: { 'X-BX-APIKEY': API_KEY }
    });
    
    if (resp.data?.code === 0) {
      console.log(`✅ Leverage configurado exitosamente: ${leverage}x`);
    } else {
      console.log(`⚠️ Respuesta leverage:`, resp.data);
    }
    
    return resp.data;
  } catch (err) {
    console.error('❌ Error setLeverage:', err.response?.data || err.message);
    return { code: -1, msg: err.message };
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
          tickSize: parseFloat(c.tickSize || '0.01'),
          stepSize: parseFloat(c.stepSize || '0.001'),
          minNotional: parseFloat(c.minNotional || '1'),
          maxLeverage: parseInt(c.maxLeverage || '20')
        };
      }
    }
  } catch (e) {
    console.log('⚠️ Error obteniendo info del contrato:', e.message);
  }
  return { minOrderQty: 0.001, tickSize: 0.01, stepSize: 0.001, minNotional: 1, maxLeverage: 20 };
}

// ================== NUEVAS FUNCIONES PARA REENTRADAS ==================

async function getExistingPosition(symbol) {
  try {
    console.log(`🔍 Consultando posición existente para ${symbol}...`);
    
    const payload = { symbol };
    const ts = Date.now();
    const raw = buildParams(payload, ts, false);
    const sig = signParams(raw);
    const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
    const url = `https://${HOST}/openApi/swap/v2/user/positions?${qp}`;

    const response = await fastAxios.get(url, {
      headers: { 'X-BX-APIKEY': API_KEY }
    });

    if (response.data?.code === 0 && response.data.data) {
      const positions = Array.isArray(response.data.data) ? response.data.data : [response.data.data];
      const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
      if (position) {
        const size = Math.abs(parseFloat(position.positionAmt));
        const entryPrice = parseFloat(position.entryPrice);
        const side = parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT';
        
        console.log(`📊 Posición existente encontrada:`);
        console.log(`   - Lado: ${side}`);
        console.log(`   - Tamaño: ${size}`);
        console.log(`   - Precio entrada: ${entryPrice}`);
        
        return {
          exists: true,
          side,
          size,
          entryPrice,
          data: position
        };
      }
    }
    
    console.log(`📊 No hay posición existente para ${symbol}`);
    return { exists: false };
    
  } catch (error) {
    console.error('❌ Error consultando posición:', error.message);
    return { exists: false };
  }
}

async function cancelExistingTPSL(symbol, positionSide) {
  try {
    console.log(`🗑️ Cancelando TP/SL existentes para ${symbol} ${positionSide}...`);
    
    // Obtener órdenes abiertas
    const payload = { symbol };
    const ts = Date.now();
    const raw = buildParams(payload, ts, false);
    const sig = signParams(raw);
    const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
    const url = `https://${HOST}/openApi/swap/v2/trade/openOrders?${qp}`;

    const response = await fastAxios.get(url, {
      headers: { 'X-BX-APIKEY': API_KEY }
    });

    if (response.data?.code === 0 && response.data.data) {
      const orders = Array.isArray(response.data.data) ? response.data.data : [response.data.data];
      const tpslOrders = orders.filter(order => 
        order.symbol === symbol &&
        order.positionSide === positionSide &&
        (order.type === 'TAKE_PROFIT_MARKET' || order.type === 'STOP_MARKET') &&
        (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED')
      );
      
      console.log(`🔍 Encontradas ${tpslOrders.length} órdenes TP/SL para cancelar`);
      
      for (const order of tpslOrders) {
        try {
          const cancelPayload = { symbol, orderId: order.orderId };
          const cancelTs = Date.now();
          const cancelRaw = buildParams(cancelPayload, cancelTs, false);
          const cancelSig = signParams(cancelRaw);
          const cancelQp = buildParams(cancelPayload, cancelTs, true) + `&signature=${cancelSig}`;
          const cancelUrl = `https://${HOST}/openApi/swap/v2/trade/order?${cancelQp}`;
          
          await fastAxios.delete(cancelUrl, {
            headers: { 'X-BX-APIKEY': API_KEY }
          });
          
          console.log(`✅ Cancelada orden ${order.type}: ${order.orderId}`);
        } catch (e) {
          console.log(`⚠️ Error cancelando orden ${order.orderId}:`, e.message);
        }
      }
      
      return tpslOrders.length;
    }
    
    return 0;
  } catch (error) {
    console.error('❌ Error cancelando TP/SL:', error.message);
    return 0;
  }
}

// ================== OBTENER PRECIO REAL DE EJECUCIÓN ==================

async function getOrderExecutionPrice(orderId, symbol, maxRetries = 10) {
  console.log(`🔍 Obteniendo precio real de ejecución para orden ${orderId}...`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const payload = { symbol, orderId };
      const ts = Date.now();
      const raw = buildParams(payload, ts, false);
      const sig = signParams(raw);
      const qp = buildParams(payload, ts, true) + `&signature=${sig}`;
      const url = `https://${HOST}/openApi/swap/v2/trade/order?${qp}`;

      const response = await fastAxios.get(url, {
        headers: { 'X-BX-APIKEY': API_KEY }
      });

      if (response.data?.code === 0 && response.data.data) {
        const order = response.data.data;
        
        if (order.status === 'FILLED' && order.avgPrice && parseFloat(order.avgPrice) > 0) {
          const avgPrice = parseFloat(order.avgPrice);
          const executedQty = parseFloat(order.executedQty || order.origQty);
          
          console.log(`✅ Precio real de ejecución obtenido: ${avgPrice}`);
          console.log(`📊 Cantidad ejecutada: ${executedQty}`);
          
          return {
            avgPrice,
            executedQty,
            status: order.status,
            orderId: order.orderId
          };
        } else if (order.status === 'PARTIALLY_FILLED' && order.avgPrice) {
          const avgPrice = parseFloat(order.avgPrice);
          const executedQty = parseFloat(order.executedQty);
          
          console.log(`⏳ Orden parcialmente ejecutada: ${avgPrice} (${executedQty})`);
          
          return {
            avgPrice,
            executedQty,
            status: order.status,
            orderId: order.orderId
          };
        } else {
          console.log(`⏳ Intento ${attempt}/${maxRetries} - Estado: ${order.status}`);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      console.error(`❌ Error intento ${attempt}:`, error.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log('⚠️ No se pudo obtener precio de ejecución, usando precio de mercado como fallback');
  return null;
}

// ================== ORDEN PRINCIPAL + TP/SL CON REENTRADAS ==================

async function placeOrderInternal(params) {
  console.log('\n🚀 === PLACE ORDER INTERNAL (CON REENTRADAS) ===');
  console.log('📋 Parámetros recibidos:', JSON.stringify(params, null, 2));

  const {
    symbol: rawSymbol,
    side,
    leverage = 5,
    usdtAmount = 1,
    type = 'MARKET',
    limitPrice,
    // TP/SL en porcentaje
    tpPercent,
    slPercent,
    // TP/SL en precio absoluto
    tpPrice,
    slPrice,
    takeProfit,
    stopLoss,
    quantity,
    trailingPercent
  } = params;

  const symbol = normalizeSymbol(rawSymbol);
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  console.log(`🎯 Symbol normalizado: ${rawSymbol} -> ${symbol}`);

  // 1) CONSULTAR POSICIÓN EXISTENTE
  const existingPosition = await getExistingPosition(symbol);
  
  // 2) Configurar leverage
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  const leverageResult = await setLeverage(symbol, leverage, posSide);
  
  // 3) Verificar compatibilidad de direcciones
  if (existingPosition.exists && existingPosition.side !== posSide) {
    console.log(`⚠️ ADVERTENCIA: Posición existente es ${existingPosition.side}, nueva orden es ${posSide}`);
    console.log(`📊 Esto cerrará parcial o totalmente la posición existente`);
  }
  
  // 4) Obtener precio actual y info del contrato
  const marketPrice = await getCurrentPrice(symbol);
  const contract = await getContractInfo(symbol);
  
  console.log(`💰 Precio de mercado: ${marketPrice}`);
  console.log(`📊 Contrato info:`, contract);

  // 5) Calcular cantidad
  let finalQuantity;
  if (quantity) {
    finalQuantity = Number(quantity);
  } else {
    finalQuantity = Math.max(
      contract.minOrderQty,
      Math.round((usdtAmount * leverage / marketPrice) / contract.stepSize) * contract.stepSize
    );
  }
  finalQuantity = Number(finalQuantity.toFixed(6));
  
  console.log(`📏 Cantidad calculada: ${finalQuantity}`);

  // 6) Determinar TP/SL a usar
  let useNewTPSL = false;
  let absoluteTpPrice, absoluteSlPrice, currentTpPercent, currentSlPercent;
  
  // Detectar si vienen nuevos TP/SL en la señal
  if (tpPrice || takeProfit || tpPercent) {
    useNewTPSL = true;
    if (tpPrice) absoluteTpPrice = Number(tpPrice);
    else if (takeProfit) absoluteTpPrice = Number(takeProfit);
    else if (tpPercent) currentTpPercent = Number(tpPercent);
  }
  
  if (slPrice || stopLoss || slPercent) {
    useNewTPSL = true;
    if (slPrice) absoluteSlPrice = Number(slPrice);
    else if (stopLoss) absoluteSlPrice = Number(stopLoss);
    else if (slPercent) currentSlPercent = Number(slPercent);
  }

  console.log(`🎯 ¿Usar nuevos TP/SL?: ${useNewTPSL ? 'SÍ' : 'NO - mantener originales'}`);

  // 7) EJECUTAR ORDEN PRINCIPAL
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

  console.log('\n📤 Enviando orden principal...');
  console.log('📋 Payload:', mainPayload);

  const ts1 = Date.now();
  const raw1 = buildParams(mainPayload, ts1, false);
  const sig1 = signParams(raw1);
  const qp1 = buildParams(mainPayload, ts1, true) + `&signature=${sig1}`;
  const mainUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp1}`;

  let orderResp;
  try {
    orderResp = await fastAxios.post(mainUrl, null, {
      headers: { 'X-BX-APIKEY': API_KEY }
    });
    
    console.log('\n🔍 === DEBUG RESPUESTA COMPLETA ===');
    console.log('📨 Status HTTP:', orderResp.status);
    console.log('📨 Data completa:', JSON.stringify(orderResp.data, null, 2));
    
    if (orderResp.data?.code !== 0) {
      console.log('❌ Código de error BingX:', orderResp.data?.code);
      console.log('❌ Mensaje de error:', orderResp.data?.msg);
      throw new Error(`Error en orden principal: ${orderResp.data?.msg || 'Sin detalle'}`);
    }
    
  } catch (err) {
    console.log('\n🔍 === DEBUG ERROR COMPLETO ===');
    console.error('❌ Error message:', err.message);
    console.error('❌ Response status:', err.response?.status);
    console.error('❌ Response data:', JSON.stringify(err.response?.data, null, 2));
    throw err;
  }

  console.log('\n🔍 === DEBUG ORDER ID ===');
  console.log('📋 orderResp.data:', JSON.stringify(orderResp.data, null, 2));
  console.log('📋 orderResp.data?.data:', JSON.stringify(orderResp.data?.data, null, 2));
  
  let orderId = orderResp.data?.data?.orderId 
             || orderResp.data?.data?.order?.orderId
             || orderResp.data?.orderId
             || orderResp.data?.order?.orderId;
             
  console.log('🎯 OrderId encontrado:', orderId);
  
  if (!orderId) {
    console.log('❌ ESTRUCTURA DE RESPUESTA NO ESPERADA');
    throw new Error(`No se obtuvo orderId. Estructura: ${JSON.stringify(orderResp.data)}`);
  }

  // 8) OBTENER PRECIO REAL DE EJECUCIÓN DE LA NUEVA ORDEN
  let newExecutionPrice = marketPrice;
  let newExecutedQuantity = finalQuantity;
  
  console.log('\n⏳ Obteniendo precio real de la nueva orden...');
  
  // Intentar desde la respuesta directa primero
  if (orderResp.data?.data?.order?.avgPrice && parseFloat(orderResp.data.data.order.avgPrice) > 0) {
    newExecutionPrice = parseFloat(orderResp.data.data.order.avgPrice);
    newExecutedQuantity = parseFloat(orderResp.data.data.order.executedQty) || finalQuantity;
    console.log(`✅ Precio real obtenido de respuesta directa: ${newExecutionPrice}`);
  } else {
    console.log('\n⏳ Consultando API para obtener precio real...');
    const executionData = await getOrderExecutionPrice(orderId, symbol, 5);
    if (executionData) {
      newExecutionPrice = executionData.avgPrice;
      newExecutedQuantity = executionData.executedQty;
      console.log(`✅ Precio real obtenido de API: ${newExecutionPrice}`);
    } else {
      console.log(`⚠️ Usando precio de mercado como fallback: ${newExecutionPrice}`);
    }
  }

  // 9) CALCULAR PRECIO PROMEDIO PONDERADO Y CANTIDAD TOTAL
  let avgEntryPrice, totalQuantity;
  
  if (existingPosition.exists && existingPosition.side === posSide) {
    // Reentrada - calcular promedio ponderado
    const existingValue = existingPosition.size * existingPosition.entryPrice;
    const newValue = newExecutedQuantity * newExecutionPrice;
    totalQuantity = existingPosition.size + newExecutedQuantity;
    avgEntryPrice = (existingValue + newValue) / totalQuantity;
    
    console.log('\n📊 === CÁLCULO DE REENTRADA ===');
    console.log(`📈 Posición anterior: ${existingPosition.size} @ ${existingPosition.entryPrice}`);
    console.log(`📈 Nueva entrada: ${newExecutedQuantity} @ ${newExecutionPrice}`);
    console.log(`📊 Precio promedio ponderado: ${avgEntryPrice.toFixed(6)}`);
    console.log(`📊 Cantidad total: ${totalQuantity}`);
  } else {
    // Primera entrada o cambio de dirección
    avgEntryPrice = newExecutionPrice;
    totalQuantity = newExecutedQuantity;
    console.log(`📊 Nueva posición: ${totalQuantity} @ ${avgEntryPrice}`);
  }

  // 10) CONFIGURAR TP/SL SOLO SI CORRESPONDE
  let tpOrder = null, slOrder = null;
  let finalTpPrice, finalSlPrice;
  
  if (useNewTPSL || !existingPosition.exists) {
    console.log('\n🎯 Configurando TP/SL...');
    
    // Cancelar TP/SL existentes si hay reentrada
    if (existingPosition.exists && existingPosition.side === posSide) {
      await cancelExistingTPSL(symbol, posSide);
    }

    // Calcular TP/SL sobre precio promedio
    if (absoluteTpPrice) {
      finalTpPrice = absoluteTpPrice;
    } else if (currentTpPercent) {
      finalTpPrice = posSide === 'LONG'
        ? Number((avgEntryPrice * (1 + currentTpPercent / 100)).toFixed(6))
        : Number((avgEntryPrice * (1 - currentTpPercent / 100)).toFixed(6));
      console.log(`📈 TP calculado: ${avgEntryPrice} ${posSide === 'LONG' ? '+' : '-'} ${currentTpPercent}% = ${finalTpPrice}`);
    }

    if (absoluteSlPrice) {
      finalSlPrice = absoluteSlPrice;
    } else if (currentSlPercent) {
      finalSlPrice = posSide === 'LONG'
        ? Number((avgEntryPrice * (1 - currentSlPercent / 100)).toFixed(6))
        : Number((avgEntryPrice * (1 + currentSlPercent / 100)).toFixed(6));
      console.log(`🛡️ SL calculado: ${avgEntryPrice} ${posSide === 'LONG' ? '-' : '+'} ${currentSlPercent}% = ${finalSlPrice}`);
    }

    // Enviar TP
    if (finalTpPrice) {
      console.log('\n📈 Configurando Take Profit...');
      const tpPayload = {
        symbol,
        side: posSide === 'LONG' ? 'SELL' : 'BUY',
        positionSide: posSide,
        type: 'TAKE_PROFIT_MARKET',
        quantity: totalQuantity,
        stopPrice: finalTpPrice,
        workingType: 'MARK_PRICE'
      };
      
      const ts2 = Date.now();
      const raw2 = buildParams(tpPayload, ts2, false);
      const sig2 = signParams(raw2);
      const qp2 = buildParams(tpPayload, ts2, true) + `&signature=${sig2}`;
      const tpUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp2}`;
      
      try {
        console.log('📋 TP Payload:', tpPayload);
        tpOrder = await fastAxios.post(tpUrl, null, { 
          headers: { 'X-BX-APIKEY': API_KEY } 
        });
        console.log('📨 Respuesta TP:', JSON.stringify(tpOrder.data, null, 2));
      } catch (e) {
        console.error('❌ Error TP:', e.response?.data || e.message);
        tpOrder = { data: { code: -1, msg: e.message } };
      }
    }

    // Enviar SL
    if (finalSlPrice) {
      console.log('\n🛡️ Configurando Stop Loss...');
      const slPayload = {
        symbol,
        side: posSide === 'LONG' ? 'SELL' : 'BUY',
        positionSide: posSide,
        type: 'STOP_MARKET',
        quantity: totalQuantity,
        stopPrice: finalSlPrice,
        workingType: 'MARK_PRICE'
      };
      
      const ts3 = Date.now();
      const raw3 = buildParams(slPayload, ts3, false);
      const sig3 = signParams(raw3);
      const qp3 = buildParams(slPayload, ts3, true) + `&signature=${sig3}`;
      const slUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp3}`;
      
      try {
        console.log('📋 SL Payload:', slPayload);
        slOrder = await fastAxios.post(slUrl, null, { 
          headers: { 'X-BX-APIKEY': API_KEY } 
        });
        console.log('📨 Respuesta SL:', JSON.stringify(slOrder.data, null, 2));
      } catch (e) {
        console.error('❌ Error SL:', e.response?.data || e.message);
        slOrder = { data: { code: -1, msg: e.message } };
      }
    }
  } else {
    console.log('\n📊 No se configuran nuevos TP/SL - manteniendo existentes');
  }

  // 11) RESPUESTA FINAL
  const result = {
    code: orderResp.data?.code || -1,
    msg: orderResp.data?.msg || 'Error desconocido',
    data: orderResp.data?.data,
    mainOrder: orderResp.data,
    tpOrder: tpOrder ? tpOrder.data : null,
    slOrder: slOrder ? slOrder.data : null,
    summary: {
      mainSuccess: orderResp.data?.code === 0,
      tpSuccess: tpOrder ? tpOrder.data?.code === 0 : null,
      slSuccess: slOrder ? slOrder.data?.code === 0 : null,
      leverageSet: leverageResult?.code === 0,
      isReentry: existingPosition.exists && existingPosition.side === posSide,
      existingPosition: existingPosition.exists ? {
        side: existingPosition.side,
        size: existingPosition.size,
        entryPrice: existingPosition.entryPrice
      } : null,
      newOrder: {
        price: newExecutionPrice,
        quantity: newExecutedQuantity
      },
      combinedPosition: {
        avgEntryPrice: Number(avgEntryPrice.toFixed(6)),
        totalQuantity: totalQuantity,
        side: posSide
      },
      takeProfit: finalTpPrice,
      stopLoss: finalSlPrice,
      tpslStrategy: useNewTPSL ? 'Nuevos TP/SL aplicados' : 'Mantenidos existentes',
      marketPrice: marketPrice
    }
  };

  console.log('\n✅ === ORDEN COMPLETADA (CON REENTRADAS) ===');
  console.log('📊 Resumen:', JSON.stringify(result.summary, null, 2));
  
  return result;
}

// Retry por mínimo notional
async function placeOrderWithSmartRetry(params) {
  const { symbol, side, leverage = 5, usdtAmount = 1, ...rest } = params;
  const sym = normalizeSymbol(symbol);

  let result = await placeOrderInternal({
    symbol: sym, side, leverage, usdtAmount, ...rest
  });

  if (result.code !== 0) {
    const msg = result.msg || '';
    if (/min|min notional|insufficient|quantity/i.test(msg)) {
      console.log('🔄 Reintentando con mayor cantidad...');
      
      let minUSDT;
      const matchAmount = msg.match(/([\d.]+)\s*USDT/i);
      if (matchAmount) {
        minUSDT = parseFloat(matchAmount[1]);
      } else {
        const info = await getContractInfo(sym);
        minUSDT = info.minNotional;
      }
      
      const retryAmt = Math.ceil(minUSDT * 1.5 * 100) / 100;
      console.log(`💰 Reintentando con ${retryAmt} USDT (mínimo: ${minUSDT})`);
      
      result = await placeOrderInternal({
        symbol: sym, side, leverage, usdtAmount: retryAmt, ...rest
      });
    }
  }
  
  return result;
}

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
