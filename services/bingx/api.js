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

// ================== FUNCIÓN PRINCIPAL SIMPLIFICADA (SIN REENTRADAS) ==================
async function placeOrderInternal(params) {
  console.log('\n🚀 === PLACE ORDER SIMPLE (SIN REENTRADAS AUTOMÁTICAS) ===');
  
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

  console.log(`🎯 Symbol: ${symbol} | Side: ${side} | Amount: $${usdtAmount} | Leverage: ${leverage}x`);

  // 1) Configurar leverage
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  await setLeverage(symbol, leverage, posSide);
  
  // 2) Obtener precio actual y info del contrato
  const marketPrice = await getCurrentPrice(symbol);
  const contract = await getContractInfo(symbol);
  
  console.log(`💰 Precio de mercado: ${marketPrice}`);

  // 3) Calcular cantidad
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

  // 4) EJECUTAR ORDEN PRINCIPAL
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

  // 5) OBTENER PRECIO REAL DE EJECUCIÓN
  let executionPrice = marketPrice;
  let executedQuantity = finalQuantity;
  
  if (orderResp.data?.data?.order?.avgPrice && parseFloat(orderResp.data.data.order.avgPrice) > 0) {
    executionPrice = parseFloat(orderResp.data.data.order.avgPrice);
    executedQuantity = parseFloat(orderResp.data.data.order.executedQty) || finalQuantity;
    console.log(`✅ Precio real de ejecución: ${executionPrice}`);
  }

  // 6) CONFIGURAR TP/SL (SOLO SI SE ESPECIFICAN)
  let tpOrder = null, slOrder = null;
  let finalTpPrice, finalSlPrice;
  
  const hasTPSL = tpPrice || takeProfit || tpPercent || slPrice || stopLoss || slPercent;
  
  if (hasTPSL) {
    console.log('\n🎯 Configurando TP/SL...');
    
    // Cancelar TP/SL existentes primero
    await cancelAllTPSLOrders(symbol);
    
    // Esperar un poco para que la posición se actualice
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Calcular precios TP/SL
    if (tpPrice) {
      finalTpPrice = Number(tpPrice);
    } else if (takeProfit) {
      finalTpPrice = Number(takeProfit);
    } else if (tpPercent) {
      finalTpPrice = posSide === 'LONG'
        ? Number((executionPrice * (1 + tpPercent / 100)).toFixed(6))
        : Number((executionPrice * (1 - tpPercent / 100)).toFixed(6));
      console.log(`📈 TP calculado: ${executionPrice} ${posSide === 'LONG' ? '+' : '-'} ${tpPercent}% = ${finalTpPrice}`);
    }

    if (slPrice) {
      finalSlPrice = Number(slPrice);
    } else if (stopLoss) {
      finalSlPrice = Number(stopLoss);
    } else if (slPercent) {
      finalSlPrice = posSide === 'LONG'
        ? Number((executionPrice * (1 - slPercent / 100)).toFixed(6))
        : Number((executionPrice * (1 + slPercent / 100)).toFixed(6));
      console.log(`🛡️ SL calculado: ${executionPrice} ${posSide === 'LONG' ? '-' : '+'} ${slPercent}% = ${finalSlPrice}`);
    }

    // Crear Take Profit
    if (finalTpPrice) {
      const tpPayload = {
        symbol,
        side: posSide === 'LONG' ? 'SELL' : 'BUY',
        positionSide: posSide,
        type: 'TAKE_PROFIT_MARKET',
        quantity: executedQuantity,
        stopPrice: finalTpPrice,
        workingType: 'MARK_PRICE'
      };
      
      try {
        const ts2 = Date.now();
        const raw2 = buildParams(tpPayload, ts2, false);
        const sig2 = signParams(raw2);
        const qp2 = buildParams(tpPayload, ts2, true) + `&signature=${sig2}`;
        const tpUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp2}`;
        
        tpOrder = await fastAxios.post(tpUrl, null, { 
          headers: { 'X-BX-APIKEY': API_KEY } 
        });
        
        if (tpOrder.data?.code === 0) {
          console.log('✅ Take Profit configurado exitosamente');
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
        quantity: executedQuantity,
        stopPrice: finalSlPrice,
        workingType: 'MARK_PRICE'
      };
      
      try {
        const ts3 = Date.now();
        const raw3 = buildParams(slPayload, ts3, false);
        const sig3 = signParams(raw3);
        const qp3 = buildParams(slPayload, ts3, true) + `&signature=${sig3}`;
        const slUrl = `https://${HOST}/openApi/swap/v2/trade/order?${qp3}`;
        
        slOrder = await fastAxios.post(slUrl, null, { 
          headers: { 'X-BX-APIKEY': API_KEY } 
        });
        
        if (slOrder.data?.code === 0) {
          console.log('✅ Stop Loss configurado exitosamente');
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

  // 7) RESPUESTA FINAL
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
      quantity: executedQuantity,
      executionPrice: executionPrice,
      leverage: leverage,
      usdtAmount: usdtAmount,
      takeProfit: finalTpPrice,
      stopLoss: finalSlPrice,
      marketPrice: marketPrice
    }
  };

  console.log('\n✅ === ORDEN COMPLETADA ===');
  console.log(`📊 ${symbol} ${posSide} | Qty: ${executedQuantity} | Price: ${executionPrice}`);
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
    
    // ✅ SI LA ORDEN PRINCIPAL FUNCIONA, NO HACER RETRY
    if (result.code === 0) {
      console.log('🎉 Orden ejecutada exitosamente - NO se necesita retry');
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
    
    // Para otros errores, no hacer retry
    throw new Error(result.msg);
    
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
