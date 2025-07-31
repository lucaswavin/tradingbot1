const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = 'open-api.bingx.com';

// ⚡ OPTIMIZACIÓN: Pool de conexiones rápido
const ultraFastAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 25,
  timeout: 2000,
  freeSocketTimeout: 4000
});

// ⚡ OPTIMIZACIÓN: Instancia axios
const fastAxios = axios.create({
  httpsAgent: ultraFastAgent,
  timeout: 5000,
  headers: {
    'Connection': 'keep-alive',
    'Content-Type': 'application/json'
  }
});

// 🔑 Log de configuración de claves
console.log('🔑 BingX API Keys configuradas:', {
  apiKey: API_KEY ? `${API_KEY.substring(0, 8)}...` : 'NO CONFIGURADA',
  secret: API_SECRET ? `${API_SECRET.substring(0, 8)}...` : 'NO CONFIGURADA'
});

// 🔄 Normalizar símbolos (e.g. BTCUSDT -> BTC-USDT)
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  console.log(`🔄 Normalizando símbolo: ${symbol}`);
  let base = symbol.replace(/\.P$/, '');
  if (base.endsWith('USDT') && !base.includes('-')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  console.log(`✅ Símbolo normalizado: ${symbol} → ${base}`);
  return base;
}

// 🔐 FUNCIÓN OFICIAL - Construir parámetros EXACTAMENTE como ejemplo Python
function getParametersOfficial(payload, timestamp, urlEncode = false) {
  // Crear copia del payload SIN timestamp para evitar duplicados
  const payloadWithoutTimestamp = { ...payload };
  delete payloadWithoutTimestamp.timestamp;
  
  // ORDENAR ALFABÉTICAMENTE como en el ejemplo Python
  const sortedKeys = Object.keys(payloadWithoutTimestamp).sort();
  let params = '';
  
  for (const key of sortedKeys) {
    const val = payloadWithoutTimestamp[key];
    if (val !== undefined && val !== null) {
      const value = typeof val === 'object' ? JSON.stringify(val) : val;
      params += urlEncode
        ? `${key}=${encodeURIComponent(value)}&`
        : `${key}=${value}&`;
    }
  }
  
  // Agregar timestamp AL FINAL como en el ejemplo Python
  if (params) {
    params = params.slice(0, -1) + `&timestamp=${timestamp}`;
  } else {
    params = `timestamp=${timestamp}`;
  }
  
  console.log('🔧 [DEBUG] Parameters finales:', params);
  return params;
}

// 💰 Obtener precio actual de mercado
async function getCurrentPrice(symbol) {
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
    const res = await fastAxios.get(url);
    if (res.data?.code === 0) return parseFloat(res.data.data.price);
    throw new Error(`Precio inválido: ${JSON.stringify(res.data)}`);
  } catch (err) {
    console.error('❌ Error obteniendo precio:', err.message);
    throw err;
  }
}

// ℹ️ Obtener detalles de contrato
async function getContractInfo(symbol) {
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/contracts`;
    const res = await fastAxios.get(url);
    if (res.data?.code === 0) {
      const contract = res.data.data.find(c => c.symbol === symbol);
      if (contract) {
        return {
          minOrderQty: parseFloat(contract.minOrderQty || '0.001'),
          tickSize: parseFloat(contract.tickSize || '0.01'),
          stepSize: parseFloat(contract.stepSize || '0.001'),
          minNotional: parseFloat(contract.minNotional || '1'),
          symbol: contract.symbol
        };
      }
    }
  } catch (error) {
    console.warn('⚠️ Error en getContractInfo, usando valores por defecto');
  }
  return { minOrderQty: 0.001, tickSize: 0.01, stepSize: 0.001, minNotional: 1 };
}

// ⚙️ Establecer leverage (QUERY PARAMS)
async function setLeverage(symbol, leverage = 5) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  
  try {
    console.log('🔧 Estableciendo leverage...');
    const timestamp = Date.now();
    const payload = { symbol, side: 'LONG', leverage };
    const params = getParametersOfficial(payload, timestamp, false);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${parametersUrlEncoded}&signature=${signature}`;
    
    console.log('🔧 Leverage URL:', url);
    
    const res = await fastAxios.post(url, null, { 
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => resp
    });
    
    const result = JSON.parse(res.data);
    console.log('🔧 Leverage response:', result);
    return result;
  } catch (error) {
    console.warn('⚠️ Error al establecer leverage:', error.message);
    console.warn('⚠️ Leverage response:', error.response?.data);
    return null;
  }
}

// 🛒 FUNCIÓN PRINCIPAL - Enviar payload en cuerpo POST
async function placeOrderInternal({ symbol, side, leverage = 5, usdtAmount = 1 }) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    // 1. Establecer leverage
    await setLeverage(symbol, leverage);

    // 2. Obtener precio
    const price = await getCurrentPrice(symbol);
    console.log(`💰 Precio actual de ${symbol}: ${price} USDT`);
    console.log(`💳 Margin deseado: ${usdtAmount} USDT`);
    console.log(`⚡ Leverage: ${leverage}x`);
    
    // 3. Calcular cantidad
    const buyingPower = usdtAmount * leverage;
    console.log(`🚀 Poder de compra: ${usdtAmount} USDT × ${leverage}x = ${buyingPower} USDT`);
    
    let quantity = buyingPower / price;
    quantity = Math.round(quantity * 1000) / 1000;
    quantity = Math.max(0.001, quantity);
    
    console.log(`🧮 Quantity calculada: ${quantity} (${buyingPower} USDT ÷ ${price})`);
    console.log(`📊 Margin estimado a usar: ~${(quantity * price) / leverage} USDT`);

    const timestamp = Date.now();
    const orderSide = side.toUpperCase();
    
    // ✅ PAYLOAD MÍNIMO - EXACTAMENTE como ejemplo oficial
    const payload = {
      symbol: symbol,
      side: orderSide,
      positionSide: orderSide === 'BUY' ? 'LONG' : 'SHORT',
      type: 'MARKET',
      quantity: quantity
    };

    console.log('📋 Payload orden:', JSON.stringify(payload, null, 2));

    // ✅ CREAR QUERY STRING solo con timestamp y signature
    const paramsForSig = getParametersOfficial(payload, timestamp, false);
    const signature = crypto.createHmac('sha256', API_SECRET).update(paramsForSig).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/order?timestamp=${timestamp}&signature=${signature}`;
    
    console.log('🔧 Debug parameters para signature:', paramsForSig);
    console.log('🔧 Debug signature:', signature);
    console.log('🔧 Debug URL completa:', url);
    
    const res = await fastAxios.post(url, payload, { 
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => {
        console.log('🔧 Raw response:', resp);
        return resp;
      }
    });
    
    const result = JSON.parse(res.data);
    console.log('🎉 Place order result:', result);
    
    if (result.code === 0) {
      console.log('✅ ¡ORDEN EJECUTADA EXITOSAMENTE!');
      console.log(`✅ Símbolo: ${symbol}`);
      console.log(`✅ Lado: ${orderSide}`);
      console.log(`✅ Cantidad: ${quantity}`);
      console.log(`✅ Leverage: ${leverage}x`);
      console.log(`✅ Inversión: ${usdtAmount} USDT`);
      if (result.data?.orderId) {
        console.log(`✅ Order ID: ${BigInt(result.data.orderId).toString()}`);
      }
    }
    
    return result;
  } catch (error) {
    console.error('❌ Error en placeOrder:', error.message);
    console.error('❌ Response data:', error.response?.data);
    
    const data = error.response?.data;
    return {
      success: false,
      message: error.message,
      error: typeof data === 'string' ? JSON.parse(data) : data
    };
  }
}

// 🔄 Retry inteligente
async function placeOrderWithSmartRetry(params) {
  const { symbol, side, leverage = 5 } = params;
  const normalizedSymbol = normalizeSymbol(symbol);

  console.log(`🚀 Intentando orden con 1 USDT para ${normalizedSymbol}...`);

  try {
    const result = await placeOrderInternal({
      symbol: normalizedSymbol,
      side,
      leverage,
      usdtAmount: 1
    });

    if (result && result.code === 0) {
      console.log(`✅ ÉXITO con 1 USDT`);
      return result;
    }

    const errorMsg = result?.msg || result?.message || JSON.stringify(result);
    console.log(`🔍 Analizando error: "${errorMsg}"`);
    
    const needsRetry = errorMsg.includes('minimum') || 
                       errorMsg.includes('less than') || 
                       errorMsg.includes('min ') ||
                       errorMsg.toLowerCase().includes('min notional') ||
                       errorMsg.includes('insufficient');

    if (needsRetry) {
      console.warn(`⚠️ Orden con 1 USDT falló (mínimo insuficiente), calculando mínimo real...`);
      
      let minimumRequired = null;
      const match = errorMsg.match(/([\d.]+)\s+([A-Z]+)/);
      if (match) {
        const minQuantity = parseFloat(match[1]);
        const assetSymbol = match[2];
        console.log(`📏 Mínimo extraído: ${minQuantity} ${assetSymbol}`);
        
        const price = await getCurrentPrice(normalizedSymbol);
        minimumRequired = minQuantity * price;
        console.log(`💰 Mínimo en USDT: ${minimumRequired} USDT (${minQuantity} × ${price})`);
      }
      
      if (!minimumRequired) {
        console.log(`⚠️ No pudo extraer mínimo del error, consultando contrato...`);
        const contractInfo = await getContractInfo(normalizedSymbol);
        minimumRequired = contractInfo.minNotional || 10;
        console.log(`📋 Usando mínimo del contrato: ${minimumRequired} USDT`);
      }

      const finalAmount = Math.ceil(minimumRequired * 1.1 * 100) / 100;
      console.log(`🔄 Reintentando con ${finalAmount} USDT (mínimo + 10% buffer)`);
      
      const retryResult = await placeOrderInternal({
        symbol: normalizedSymbol,
        side,
        leverage,
        usdtAmount: finalAmount
      });
      
      if (retryResult && retryResult.code === 0) {
        console.log(`✅ ÉXITO con ${finalAmount} USDT (mínimo de BingX)`);
      }
      
      return retryResult;
    }
    
    console.log(`❌ Error no relacionado con mínimos, no reintentando`);
    return result;
    
  } catch (error) {
    console.error(`❌ Error en placeOrderWithSmartRetry:`, error.message);
    throw error;
  }
}

// 🏷️ Función pública
async function placeOrder(params) {
  return placeOrderWithSmartRetry(params);
}

// 💵 Obtener balance USDT (QUERY PARAMS)
async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  
  try {
    const timestamp = Date.now();
    const parameters = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/user/balance?${parameters}&signature=${signature}`;
    
    const res = await fastAxios.get(url, { 
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => resp
    });
    
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    
    if (data.code === 0) {
      if (data.data && data.data.balance) {
        if (typeof data.data.balance === 'object' && data.data.balance.balance) {
          return parseFloat(data.data.balance.balance);
        }
      }
      
      if (Array.isArray(data.data)) {
        const usdt = data.data.find(d => d.asset === 'USDT');
        return parseFloat(usdt?.balance || 0);
      }
    }
    
    throw new Error(`Formato de respuesta inesperado: ${JSON.stringify(data)}`);
  } catch (error) {
    console.error('❌ Error obteniendo balance:', error.message);
    throw error;
  }
}

// 🛑 FUNCIÓN - Cerrar todas posiciones con CUERPO POST
async function closeAllPositions(symbol) {
  const startTime = Date.now();
  
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  
  try {
    const timestamp = Date.now();
    const normalizedSymbol = normalizeSymbol(symbol);
    
    console.log('🔧 Cerrando posiciones para:', normalizedSymbol);
    
    // ✅ PAYLOAD MÍNIMO para close
    const payload = {
      symbol: normalizedSymbol,
      side: 'BOTH',
      type: 'MARKET'
    };
    
    console.log('📋 Payload close:', JSON.stringify(payload, null, 2));
    
    // ✅ CREAR QUERY STRING solo con timestamp y signature
    const params = getParametersOfficial(payload, timestamp, false);
    const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/closeAllPositions?timestamp=${timestamp}&signature=${signature}`;
    
    console.log('🔧 Debug close parameters:', params);
    console.log('🔧 Debug close signature:', signature);
    console.log('🔧 Debug close URL:', url);
    
    const res = await fastAxios.post(url, payload, { 
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => {
        console.log('🔧 Close raw response:', resp);
        return resp;
      }
    });
    
    const latency = Date.now() - startTime;
    console.log(`⚡ Close procesado en ${latency}ms`);
    
    const result = JSON.parse(res.data);
    console.log('🎉 Close result:', result);
    
    if (result.code === 0) {
      console.log('✅ ¡POSICIONES CERRADAS EXITOSAMENTE!');
      console.log(`✅ Símbolo: ${normalizedSymbol}`);
    }
    
    return result;
  } catch (error) {
    const latency = Date.now() - startTime;
    console.error(`❌ Error close en ${latency}ms:`, error.message);
    console.error('❌ Close response data:', error.response?.data);
    
    const data = error.response?.data;
    return {
      success: false,
      message: error.message,
      error: typeof data === 'string' ? JSON.parse(data) : data
    };
  }
}

// Alias para compatibilidad
async function closePosition(symbol, side = 'BOTH') {
  return await closeAllPositions(symbol);
}

module.exports = {
  getUSDTBalance,
  placeOrder,
  normalizeSymbol,
  setLeverage,
  getCurrentPrice,
  closePosition,
  closeAllPositions,
  getContractInfo,
  placeOrderWithSmartRetry
};
