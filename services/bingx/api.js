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
  apiKey: API_KEY ? `${API_KEY.substring(0,8)}...` : 'NO CONFIGURADA',
  secret: API_SECRET ? `${API_SECRET.substring(0,8)}...` : 'NO CONFIGURADA'
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

// 🔐 FUNCIÓN DEBUG - Construir parámetros con ULTRA-LOGGING
function getParametersOfficial(payload, timestamp, urlEncode = false) {
  console.log('🐛 [DEBUG] Entrada getParametersOfficial:');
  console.log('🐛 [DEBUG] - payload original:', JSON.stringify(payload, null, 2));
  console.log('🐛 [DEBUG] - timestamp:', timestamp);
  console.log('🐛 [DEBUG] - urlEncode:', urlEncode);
  
  // Crear copia del payload SIN timestamp para evitar duplicados
  const payloadWithoutTimestamp = { ...payload };
  delete payloadWithoutTimestamp.timestamp;
  
  console.log('🐛 [DEBUG] - payload sin timestamp:', JSON.stringify(payloadWithoutTimestamp, null, 2));
  
  const sortedKeys = Object.keys(payloadWithoutTimestamp).sort();
  console.log('🐛 [DEBUG] - claves ordenadas:', sortedKeys);
  
  let params = '';
  
  for (const key of sortedKeys) {
    const val = payloadWithoutTimestamp[key];
    console.log(`🐛 [DEBUG] - procesando ${key}: ${val} (tipo: ${typeof val})`);
    
    if (val !== undefined && val !== null) {
      const paramPart = urlEncode
        ? `${key}=${encodeURIComponent(val)}&`
        : `${key}=${val}&`;
      console.log(`🐛 [DEBUG] - agregando: ${paramPart}`);
      params += paramPart;
    } else {
      console.log(`🐛 [DEBUG] - saltando ${key} (undefined/null)`);
    }
  }
  
  console.log('🐛 [DEBUG] - params antes de timestamp:', params);
  
  // Agregar timestamp AL FINAL una sola vez
  if (params) {
    params = params.slice(0, -1) + `&timestamp=${timestamp}`;
  } else {
    params = `timestamp=${timestamp}`;
  }
  
  console.log('🐛 [DEBUG] - params finales:', params);
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

// ℹ️ Obtener detalles de contrato (mínimos, stepSize, minNotional)
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

// ⚙️ Establecer leverage (QUERY PARAMS) - CON DEBUG
async function setLeverage(symbol, leverage = 5) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  
  try {
    console.log('🐛 [DEBUG] setLeverage iniciado');
    const timestamp = Date.now();
    const payload = { symbol, side: 'LONG', leverage };
    
    console.log('🐛 [DEBUG] setLeverage payload:', JSON.stringify(payload, null, 2));
    
    const params = getParametersOfficial(payload, timestamp, false);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${parametersUrlEncoded}&signature=${signature}`;
    
    console.log('🐛 [DEBUG] setLeverage URL completa:', url);
    
    const res = await fastAxios.post(url, null, { 
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => resp
    });
    
    console.log('🐛 [DEBUG] setLeverage respuesta:', res.data);
    return JSON.parse(res.data);
  } catch (error) {
    console.error('🐛 [DEBUG] setLeverage error:', error.message);
    console.warn('⚠️ Error al establecer leverage:', error.message);
    return null;
  }
}

// 🛒 FUNCIÓN ULTRA-DEBUG - Colocar orden
async function placeOrderInternal({ symbol, side, leverage = 5, usdtAmount = 1 }) {
  console.log('🐛 [DEBUG] placeOrderInternal iniciado con:', { symbol, side, leverage, usdtAmount });
  
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    await setLeverage(symbol, leverage);

    const price = await getCurrentPrice(symbol);
    console.log(`💰 Precio actual de ${symbol}: ${price} USDT`);
    
    const buyingPower = usdtAmount * leverage;
    let quantity = buyingPower / price;
    quantity = Math.round(quantity * 1000) / 1000;
    quantity = Math.max(0.001, quantity);

    const timestamp = Date.now();
    const orderSide = side.toUpperCase();
    
    // ✅ PAYLOAD PARA QUERY PARAMS
    const payload = {
      symbol,
      side: orderSide,
      positionSide: orderSide === 'BUY' ? 'LONG' : 'SHORT',
      type: 'MARKET',
      quantity: quantity.toString(),
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'false'
    };

    console.log('🐛 [DEBUG] placeOrder payload completo:', JSON.stringify(payload, null, 2));
    console.log('🐛 [DEBUG] placeOrder timestamp:', timestamp);

    // ✅ CREAR PARÁMETROS CON DEBUG
    const params = getParametersOfficial(payload, timestamp, false);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/order?${parametersUrlEncoded}&signature=${signature}`;

    console.log('🐛 [DEBUG] placeOrder URL completa:', url);
    console.log('🐛 [DEBUG] placeOrder headers:', { 'X-BX-APIKEY': `${API_KEY.substring(0,8)}...` });

    // ✅ REQUEST CON DEBUG ULTRA-DETALLADO
    console.log('🐛 [DEBUG] Enviando request...');
    const requestConfig = {
      method: 'POST',
      url: url,
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => {
        console.log('🐛 [DEBUG] Respuesta cruda de BingX:', resp);
        return resp;
      }
    };
    
    console.log('🐛 [DEBUG] Config del request:', {
      method: requestConfig.method,
      url: requestConfig.url,
      headers: { 'X-BX-APIKEY': `${API_KEY.substring(0,8)}...` }
    });

    const res = await fastAxios(requestConfig);
    
    console.log('🐛 [DEBUG] Status code:', res.status);
    console.log('🐛 [DEBUG] Headers respuesta:', res.headers);
    console.log('🐛 [DEBUG] Data type:', typeof res.data);
    console.log('🐛 [DEBUG] Data content:', res.data);
    
    return JSON.parse(res.data);
  } catch (error) {
    console.error('🐛 [DEBUG] placeOrder error completo:', error);
    console.error('🐛 [DEBUG] placeOrder error message:', error.message);
    console.error('🐛 [DEBUG] placeOrder error response:', error.response?.data);
    
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

// 💵 Obtener balance USDT
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
    
    console.log('🔍 Balance response type:', typeof res.data);
    
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

// 🛑 FUNCIÓN ULTRA-DEBUG - Cerrar todas posiciones
async function closeAllPositions(symbol) {
  const startTime = Date.now();
  console.log('🐛 [DEBUG] closeAllPositions iniciado para símbolo:', symbol);
  
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  
  try {
    const timestamp = Date.now();
    const normalizedSymbol = normalizeSymbol(symbol);
    
    console.log('🐛 [DEBUG] closeAllPositions timestamp:', timestamp);
    console.log('🐛 [DEBUG] closeAllPositions símbolo normalizado:', normalizedSymbol);
    
    // ✅ PAYLOAD PARA QUERY PARAMS
    const payload = {
      symbol: normalizedSymbol,
      side: 'BOTH',
      type: 'MARKET'
    };
    
    console.log('🐛 [DEBUG] closeAllPositions payload:', JSON.stringify(payload, null, 2));
    
    // ✅ CREAR PARÁMETROS CON DEBUG ULTRA-DETALLADO
    const params = getParametersOfficial(payload, timestamp, false);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/closeAllPositions?${parametersUrlEncoded}&signature=${signature}`;
    
    console.log('🐛 [DEBUG] closeAllPositions URL completa:', url);
    console.log('🐛 [DEBUG] closeAllPositions signature:', signature);
    
    // ✅ REQUEST CON DEBUG ULTRA-DETALLADO
    const requestConfig = {
      method: 'POST',
      url: url,
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => {
        console.log('🐛 [DEBUG] closeAllPositions respuesta cruda:', resp);
        return resp;
      }
    };
    
    console.log('🐛 [DEBUG] closeAllPositions enviando request...');
    const res = await fastAxios(requestConfig);
    
    console.log('🐛 [DEBUG] closeAllPositions status:', res.status);
    console.log('🐛 [DEBUG] closeAllPositions headers:', res.headers);
    console.log('🐛 [DEBUG] closeAllPositions data type:', typeof res.data);
    console.log('🐛 [DEBUG] closeAllPositions data:', res.data);
    
    const latency = Date.now() - startTime;
    console.log(`⚡ Close procesado en ${latency}ms`);
    
    return JSON.parse(res.data);
  } catch (error) {
    const latency = Date.now() - startTime;
    console.error('🐛 [DEBUG] closeAllPositions error completo:', error);
    console.error('🐛 [DEBUG] closeAllPositions error message:', error.message);
    console.error('🐛 [DEBUG] closeAllPositions error response:', error.response?.data);
    console.error(`❌ Error close en ${latency}ms:`, error.message);
    
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
