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
    console.log(`🔍 Obteniendo info ultra-precisa del contrato para ${symbol}...`);
    const url = `https://${HOST}/openApi/swap/v2/quote/contracts`;
    const res = await fastAxios.get(url);
    if (res.data?.code === 0) {
      const c = res.data.data.find(x => x.symbol === symbol);
      if (c) {
        // ✅ PARSEAR CON MÁXIMA PRECISIÓN
        const contractInfo = {
          minOrderQty: parseFloat(c.minOrderQty || '0.001'),
          tickSize: parseFloat(c.tickSize || '0.000001'), // 6 decimales por defecto para máxima precisión
          stepSize: parseFloat(c.stepSize || '0.001'),
          minNotional: parseFloat(c.minNotional || '1'),
          maxLeverage: parseInt(c.maxLeverage || '20'),
          // ✅ INFORMACIÓN ADICIONAL PARA DEBUGGING
          rawTickSize: c.tickSize, // Valor original como string
          rawMinOrderQty: c.minOrderQty,
          rawStepSize: c.stepSize
        };
        
        console.log(`📊 Contrato ${symbol} (ultra-preciso):`);
        console.log(`   - tickSize: ${contractInfo.tickSize} (raw: "${contractInfo.rawTickSize}")`);
        console.log(`   - tickSize científico: ${contractInfo.tickSize.toExponential()}`);
        console.log(`   - minOrderQty: ${contractInfo.minOrderQty} (raw: "${contractInfo.rawMinOrderQty}")`);
        console.log(`   - stepSize: ${contractInfo.stepSize} (raw: "${contractInfo.rawStepSize}")`);
        console.log(`   - minNotional: ${contractInfo.minNotional}`);
        
        // ✅ VERIFICAR SI EL TICKSIZE ES VÁLIDO
        if (contractInfo.tickSize <= 0) {
          console.log('⚠️ TickSize inválido, usando valor por defecto ultra-preciso');
          contractInfo.tickSize = 0.000001; // 6 decimales
        }
        
        return contractInfo;
      }
    }
  } catch (e) {
    console.log('⚠️ Error obteniendo info del contrato:', e.message);
  }
  
  // ✅ VALORES POR DEFECTO CON MÁXIMA PRECISIÓN
  console.log('⚠️ Usando valores por defecto ultra-precisos');
  return { 
    minOrderQty: 0.001, 
    tickSize: 0.000001, // 6 decimales por defecto (microsegundos de precio)
    stepSize: 0.001, 
    minNotional: 1, 
    maxLeverage: 20,
    rawTickSize: "0.000001",
    rawMinOrderQty: "0.001",
    rawStepSize: "0.001"
  };
}

// ================== LIMPIAR DATOS DEL WEBHOOK ==================
function cleanWebhookData(rawData) {
  console.log('🧹 Limpiando datos del webhook...');
  
  const cleanData = {};
  const processedKeys = new Set();
  
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
  
  const validSides = ['BUY', 'SELL', 'LONG', 'SHORT'];
  if (!validSides.includes(data.side?.toUpperCase())) {
    throw new Error(`Side inválido: ${data.side}. Debe ser uno de: ${validSides.join(', ')}`);
  }
  
  if (data.leverage && (isNaN(data.leverage) || data.leverage < 1 || data.leverage > 125)) {
    console.log(`⚠️ Leverage inválido: ${data.leverage}, usando 5x por defecto`);
    data.leverage = 5;
  }
  
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

// ================== VERIFICAR SI HAY POSICIÓN EN LA MISMA DIRECCIÓN ==================
async function checkExistingPosition(symbol, newSide) {
  try {
    console.log(`🔍 Verificando posición existente para ${symbol} (nueva dirección: ${newSide})...`);
    
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
      
      if (position && parseFloat(position.positionAmt) !== 0) {
        const positionAmt = parseFloat(position.positionAmt);
        const existingSide = positionAmt > 0 ? 'LONG' : 'SHORT';
        const size = Math.abs(positionAmt);
        
        let entryPrice = parseFloat(position.entryPrice);
        if (!entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
          entryPrice = await getCurrentPrice(symbol);
          console.log(`⚠️ EntryPrice inválido, usando precio actual: ${entryPrice}`);
        }
        
        console.log(`📊 Posición existente encontrada:`);
        console.log(`   - Lado: ${existingSide}`);
        console.log(`   - Tamaño: ${size}`);
        console.log(`   - Precio entrada: ${entryPrice}`);
        console.log(`   - Nueva orden: ${newSide}`);
        
        // ✅ DETERMINAR SI ES REENTRADA (MISMA DIRECCIÓN)
        const isReentry = existingSide === newSide;
        
        if (isReentry) {
          console.log(`🔄 REENTRADA DETECTADA: ${existingSide} existente + ${newSide} nueva = UNIFICAR`);
        } else {
          console.log(`🔄 CAMBIO DE DIRECCIÓN: ${existingSide} → ${newSide} = CERRAR Y ABRIR`);
        }
        
        return {
          exists: true,
          side: existingSide,
          size: size,
          entryPrice: entryPrice,
          isReentry: isReentry,
          data: position
        };
      }
    }
    
    console.log(`📊 No hay posición existente para ${symbol}`);
    return { exists: false, isReentry: false };
    
  } catch (error) {
    console.error('❌ Error verificando posición:', error.message);
    return { exists: false, isReentry: false };
  }
}
function cleanWebhookData(rawData) {
  console.log('🧹 Limpiando datos del webhook...');
  
  const cleanData = {};
  const processedKeys = new Set();
  
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
  
  const validSides = ['BUY', 'SELL', 'LONG', 'SHORT'];
  if (!validSides.includes(data.side?.toUpperCase())) {
    throw new Error(`Side inválido: ${data.side}. Debe ser uno de: ${validSides.join(', ')}`);
  }
  
  if (data.leverage && (isNaN(data.leverage) || data.leverage < 1 || data.leverage > 125)) {
    console.log(`⚠️ Leverage inválido: ${data.leverage}, usando 5x por defecto`);
    data.leverage = 5;
  }
  
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

// ================== CANCELAR TP/SL EXISTENTES ==================
async function cancelAllTPSLOrders(symbol) {
  try {
    console.log(`🗑️ Cancelando órdenes TP/SL existentes para ${symbol}...`);
    
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
        (order.type === 'TAKE_PROFIT_MARKET' || order.type === 'STOP_MARKET') &&
        (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED')
      );
      
      console.log(`🔍 Encontradas ${tpslOrders.length} órdenes TP/SL para cancelar`);
      
      let canceledCount = 0;
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
          
          console.log(`✅ Cancelada: ${order.type} ${order.orderId}`);
          canceledCount++;
          
        } catch (e) {
          console.log(`⚠️ Error cancelando ${order.orderId}:`, e.message);
        }
      }
      
      if (canceledCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      return canceledCount;
    }
    
    return 0;
  } catch (error) {
    console.error('❌ Error cancelando TP/SL:', error.message);
    return 0;
  }
}

// ================== FUNCIÓN PRINCIPAL CON UNIFICACIÓN DE ENTRADAS ==================
async function placeOrderInternal(params) {
  console.log('\n🚀 === PLACE ORDER CON UNIFICACIÓN AUTOMÁTICA ===');
  
  // Limpiar y validar datos
  const cleanParams = cleanWebhookData(params);
  const validatedParams = validateWebhookData(cleanParams);
  
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
    quantity
  } = validatedParams;

  const symbol = normalizeSymbol(rawSymbol);
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  console.log(`🎯 Symbol: ${symbol} | Side: ${side} | Amount: ${usdtAmount} | Leverage: ${leverage}x`);

  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  
  // ✅ 1) VERIFICAR POSICIÓN EXISTENTE PARA DETECTAR REENTRADAS
  const existingPosition = await checkExistingPosition(symbol, posSide);
  
  // ✅ 2) SI ES REENTRADA, CANCELAR TODOS LOS TP/SL EXISTENTES PRIMERO
  if (existingPosition.exists && existingPosition.isReentry) {
    console.log('\n🗑️ === REENTRADA DETECTADA: CANCELANDO TP/SL EXISTENTES ===');
    await cancelAllTPSLOrders(symbol);
    console.log('✅ TP/SL anteriores cancelados, procediendo con reentrada...');
  }
  
  // 3) Configurar leverage
  await setLeverage(symbol, leverage, posSide);
  
  // 4) Obtener precio actual y info del contrato
  const marketPrice = await getCurrentPrice(symbol);
  const contract = await getContractInfo(symbol);
  
  console.log(`💰 Precio de mercado: ${marketPrice}`);

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

  // 6) EJECUTAR ORDEN PRINCIPAL
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
    
    if (orderResp.data?.code !== 0) {
      throw new Error(`Error BingX: ${orderResp.data?.msg || 'Error desconocido'}`);
    }
    
    console.log('✅ Orden principal ejecutada exitosamente');
    
  } catch (err) {
    console.error('❌ Error orden principal:', err.response?.data || err.message);
    throw err;
  }

  // 7) OBTENER PRECIO REAL DE EJECUCIÓN DE LA NUEVA ORDEN
  let newExecutionPrice = marketPrice;
  let newExecutedQuantity = finalQuantity;
  
  if (orderResp.data?.data?.order?.avgPrice && parseFloat(orderResp.data.data.order.avgPrice) > 0) {
    newExecutionPrice = parseFloat(orderResp.data.data.order.avgPrice);
    newExecutedQuantity = parseFloat(orderResp.data.data.order.executedQty) || finalQuantity;
    console.log(`✅ Precio real de ejecución: ${newExecutionPrice}`);
  }

  // ✅ 8) CALCULAR PRECIO PROMEDIO SI ES REENTRADA
  let avgEntryPrice, totalQuantity;
  
  if (existingPosition.exists && existingPosition.isReentry) {
    // REENTRADA: Calcular promedio ponderado
    const existingValue = existingPosition.size * existingPosition.entryPrice;
    const newValue = newExecutedQuantity * newExecutionPrice;
    totalQuantity = existingPosition.size + newExecutedQuantity;
    avgEntryPrice = (existingValue + newValue) / totalQuantity;
    
    console.log('\n📊 === REENTRADA: CÁLCULO DE PROMEDIO PONDERADO ===');
    console.log(`📈 Posición anterior: ${existingPosition.size} @ ${existingPosition.entryPrice}`);
    console.log(`📈 Nueva entrada: ${newExecutedQuantity} @ ${newExecutionPrice}`);
    console.log(`📊 Valor anterior: ${existingValue.toFixed(6)} USDT`);
    console.log(`📊 Valor nuevo: ${newValue.toFixed(6)} USDT`);
    console.log(`📊 Precio promedio ponderado: ${avgEntryPrice.toFixed(8)}`);
    console.log(`📊 Cantidad total unificada: ${totalQuantity}`);
    
  } else {
    // PRIMERA ENTRADA O CAMBIO DE DIRECCIÓN
    avgEntryPrice = newExecutionPrice;
    totalQuantity = newExecutedQuantity;
    console.log(`📊 Nueva posición: ${totalQuantity} @ ${avgEntryPrice}`);
  }

  // 9) CONFIGURAR TP/SL UNIFICADOS (SOLO SI SE ESPECIFICAN)
  let tpOrder = null, slOrder = null;
  let finalTpPrice, finalSlPrice;
  
  const hasTPSL = tpPrice || takeProfit || tpPercent || slPrice || stopLoss || slPercent;
  
  if (hasTPSL) {
    console.log('\n🎯 === CONFIGURANDO TP/SL UNIFICADOS ===');
    
    // Esperar un poco para que la posición se actualice completamente
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // ✅ USAR PRECIO PROMEDIO PARA CALCULAR TP/SL
    const basePrice = avgEntryPrice; // Precio base para TP/SL
    console.log(`📊 Usando precio base para TP/SL: ${basePrice.toFixed(8)}`);
    
    // Calcular precisión basada en tickSize del contrato
    const getDecimalPlaces = (tickSize) => {
      // Convertir a string científica para manejar números muy pequeños
      const str = tickSize.toExponential();
      if (str.includes('e-')) {
        const exp = parseInt(str.split('e-')[1]);
        return exp + (str.split('e-')[0].split('.')[1]?.length || 0) - 1;
      }
      const normalStr = tickSize.toString();
      if (normalStr.includes('.')) {
        return normalStr.split('.')[1].length;
      }
      return 0;
    };
    
    const priceDecimals = getDecimalPlaces(contract.tickSize);
    const maxInternalDecimals = 15; // Máxima precisión de JavaScript
    
    console.log(`📏 Precisión máxima: ${priceDecimals} decimales finales | ${maxInternalDecimals} decimales internos`);
    console.log(`🔍 TickSize del contrato: ${contract.tickSize} (${contract.tickSize.toExponential()})`);
    
    // Función de redondeo ultra-preciso
    const roundToTickSizeUltraPrecise = (price, tickSize) => {
      // Usar Number.EPSILON para evitar errores de punto flotante
      const factor = 1 / tickSize;
      const rounded = Math.round((price + Number.EPSILON) * factor) / factor;
      
      // Asegurar que el resultado tenga la precisión exacta del tickSize
      const decimalPlaces = getDecimalPlaces(tickSize);
      return parseFloat(rounded.toFixed(decimalPlaces));
    };
    
    // ✅ CÁLCULOS CON MÁXIMA PRECISIÓN (15 decimales internos)
    if (tpPrice) {
      const rawTp = parseFloat(tpPrice.toString());
      finalTpPrice = roundToTickSizeUltraPrecise(rawTp, contract.tickSize);
      console.log(`📈 TP directo: ${rawTp.toFixed(maxInternalDecimals)} → ${finalTpPrice} (ajustado a tickSize)`);
    } else if (takeProfit) {
      const rawTp = parseFloat(takeProfit.toString());
      finalTpPrice = roundToTickSizeUltraPrecise(rawTp, contract.tickSize);
      console.log(`📈 TP directo: ${rawTp.toFixed(maxInternalDecimals)} → ${finalTpPrice} (ajustado a tickSize)`);
    } else if (tpPercent) {
      // Cálculo con máxima precisión interna basado en precio promedio
      const multiplier = posSide === 'LONG' ? (1 + tpPercent / 100) : (1 - tpPercent / 100);
      const rawTpPrice = basePrice * multiplier;
      finalTpPrice = roundToTickSizeUltraPrecise(rawTpPrice, contract.tickSize);
      
      console.log(`📈 TP ultra-preciso (basado en promedio):`);
      console.log(`   - Precio base promedio: ${basePrice.toFixed(maxInternalDecimals)}`);
      console.log(`   - Multiplicador: ${multiplier.toFixed(maxInternalDecimals)}`);
      console.log(`   - Resultado crudo: ${rawTpPrice.toFixed(maxInternalDecimals)}`);
      console.log(`   - Final ajustado: ${finalTpPrice} (tickSize: ${contract.tickSize})`);
    }

    if (slPrice) {
      const rawSl = parseFloat(slPrice.toString());
      finalSlPrice = roundToTickSizeUltraPrecise(rawSl, contract.tickSize);
      console.log(`🛡️ SL directo: ${rawSl.toFixed(maxInternalDecimals)} → ${finalSlPrice} (ajustado a tickSize)`);
    } else if (stopLoss) {
      const rawSl = parseFloat(stopLoss.toString());
      finalSlPrice = roundToTickSizeUltraPrecise(rawSl, contract.tickSize);
      console.log(`🛡️ SL directo: ${rawSl.toFixed(maxInternalDecimals)} → ${finalSlPrice} (ajustado a tickSize)`);
    } else if (slPercent) {
      // Cálculo con máxima precisión interna basado en precio promedio
      const multiplier = posSide === 'LONG' ? (1 - slPercent / 100) : (1 + slPercent / 100);
      const rawSlPrice = basePrice * multiplier;
      finalSlPrice = roundToTickSizeUltraPrecise(rawSlPrice, contract.tickSize);
      
      console.log(`🛡️ SL ultra-preciso (basado en promedio):`);
      console.log(`   - Precio base promedio: ${basePrice.toFixed(maxInternalDecimals)}`);
      console.log(`   - Multiplicador: ${multiplier.toFixed(maxInternalDecimals)}`);
      console.log(`   - Resultado crudo: ${rawSlPrice.toFixed(maxInternalDecimals)}`);
      console.log(`   - Final ajustado: ${finalSlPrice} (tickSize: ${contract.tickSize})`);
    }

    // ✅ CREAR TP/SL CON LA CANTIDAD TOTAL UNIFICADA
    // Crear Take Profit
    if (finalTpPrice) {
      const tpPayload = {
        symbol,
        side: posSide === 'LONG' ? 'SELL' : 'BUY',
        positionSide: posSide,
        type: 'TAKE_PROFIT_MARKET',
        quantity: totalQuantity, // ✅ Cantidad total unificada
        stopPrice: finalTpPrice,
        workingType: 'MARK_PRICE'
      };
      
      try {
        const ts2 = Date.now();
        const raw2 = buildParams(tpPayload, ts2, false);
        const sig2 = signParams(raw2);
        const qp2 = buildParams(tpPayload, ts2, true) + `&signature=${sig2}`;
        const tpUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp2}`;
        
        console.log(`📈 Creando TP unificado para ${totalQuantity} unidades @ ${finalTpPrice}`);
        tpOrder = await fastAxios.post(tpUrl, null, { 
          headers: { 'X-BX-APIKEY': API_KEY } 
        });
        
        if (tpOrder.data?.code === 0) {
          console.log('✅ Take Profit UNIFICADO configurado exitosamente');
        } else {
          console.log('❌ Error configurando TP:', tpOrder.data?.msg);
        }
        
      } catch (e) {
        console.error('❌ Error TP:', e.response?.data || e.message);
        tpOrder = { data: { code: -1, msg: e.message } };
      }
    }

    // Crear Stop Loss
    if (finalSlPrice) {
      const slPayload = {
        symbol,
        side: posSide === 'LONG' ? 'SELL' : 'BUY',
        positionSide: posSide,
        type: 'STOP_MARKET',
        quantity: totalQuantity, // ✅ Cantidad total unificada
        stopPrice: finalSlPrice,
        workingType: 'MARK_PRICE'
      };
      
      try {
        const ts3 = Date.now();
        const raw3 = buildParams(slPayload, ts3, false);
        const sig3 = signParams(raw3);
        const qp3 = buildParams(slPayload, ts3, true) + `&signature=${sig3}`;
        const slUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp3}`;
        
        console.log(`🛡️ Creando SL unificado para ${totalQuantity} unidades @ ${finalSlPrice}`);
        slOrder = await fastAxios.post(slUrl, null, { 
          headers: { 'X-BX-APIKEY': API_KEY } 
        });
        
        if (slOrder.data?.code === 0) {
          console.log('✅ Stop Loss UNIFICADO configurado exitosamente');
        } else {
          console.log('❌ Error configurando SL:', slOrder.data?.msg);
        }
        
      } catch (e) {
        console.error('❌ Error SL:', e.response?.data || e.message);
        slOrder = { data: { code: -1, msg: e.message } };
      }
    }
  } else {
    console.log('\n📊 No se especificaron TP/SL - orden sin niveles de salida');
  }

  // 10) RESPUESTA FINAL
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
      symbol: symbol,
      side: posSide,
      quantity: newExecutedQuantity,
      executionPrice: newExecutionPrice,
      leverage: leverage,
      usdtAmount: usdtAmount,
      takeProfit: finalTpPrice,
      stopLoss: finalSlPrice,
      marketPrice: marketPrice,
      // ✅ INFORMACIÓN DE UNIFICACIÓN
      isReentry: existingPosition.exists && existingPosition.isReentry,
      unifiedPosition: existingPosition.exists && existingPosition.isReentry ? {
        previousSize: existingPosition.size,
        previousPrice: existingPosition.entryPrice,
        newSize: newExecutedQuantity,
        newPrice: newExecutionPrice,
        totalSize: totalQuantity,
        avgPrice: avgEntryPrice
      } : null
    }
  };

  console.log('\n✅ === ORDEN COMPLETADA CON UNIFICACIÓN ===');
  if (result.summary.isReentry) {
    console.log(`📊 REENTRADA UNIFICADA:`);
    console.log(`   - Posición anterior: ${result.summary.unifiedPosition.previousSize} @ ${result.summary.unifiedPosition.previousPrice}`);
    console.log(`   - Nueva entrada: ${result.summary.unifiedPosition.newSize} @ ${result.summary.unifiedPosition.newPrice}`);
    console.log(`   - TOTAL UNIFICADO: ${result.summary.unifiedPosition.totalSize} @ ${result.summary.unifiedPosition.avgPrice}`);
  } else {
    console.log(`📊 ${symbol} ${posSide} | Qty: ${newExecutedQuantity} | Price: ${newExecutionPrice}`);
  }
  console.log(`📊 TP: ${finalTpPrice || 'No'} | SL: ${finalSlPrice || 'No'}`);
  console.log(`📊 Estado: Orden ${result.summary.mainSuccess ? '✅' : '❌'} | TP ${result.summary.tpSuccess === null ? '⊘' : result.summary.tpSuccess ? '✅' : '❌'} | SL ${result.summary.slSuccess === null ? '⊘' : result.summary.slSuccess ? '✅' : '❌'}`);
  console.log('=====================================');
  
  return result;
}

// ================== WRAPPER PRINCIPAL (SIN RETRY AUTOMÁTICO) ==================
async function placeOrder(params) {
  try {
    console.log('\n🎯 === INICIANDO ORDEN ÚNICA ===');
    
    const result = await placeOrderInternal(params);
    
    // ✅ SI LA ORDEN PRINCIPAL FUNCIONA, CONSIDERAR ÉXITO (aunque TP/SL fallen)
    if (result.summary && result.summary.mainSuccess) {
      console.log('🎉 Orden principal ejecutada exitosamente');
      
      // Mostrar estado de TP/SL sin que sean errores fatales
      if (result.summary.tpSuccess === false) {
        console.log('⚠️ Take Profit falló, pero orden principal OK');
      }
      if (result.summary.slSuccess === false) {
        console.log('⚠️ Stop Loss falló, pero orden principal OK');
      }
      
      return result;
    }
    
    // ❌ Solo hacer retry si hay error específico de cantidad mínima
    const msg = result.msg || '';
    if (/min|min notional|insufficient|quantity/i.test(msg)) {
      console.log('🔄 Reintentando con cantidad ajustada...');
      
      let minUSDT;
      const matchAmount = msg.match(/([\d.]+)\s*USDT/i);
      if (matchAmount) {
        minUSDT = parseFloat(matchAmount[1]);
      } else {
        const info = await getContractInfo(normalizeSymbol(params.symbol));
        minUSDT = info.minNotional;
      }
      
      const retryAmt = Math.ceil(minUSDT * 1.5 * 100) / 100;
      console.log(`💰 Ajustando a ${retryAmt} USDT (mínimo: ${minUSDT})`);
      
      params.usdtAmount = retryAmt;
      return await placeOrderInternal(params);
    }
    
    // Solo error si la orden principal falló
    throw new Error(result.msg || 'Error en orden principal');
    
  } catch (error) {
    console.error('❌ Error en placeOrder:', error.message);
    throw error;
  }
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
  cleanWebhookData,
  validateWebhookData,
  cancelAllTPSLOrders
};
