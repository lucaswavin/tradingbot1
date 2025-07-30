const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = "open-api.bingx.com";

// ⚡ POOL DE CONEXIONES ULTRA-RÁPIDO PARA SINGAPORE
const ultraFastAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 25,
  timeout: 2000,
  freeSocketTimeout: 4000
});

// ⚡ INSTANCIA AXIOS OPTIMIZADA
const fastAxios = axios.create({
  httpsAgent: ultraFastAgent,
  timeout: 3000,
  headers: {
    'Connection': 'keep-alive',
    'Content-Type': 'application/json',
    'User-Agent': 'TradingBot/1.0'
  },
  validateStatus: () => true
});

console.log('🔑 BingX API Keys configuradas:', {
  apiKey: API_KEY ? `${API_KEY.substring(0, 8)}...` : 'NO CONFIGURADA',
  secret: API_SECRET ? `${API_SECRET.substring(0, 8)}...` : 'NO CONFIGURADA'
});

// ⚡ NORMALIZACIÓN ULTRA-RÁPIDA
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  console.log(`🔄 Normalizando símbolo: ${symbol}`);
  let base = symbol.replace('.P', '');
  if (base.endsWith('USDT') && !base.includes('-')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  console.log(`✅ Símbolo normalizado: ${symbol} → ${base}`);
  return base;
}

// ⚡ PARÁMETROS OPTIMIZADOS (sin encoding innecesario)
function getParametersFast(payload, timestamp) {
  const keys = Object.keys(payload).sort();
  let parameters = "";
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) {
      parameters += `${key}=${payload[key]}&`;
    }
  }
  parameters += `timestamp=${timestamp}`;
  return parameters;
}

// ⚡ PRECIO ULTRA-RÁPIDO (con cache)
const priceCache = new Map();
async function getCurrentPrice(symbol) {
  const cacheKey = symbol;
  const cached = priceCache.get(cacheKey);
  
  // Cache de 5 segundos para velocidad
  if (cached && (Date.now() - cached.timestamp) < 5000) {
    return cached.price;
  }

  try {
    const response = await fastAxios.get(`https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`);
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    
    if (data?.code === 0) {
      const price = parseFloat(data.data.price);
      priceCache.set(cacheKey, { price, timestamp: Date.now() });
      return price;
    }
    throw new Error(`Respuesta inválida: ${JSON.stringify(data)}`);
  } catch (error) {
    console.error('❌ Error obteniendo precio:', error.message);
    throw error;
  }
}

// ⚡ CONTRATO INFO OPTIMIZADA
async function getContractInfo(symbol) {
  try {
    const response = await fastAxios.get(`https://${HOST}/openApi/swap/v2/quote/contracts`);
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    
    if (data?.code === 0) {
      const contract = data.data.find(c => c.symbol === symbol);
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
  } catch (e) {
    console.warn('⚠️ Error obteniendo contrato, usando valores por defecto');
  }
  return { minOrderQty: 0.001, tickSize: 0.01, stepSize: 0.001, minNotional: 1 };
}

// ⚡ LEVERAGE ULTRA-RÁPIDO (saltear si no es necesario)
async function setLeverage(symbol, leverage = 5) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    const timestamp = Date.now();
    const payload = { symbol, side: "LONG", leverage };
    const parameters = getParametersFast(payload, timestamp);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    
    const response = await fastAxios.post(`https://${HOST}/openApi/swap/v2/trade/leverage`, null, {
      params: { ...payload, timestamp, signature },
      headers: { 'X-BX-APIKEY': API_KEY }
    });
    
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    return data;
  } catch (error) {
    console.warn('⚠️ Error al establecer leverage:', error.message);
    return null;
  }
}

// 🚀 FUNCIÓN PRINCIPAL ULTRA-OPTIMIZADA
async function placeOrderInternal({ symbol, side, leverage = 5, usdtAmount = 1 }) {
  const startTime = Date.now();
  
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    // 1. Establecer leverage (en paralelo con precio)
    const leveragePromise = setLeverage(symbol, leverage);
    const pricePromise = getCurrentPrice(symbol);
    
    // 2. Ejecutar en paralelo para velocidad
    const [leverageResult, price] = await Promise.all([leveragePromise, pricePromise]);
    
    console.log(`💰 Precio actual de ${symbol}: ${price} USDT`);
    console.log(`💳 Margin deseado: ${usdtAmount} USDT`);
    console.log(`⚡ Leverage: ${leverage}x`);
    
    // 3. Cálculo optimizado
    const buyingPower = usdtAmount * leverage;
    console.log(`🚀 Poder de compra: ${usdtAmount} USDT × ${leverage}x = ${buyingPower} USDT`);
    
    let quantity = buyingPower / price;
    quantity = Math.round(quantity * 1000) / 1000;
    quantity = Math.max(0.001, quantity);
    
    console.log(`🧮 Quantity calculada: ${quantity} (${buyingPower} USDT ÷ ${price})`);
    console.log(`📊 Margin estimado a usar: ~${(quantity * price) / leverage} USDT`);

    // 4. Payload optimizado
    const timestamp = Date.now();
    const orderSide = side.toUpperCase();
    const payload = {
      symbol,
      side: orderSide,
      positionSide: orderSide === 'BUY' ? 'LONG' : 'SHORT',
      type: 'MARKET',
      quantity: quantity.toString(),
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'false'
    };

    console.log('📋 Payload orden:', payload);

    // 5. Firma ultra-rápida
    const parameters = getParametersFast(payload, timestamp);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');

    // 6. Request directo
    const response = await fastAxios.post(`https://${HOST}/openApi/swap/v2/trade/order`, null, {
      params: { ...payload, timestamp, signature },
      headers: { 'X-BX-APIKEY': API_KEY }
    });

    const latency = Date.now() - startTime;
    console.log(`⚡ Orden procesada en ${latency}ms`);

    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    return data;

  } catch (error) {
    const latency = Date.now() - startTime;
    console.error(`❌ Error en ${latency}ms:`, error.message);
    
    const data = error.response?.data;
    return {
      success: false,
      message: error.message,
      error: typeof data === 'string' ? JSON.parse(data) : data
    };
  }
}

// ⚡ SMART RETRY OPTIMIZADO
async function placeOrderWithSmartRetry(params) {
  const { symbol, side, leverage = 5 } = params;
  const normalizedSymbol = normalizeSymbol(symbol);

  console.log(`🚀 Intentando orden con 1 USDT para ${normalizedSymbol}...`);

  try {
    // Primer intento con 1 USDT
    const result = await placeOrderInternal({
      symbol: normalizedSymbol,
      side,
      leverage,
      usdtAmount: 1
    });

    // Si es exitoso, retornar
    if (result && result.code === 0) {
      console.log(`✅ ÉXITO con 1 USDT`);
      return result;
    }

    // Verificar si es error de mínimo y necesita retry
    const errorMsg = result?.msg || result?.message || JSON.stringify(result);
    console.log(`🔍 Analizando error: "${errorMsg}"`);
    
    const needsRetry = errorMsg.includes('minimum') || 
                       errorMsg.includes('less than') || 
                       errorMsg.includes('min ') ||
                       errorMsg.toLowerCase().includes('min notional') ||
                       errorMsg.includes('insufficient');

    if (needsRetry) {
      console.warn(`⚠️ Orden con 1 USDT falló (mínimo insuficiente), calculando mínimo real...`);
      
      // Extraer el mínimo del mensaje de error
      let minimumRequired = null;
      
      // Buscar patrón: "30.2 FHE" o "X.X SYMBOL"
      const match = errorMsg.match(/([\d.]+)\s+([A-Z]+)/);
      if (match) {
        const minQuantity = parseFloat(match[1]);
        const assetSymbol = match[2];
        console.log(`📏 Mínimo extraído: ${minQuantity} ${assetSymbol}`);
        
        // Calcular el USDT equivalente
        const price = await getCurrentPrice(normalizedSymbol);
        minimumRequired = minQuantity * price;
        console.log(`💰 Mínimo en USDT: ${minimumRequired} USDT (${minQuantity} × ${price})`);
      }
      
      // Si no pudo extraer, usar mínimo del contrato
      if (!minimumRequired) {
        console.log(`⚠️ No pudo extraer mínimo del error, consultando contrato...`);
        const contractInfo = await getContractInfo(normalizedSymbol);
        minimumRequired = contractInfo.minNotional || 10;
        console.log(`📋 Usando mínimo del contrato: ${minimumRequired} USDT`);
      }

      // Agregar un buffer del 10%
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
    
    // Si no necesita retry, retornar el error original
    console.log(`❌ Error no relacionado con mínimos, no reintentando`);
    return result;
    
  } catch (error) {
    console.error(`❌ Error en placeOrderWithSmartRetry:`, error.message);
    throw error;
  }
}

// Función principal
async function placeOrder(params) {
  return await placeOrderWithSmartRetry(params);
}

// ⚡ BALANCE ULTRA-RÁPIDO
async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    const timestamp = Date.now();
    const parameters = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    
    const response = await fastAxios.get(`https://${HOST}/openApi/swap/v2/user/balance`, {
      params: { timestamp, signature },
      headers: { 'X-BX-APIKEY': API_KEY }
    });

    console.log('🔍 Balance response type:', typeof response.data);

    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    
    if (data.code === 0) {
      // Manejar diferentes formatos de respuesta
      if (data.data && data.data.balance) {
        if (typeof data.data.balance === 'object' && data.data.balance.balance) {
          return parseFloat(data.data.balance.balance);
        }
      }
      
      // Formato array: { data: [{ asset: "USDT", balance: "123.45" }] }
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

// ⚡ CLOSE POSITION ULTRA-RÁPIDO
async function closePosition(symbol, side = 'BOTH') {
  const startTime = Date.now();
  
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    const timestamp = Date.now();
    const normalizedSymbol = normalizeSymbol(symbol);
    const payload = { symbol: normalizedSymbol, side: side, type: 'MARKET' };
    const parameters = getParametersFast(payload, timestamp);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');

    const response = await fastAxios.post(`https://${HOST}/openApi/swap/v2/trade/closeAllPositions`, null, {
      params: { ...payload, timestamp, signature },
      headers: { 'X-BX-APIKEY': API_KEY }
    });

    const latency = Date.now() - startTime;
    console.log(`⚡ Close procesado en ${latency}ms`);

    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    return data;
  } catch (error) {
    const latency = Date.now() - startTime;
    console.error(`❌ Error close en ${latency}ms:`, error.message);
    
    const data = error.response?.data;
    return {
      success: false,
      message: error.message,
      error: typeof data === 'string' ? JSON.parse(data) : data
    };
  }
}

async function closeAllPositions(symbol) {
  return await closePosition(symbol, 'BOTH');
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
