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
  timeout: 8000, // Aumentado para operaciones más lentas
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
  
  // Validar leverage
  leverage = Math.max(1, Math.min(125, Number(leverage))); // BingX permite 1-125x
  
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
    // No lanzar error aquí, continuar con la orden
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

// ================== ORDEN PRINCIPAL + TP/SL ==================

async function placeOrderInternal(params) {
  console.log('\n🚀 === PLACE ORDER INTERNAL ===');
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
    takeProfit, // Alias para tpPrice
    stopLoss,   // Alias para slPrice
    quantity,   // Cantidad directa
    trailingPercent
  } = params;

  const symbol = normalizeSymbol(rawSymbol);
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  console.log(`🎯 Symbol normalizado: ${rawSymbol} -> ${symbol}`);

  // 1) Configurar leverage SIEMPRE
  const posSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  const leverageResult = await setLeverage(symbol, leverage, posSide);
  
  // 2) Obtener precio actual y info del contrato
  const price = await getCurrentPrice(symbol);
  const contract = await getContractInfo(symbol);
  
  console.log(`💰 Precio actual: ${price}`);
  console.log(`📊 Contrato info:`, contract);

  // 3) Calcular cantidad si no se especifica
  let finalQuantity;
  if (quantity) {
    finalQuantity = Number(quantity);
  } else {
    finalQuantity = Math.max(
      contract.minOrderQty,
      Math.round((usdtAmount * leverage / price) / contract.stepSize) * contract.stepSize
    );
  }
  finalQuantity = Number(finalQuantity.toFixed(6));
  
  console.log(`📏 Cantidad calculada: ${finalQuantity}`);

  // 4) Calcular TP/SL finales (prioridad: tpPrice/slPrice > takeProfit/stopLoss > tpPercent/slPercent)
  let finalTpPrice, finalSlPrice;

  // Take Profit
  if (tpPrice) {
    finalTpPrice = Number(tpPrice);
  } else if (takeProfit) {
    finalTpPrice = Number(takeProfit);
  } else if (tpPercent) {
    const tpPerc = Number(tpPercent);
    finalTpPrice = side.toUpperCase() === 'BUY'
      ? Number((price * (1 + tpPerc / 100)).toFixed(6))
      : Number((price * (1 - tpPerc / 100)).toFixed(6));
  }

  // Stop Loss
  if (slPrice) {
    finalSlPrice = Number(slPrice);
  } else if (stopLoss) {
    finalSlPrice = Number(stopLoss);
  } else if (slPercent) {
    const slPerc = Number(slPercent);
    finalSlPrice = side.toUpperCase() === 'BUY'
      ? Number((price * (1 - slPerc / 100)).toFixed(6))
      : Number((price * (1 + slPerc / 100)).toFixed(6));
  }

  console.log(`🎯 TP calculado: ${finalTpPrice || 'No'}`);
  console.log(`🛡️ SL calculado: ${finalSlPrice || 'No'}`);

  // 5) ORDEN PRINCIPAL
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

  // 6) Ejecutar orden principal
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
    
    console.log('📨 Respuesta orden principal:', JSON.stringify(orderResp.data, null, 2));
    
    if (orderResp.data?.code !== 0) {
      throw new Error(`Error en orden principal: ${orderResp.data?.msg || 'Sin detalle'}`);
    }
  } catch (err) {
    console.error('❌ Error orden principal:', err.response?.data || err.message);
    throw err;
  }

  // 7) Esperar un poco antes de TP/SL
  await new Promise(resolve => setTimeout(resolve, 500));

  // 8) Take Profit (orden condicional)
  let tpOrder = null;
  if (finalTpPrice) {
    console.log('\n📈 Configurando Take Profit...');
    const tpPayload = {
      symbol,
      side: side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY',
      positionSide: posSide,
      type: 'TAKE_PROFIT_MARKET',
      quantity: finalQuantity,
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

  // 9) Stop Loss (orden condicional)
  let slOrder = null;
  if (finalSlPrice) {
    console.log('\n🛡️ Configurando Stop Loss...');
    const slPayload = {
      symbol,
      side: side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY',
      positionSide: posSide,
      type: 'STOP_MARKET',
      quantity: finalQuantity,
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

  // 10) Retorna respuesta completa
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
      executedPrice: price,
      executedQuantity: finalQuantity,
      takeProfit: finalTpPrice,
      stopLoss: finalSlPrice
    }
  };

  console.log('\n✅ === ORDEN COMPLETADA ===');
  console.log('📊 Resumen:', result.summary);
  
  return result;
}

// Retry por mínimo notional
async function placeOrderWithSmartRetry(params) {
  const { symbol, side, leverage = 5, usdtAmount = 1, ...rest } = params;
  const sym = normalizeSymbol(symbol);

  let result = await placeOrderInternal({
    symbol: sym, side, leverage, usdtAmount, ...rest
  });

  // Si la orden principal falló, intentar con mayor cantidad
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
      
      const retryAmt = Math.ceil(minUSDT * 1.5 * 100) / 100; // +50% de margen
      console.log(`💰 Reintentando con ${retryAmt} USDT (mínimo: ${minUSDT})`);
      
      result = await placeOrderInternal({
        symbol: sym, side, leverage, usdtAmount: retryAmt, ...rest
      });
    }
  }
  
  return result;
}

// Función principal exportada
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




