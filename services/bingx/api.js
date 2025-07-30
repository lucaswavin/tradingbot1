const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = "open-api.bingx.com";

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

console.log('🔑 BingX API Keys configuradas:', {
  apiKey: API_KEY ? `${API_KEY.substring(0, 8)}...` : 'NO CONFIGURADA',
  secret: API_SECRET ? `${API_SECRET.substring(0, 8)}...` : 'NO CONFIGURADA'
});

// 🔄 Normalizar símbolos
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

// 🔐 MÉTODO OFICIAL BINGX PARA PARÁMETROS (basado en su documentación)
function getParametersOfficial(payload, timestamp, urlEncode = false) {
  let parameters = "";
  
  // Ordenar alfabéticamente (crítico para BingX)
  const sortedKeys = Object.keys(payload).sort();
  
  for (const key of sortedKeys) {
    if (payload[key] !== undefined && payload[key] !== null) {
      if (urlEncode) {
        parameters += `${key}=${encodeURIComponent(payload[key])}&`;
      } else {
        parameters += `${key}=${payload[key]}&`;
      }
    }
  }
  
  // Método oficial: quitar último & y agregar timestamp al final
  if (parameters) {
    parameters = parameters.substring(0, parameters.length - 1);
    parameters = parameters + "&timestamp=" + timestamp;
  } else {
    parameters = "timestamp=" + timestamp;
  }
  
  return parameters;
}

// 💰 Obtener precio actual
async function getCurrentPrice(symbol) {
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
    const response = await fastAxios.get(url);
    if (response.data?.code === 0) {
      return parseFloat(response.data.data.price);
    }
    throw new Error(`Respuesta inválida: ${JSON.stringify(response.data)}`);
  } catch (error) {
    console.error('❌ Error obteniendo precio:', error.message);
    throw error;
  }
}

// ℹ️ Obtener información del contrato
async function getContractInfo(symbol) {
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/contracts`;
    const response = await fastAxios.get(url);
    if (response.data?.code === 0) {
      const contract = response.data.data.find(c => c.symbol === symbol);
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

// ⚙️ Establecer leverage (MÉTODO OFICIAL)
async function setLeverage(symbol, leverage = 5) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    const timestamp = Date.now();
    const payload = { symbol, side: "LONG", leverage };
    
    // Usar método oficial de BingX
    const parameters = getParametersOfficial(payload, timestamp);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${parametersUrlEncoded}&signature=${signature}`;

    const response = await fastAxios.post(url, null, {
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => resp // Mantener como string (importante)
    });

    return JSON.parse(response.data);
  } catch (error) {
    console.warn('⚠️ Error al establecer leverage:', error.message);
    return null;
  }
}

// 🛒 Colocar orden interna (MÉTODO OFICIAL)
async function placeOrderInternal({ symbol, side, leverage = 5, usdtAmount = 1 }) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    await setLeverage(symbol, leverage);

    const price = await getCurrentPrice(symbol);
    console.log(`💰 Precio actual de ${symbol}: ${price} USDT`);
    console.log(`💳 Margin deseado: ${usdtAmount} USDT`);
    console.log(`⚡ Leverage: ${leverage}x`);
    
    const buyingPower = usdtAmount * leverage;
    console.log(`🚀 Poder de compra: ${usdtAmount} USDT × ${leverage}x = ${buyingPower} USDT`);
    
    let quantity = buyingPower / price;
    quantity = Math.round(quantity * 1000) / 1000;
    quantity = Math.max(0.001, quantity);
    
    console.log(`🧮 Quantity calculada: ${quantity} (${buyingPower} USDT ÷ ${price})`);
    console.log(`📊 Margin estimado a usar: ~${(quantity * price) / leverage} USDT`);

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

    // MÉTODO OFICIAL BINGX (igual que su documentación)
    const parameters = getParametersOfficial(payload, timestamp);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/order?${parametersUrlEncoded}&signature=${signature}`;

    console.log('🔧 Debug parameters:', parameters);
    console.log('🔧 Debug signature:', signature);

    const response = await fastAxios.post(url, null, {
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => resp // Crítico: mantener como string para big integers
    });

    return JSON.parse(response.data);
  } catch (error) {
    const data = error.response?.data;
    return {
      success: false,
      message: error.message,
      error: typeof data === 'string' ? JSON.parse(data) : data
    };
  }
}

// 🔁 Colocar orden con retry inteligente
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

// 🧾 Colocar orden pública
async function placeOrder(params) {
  return await placeOrderWithSmartRetry(params);
}

// 💵 Obtener balance (MÉTODO OFICIAL)
async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    const timestamp = Date.now();
    const parameters = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/user/balance?${parameters}&signature=${signature}`;

    const response = await fastAxios.get(url, {
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => resp // Mantener como string
    });

    console.log('🔍 Balance response type:', typeof response.data);

    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

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

// ❌ Cerrar posición (MÉTODO OFICIAL)
async function closePosition(symbol, side = 'BOTH') {
  const startTime = Date.now();
  
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    const timestamp = Date.now();
    const normalizedSymbol = normalizeSymbol(symbol);
    const payload = {
      symbol: normalizedSymbol,
      side: side,
      type: 'MARKET'
    };

    // Usar método oficial de BingX
    const parameters = getParametersOfficial(payload, timestamp);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/closeAllPositions?${parametersUrlEncoded}&signature=${signature}`;

    console.log('🔧 Debug close parameters:', parameters);

    const response = await fastAxios.post(url, null, {
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => resp
    });

    const latency = Date.now() - startTime;
    console.log(`⚡ Close procesado en ${latency}ms`);

    return JSON.parse(response.data);
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

// ❌ Cerrar todo
async function closeAllPositions(symbol) {
  return await closePosition(symbol, 'BOTH');
}

// 📦 Exportar funciones
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

