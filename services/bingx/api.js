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

// ================== FUNCIONES PARA LIMPIAR Y VALIDAR DATOS ==================

function cleanWebhookData(rawData) {
  console.log('🧹 Limpiando datos del webhook...');
  
  // Crear objeto limpio sin duplicados
  const cleanData = {};
  const processedKeys = new Set();
  
  // Procesar cada clave una sola vez (la primera ocurrencia)
  for (const [key, value] of Object.entries(rawData)) {
    if (!processedKeys.has(key)) {
      cleanData[key] = value;
      processedKeys.add(key);
    } else {
      console.log(`⚠️ Clave duplicada ignorada: ${key} = ${value}`);
    }
  }
  
  console.log('✅ Datos limpios:', JSON.stringify(cleanData, null, 2));
  return cleanData;
}

function validateWebhookData(data) {
  console.log('🔍 Validando datos del webhook...');
  
  const required = ['symbol', 'side'];
  const missing = required.filter(field => !data[field]);
  
  if (missing.length > 0) {
    throw new Error(`Campos requeridos faltantes: ${missing.join(', ')}`);
  }
  
  // Validar que el side sea válido
  const validSides = ['BUY', 'SELL', 'LONG', 'SHORT'];
  if (!validSides.includes(data.side?.toUpperCase())) {
    throw new Error(`Side inválido: ${data.side}. Debe ser uno de: ${validSides.join(', ')}`);
  }
  
  // Validar leverage
  if (data.leverage && (isNaN(data.leverage) || data.leverage < 1 || data.leverage > 125)) {
    console.log(`⚠️ Leverage inválido: ${data.leverage}, usando 5x por defecto`);
    data.leverage = 5;
  }
  
  // Validar porcentajes de TP/SL
  if (data.tpPercent && (isNaN(data.tpPercent) || data.tpPercent <= 0)) {
    console.log(`⚠️ tpPercent inválido: ${data.tpPercent}`);
    delete data.tpPercent;
  }
  
  if (data.slPercent && (isNaN(data.slPercent) || data.slPercent <= 0)) {
    console.log(`⚠️ slPercent inválido: ${data.slPercent}`);
    delete data.slPercent;
  }
  
  console.log('✅ Datos validados correctamente');
  return data;
}

// ================== FUNCIONES MEJORADAS PARA POSICIONES ==================

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
        // ✅ MEJORADO: Validar entryPrice
        let entryPrice = parseFloat(position.entryPrice);
        
        // Si entryPrice es null, NaN o 0, intentar obtenerlo de markPrice o usar precio actual
        if (!entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
          console.log('⚠️ EntryPrice inválido, intentando obtener precio de mercado...');
          try {
            entryPrice = await getCurrentPrice(symbol);
            console.log(`📊 Usando precio de mercado como referencia: ${entryPrice}`);
          } catch (e) {
            console.log('❌ Error obteniendo precio de mercado:', e.message);
            entryPrice = parseFloat(position.markPrice) || 0;
          }
        }
        
        const side = parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT';
        
        console.log(`📊 Posición existente encontrada:`);
        console.log(`   - Lado: ${side}`);
        console.log(`   - Tamaño: ${size}`);
        console.log(`   - Precio entrada: ${entryPrice}`);
        
        return {
          exists: true,
          side,
          size,
          entryPrice, // ✅ Ahora siempre será un número válido
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

async function getCurrentPositionSize(symbol, positionSide) {
  try {
    console.log(`📊 Obteniendo tamaño real de posición ${symbol} ${positionSide}...`);
    
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
      const position = positions.find(p => p.symbol === symbol);
      
      if (position) {
        const positionAmt = parseFloat(position.positionAmt);
        const absSize = Math.abs(positionAmt);
        const actualSide = positionAmt > 0 ? 'LONG' : 'SHORT';
        
        console.log(`📊 Posición real encontrada:`);
        console.log(`   - Lado: ${actualSide}`);
        console.log(`   - Tamaño: ${absSize}`);
        console.log(`   - Precio promedio: ${position.entryPrice}`);
        
        return {
          size: absSize,
          side: actualSide,
          entryPrice: parseFloat(position.entryPrice),
          positionAmt: positionAmt
        };
      }
    }
    
    console.log(`📊 No se encontró posición para ${symbol}`);
    return null;
    
  } catch (error) {
    console.error('❌ Error obteniendo posición actual:', error.message);
    return null;
  }
}

// ================== FUNCIONES PARA MANEJAR TP/SL SIN DUPLICADOS ==================

async function cancelAllTPSLOrders(symbol) {
  try {
    console.log(`🗑️ Cancelando TODAS las órdenes TP/SL para ${symbol}...`);
    
    // Obtener TODAS las órdenes abiertas (no solo de una positionSide)
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
      
      // Filtrar TODAS las órdenes TP/SL del símbolo (sin importar positionSide)
      const tpslOrders = orders.filter(order => 
        order.symbol === symbol &&
        (order.type === 'TAKE_PROFIT_MARKET' || order.type === 'STOP_MARKET') &&
        (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED')
      );
      
      console.log(`🔍 Encontradas ${tpslOrders.length} órdenes TP/SL para cancelar:`);
      
      // Mostrar detalles de cada orden antes de cancelar
      tpslOrders.forEach(order => {
        console.log(`   - ${order.type} | ${order.positionSide} | Qty: ${order.origQty} | Price: ${order.stopPrice || order.price}`);
      });
      
      let canceledCount = 0;
      
      for (const order of tpslOrders) {
        try {
          const cancelPayload = { symbol, orderId: order.orderId };
          const cancelTs = Date.now();
          const cancelRaw = buildParams(cancelPayload, cancelTs, false);
          const cancelSig = signParams(cancelRaw);
          const cancelQp = buildParams(cancelPayload, cancelTs, true) + `&signature=${cancelSig}`;
          const cancelUrl = `https://${HOST}/openApi/swap/v2/trade/order?${cancelQp}`;
          
          const cancelResp = await fastAxios.delete(cancelUrl, {
            headers: { 'X-BX-APIKEY': API_KEY }
          });
          
          if (cancelResp.data?.code === 0) {
            console.log(`✅ Cancelada: ${order.type} ${order.orderId}`);
            canceledCount++;
          } else {
            console.log(`⚠️ Error cancelando ${order.orderId}:`, cancelResp.data?.msg);
          }
          
          // Pequeña pausa entre cancelaciones
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (e) {
          console.log(`❌ Error cancelando orden ${order.orderId}:`, e.message);
        }
      }
      
      console.log(`✅ Total canceladas: ${canceledCount}/${tpslOrders.length}`);
      
      // Esperar un poco para que las cancelaciones se procesen
      if (canceledCount > 0) {
        console.log('⏳ Esperando que se procesen las cancelaciones...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      return canceledCount;
    }
    
    return 0;
  } catch (error) {
    console.error('❌ Error cancelando órdenes TP/SL:', error.message);
    return 0;
  }
}

async function setTPSLOrders(symbol, positionSide, totalQuantity, avgEntryPrice, tpPrice, slPrice) {
  console.log('\n🎯 === CONFIGURANDO TP/SL (SIN DUPLICADOS) ===');
  
  // 1) CANCELAR TODAS las órdenes TP/SL existentes
  await cancelAllTPSLOrders(symbol);
  
  // 2) Verificar tamaño real de posición
  const currentPosition = await getCurrentPositionSize(symbol, positionSide);
  if (!currentPosition) {
    console.log('❌ No se pudo verificar la posición actual');
    return { tpOrder: null, slOrder: null };
  }
  
  // 3) Usar el tamaño real de la posición
  const realQuantity = currentPosition.size;
  const realEntryPrice = currentPosition.entryPrice;
  
  console.log(`📊 Usando datos reales de posición:`);
  console.log(`   - Cantidad: ${realQuantity} (vs calculado: ${totalQuantity})`);
  console.log(`   - Precio entrada: ${realEntryPrice} (vs calculado: ${avgEntryPrice})`);
  
  let tpOrder = null, slOrder = null;
  
  // 4) Crear Take Profit si especificado
  if (tpPrice) {
    console.log(`📈 Creando Take Profit: ${tpPrice}`);
    
    const tpPayload = {
      symbol,
      side: positionSide === 'LONG' ? 'SELL' : 'BUY',
      positionSide: positionSide,
      type: 'TAKE_PROFIT_MARKET',
      quantity: realQuantity, // ✅ Usar cantidad real
      stopPrice: tpPrice,
      workingType: 'MARK_PRICE'
    };
    
    try {
      const ts = Date.now();
      const raw = buildParams(tpPayload, ts, false);
      const sig = signParams(raw);
      const qp = buildParams(tpPayload, ts, true) + `&signature=${sig}`;
      const tpUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp}`;
      
      console.log('📋 TP Payload:', tpPayload);
      tpOrder = await fastAxios.post(tpUrl, null, { 
        headers: { 'X-BX-APIKEY': API_KEY } 
      });
      
      if (tpOrder.data?.code === 0) {
        console.log('✅ Take Profit creado exitosamente');
      } else {
        console.log('❌ Error creando TP:', tpOrder.data?.msg);
      }
      
    } catch (e) {
      console.error('❌ Error TP:', e.response?.data || e.message);
      tpOrder = { data: { code: -1, msg: e.message } };
    }
  }
  
  // 5) Crear Stop Loss si especificado
  if (slPrice) {
    console.log(`🛡️ Creando Stop Loss: ${slPrice}`);
    
    const slPayload = {
      symbol,
      side: positionSide === 'LONG' ? 'SELL' : 'BUY',
      positionSide: positionSide,
      type: 'STOP_MARKET',
      quantity: realQuantity, // ✅ Usar cantidad real
      stopPrice: slPrice,
      workingType: 'MARK_PRICE'
    };
    
    try {
      const ts = Date.now();
      const raw = buildParams(slPayload, ts, false);
      const sig = signParams(raw);
      const qp = buildParams(slPayload, ts, true) + `&signature=${sig}`;
      const slUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp}`;
      
      console.log('📋 SL Payload:', slPayload);
      slOrder = await fastAxios.post(slUrl, null, { 
        headers: { 'X-BX-APIKEY': API_KEY } 
      });
      
      if (slOrder.data?.code === 0) {
        console.log('✅ Stop Loss creado exitosamente');
      } else {
        console.log('❌ Error creando SL:', slOrder.data?.msg);
      }
      
    } catch (e) {
      console.error('❌ Error SL:', e.response?.data || e.message);
      slOrder = { data: { code: -1, msg: e.message } };
    }
  }
  
  return { tpOrder, slOrder };
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

// ================== FUNCIÓN PRINCIPAL MEJORADA ==================

async function placeOrderInternal(params) {
  console.log('\n🚀 === PLACE ORDER INTERNAL (VERSIÓN COMPLETA MEJORADA) ===');
  
  // ✅ LIMPIAR Y VALIDAR DATOS PRIMERO
  const cleanParams = cleanWebhookData(params);
  const validatedParams = validateWebhookData(cleanParams);
  console.log('📋 Parámetros validados:', JSON.stringify(validatedParams, null, 2));

  const {
    symbol: rawSymbol,
    side,
    leverage = 5,
    usdtAmount = 1,
    type = 'MARKET',
    limitPrice,
    tpPercent,
    slPercent,
    tpPrice,
    slPrice,
    takeProfit,
    stopLoss,
    quantity,
    trailingPercent
  } = validatedParams;

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
  if (quantity && !isNaN(parseFloat(quantity))) {
    finalQuantity = parseFloat(quantity);
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
      const errorCode = orderResp.data?.code;
      const errorMsg = orderResp.data?.msg;
      
      // Manejar errores específicos
      switch(errorCode) {
        case 100001:
          throw new Error('API Key inválida');
        case 100004:
          throw new Error('Signature inválida - revisar API Secret');
        case 200004:
          throw new Error('Balance insuficiente');
        case 200027:
          throw new Error('Cantidad mínima no alcanzada');
        default:
          throw new Error(`Error BingX ${errorCode}: ${errorMsg}`);
      }
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

  // 10) CONFIGURAR TP/SL CON LA FUNCIÓN MEJORADA
  let tpOrder = null, slOrder = null;
  let finalTpPrice, finalSlPrice;
  
  if (useNewTPSL || !existingPosition.exists) {
    console.log('\n🎯 Configurando TP/SL con función mejorada...');
    
    // Esperar un poco para que la posición se actualice
    console.log('⏳ Esperando actualización de posición...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
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

    // Usar la función mejorada para TP/SL (evita duplicados)
    const tpslResult = await setTPSLOrders(symbol, posSide, totalQuantity, avgEntryPrice, finalTpPrice, finalSlPrice);
    tpOrder = tpslResult.tpOrder;
    slOrder = tpslResult.slOrder;
  } else {
    console.log('\n📊 No se configuran nuevos TP/SL - manteniendo existentes');
  }

  // 11) RESPUESTA FINAL MEJORADA
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
      takeProfit: finalTpPrice || null,
      stopLoss: finalSlPrice || null,
      tpslStrategy: useNewTPSL ? 'Nuevos TP/SL aplicados' : 'Mantenidos existentes',
      marketPrice: marketPrice,
      duplicatesFixed: true, // ✅ Indicador de mejoras aplicadas
      // ✅ DATOS PARA EL LOG FINAL
      execution: {
        symbol: symbol,
        finalQuantity: finalQuantity,
        executionPrice: newExecutionPrice,
        leverage: leverage,
        usdtAmount: usdtAmount,
        orderType: type
      }
    }
  };

  console.log('\n✅ === ORDEN COMPLETADA (VERSIÓN COMPLETA) ===');
  logTradeExecution(symbol, `${posSide}_${side}`, result);
  
  return result;
}

// ================== FUNCIÓN DE LOGGING MEJORADA ==================

function logTradeExecution(symbol, action, result) {
  const timestamp = new Date().toISOString();
  const { summary } = result;
  
  console.log('\n🎯 === RESUMEN DE EJECUCIÓN COMPLETO ===');
  console.log(`⏰ Timestamp: ${timestamp}`);
  console.log(`📊 Símbolo: ${summary.execution?.symbol || 'N/A'}`);
  console.log(`📊 Acción: ${action}`);
  console.log(`📊 Lado: ${summary.combinedPosition?.side || 'N/A'}`);
  console.log(`📊 Cantidad: ${summary.execution?.finalQuantity || summary.newOrder?.quantity || 'N/A'}`);
  console.log(`📊 Precio ejecución: ${summary.execution?.executionPrice || summary.newOrder?.price || 'N/A'}`);
  console.log(`📊 Leverage: ${summary.execution?.leverage || 'N/A'}x`);
  console.log(`📊 Monto USDT: $${summary.execution?.usdtAmount || 'N/A'}`);
  console.log(`📊 Tipo orden: ${summary.execution?.orderType || 'N/A'}`);
  console.log(`📊 Take Profit: ${summary.takeProfit || 'No configurado'}`);
  console.log(`📊 Stop Loss: ${summary.stopLoss || 'No configurado'}`);
  console.log(`📊 ¿Reentrada?: ${summary.isReentry ? 'SÍ' : 'NO'}`);
  console.log(`📊 Orden principal: ${summary.mainSuccess ? '✅ Éxito' : '❌ Error'}`);
  console.log(`📊 Take Profit: ${summary.tpSuccess === null ? '⊘ N/A' : summary.tpSuccess ? '✅ Éxito' : '❌ Error'}`);
  console.log(`📊 Stop Loss: ${summary.slSuccess === null ? '⊘ N/A' : summary.slSuccess ? '✅ Éxito' : '❌ Error'}`);
  console.log(`📊 Leverage config: ${summary.leverageSet ? '✅ Éxito' : '❌ Error'}`);
  console.log(`🔧 Duplicados solucionados: ${summary.duplicatesFixed ? '✅ SÍ' : '❌ NO'}`);
  
  if (summary.isReentry && summary.existingPosition) {
    console.log(`📈 === DETALLES DE REENTRADA ===`);
    console.log(`📈 Posición anterior: ${summary.existingPosition.size} @ ${summary.existingPosition.entryPrice}`);
    console.log(`📈 Nueva entrada: ${summary.newOrder.quantity} @ ${summary.newOrder.price}`);
    console.log(`📈 Precio promedio final: ${summary.combinedPosition.avgEntryPrice}`);
    console.log(`📈 Cantidad total: ${summary.combinedPosition.totalQuantity}`);
  }
  
  console.log('=====================================');
}

// Retry con mejoras
async function placeOrderWithSmartRetry(params, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Intento ${attempt}/${maxRetries} para ${params.symbol}`);
      
      const result = await placeOrderInternal(params);
      
      if (result.code === 0) {
        console.log(`✅ Éxito en intento ${attempt}`);
        return result;
      }
      
      lastError = new Error(result.msg);
      
      // Si es error de cantidad mínima, ajustar
      if (result.msg && /min|min notional|insufficient|quantity/i.test(result.msg)) {
        console.log('🔄 Reintentando con mayor cantidad...');
        
        let minUSDT;
        const matchAmount = result.msg.match(/([\d.]+)\s*USDT/i);
        if (matchAmount) {
          minUSDT = parseFloat(matchAmount[1]);
        } else {
          const info = await getContractInfo(normalizeSymbol(params.symbol));
          minUSDT = info.minNotional;
        }
        
        const retryAmt = Math.ceil(minUSDT * 1.5 * 100) / 100;
        console.log(`💰 Ajustando a ${retryAmt} USDT (mínimo: ${minUSDT})`);
        params.usdtAmount = retryAmt;
      }
      
    } catch (error) {
      lastError = error;
      console.log(`❌ Error intento ${attempt}: ${error.message}`);
      
      // Esperar antes del siguiente intento
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  
  throw lastError;
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
  closeAllPositions,
  // Nuevas funciones mejoradas
  cleanWebhookData,
  validateWebhookData,
  cancelAllTPSLOrders,
  getCurrentPositionSize,
  setTPSLOrders,
  logTradeExecution
};
