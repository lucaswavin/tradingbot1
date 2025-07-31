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

// 🔐 FUNCIÓN CORREGIDA - Construir parámetros con manejo de números
function getParameters(payload, timestamp, urlEncode = false) {
  console.log('🐛 [DEBUG] getParameters entrada:');
  console.log('🐛 [DEBUG] - payload:', JSON.stringify(payload, null, 2));
  console.log('🐛 [DEBUG] - timestamp:', timestamp);
  console.log('🐛 [DEBUG] - urlEncode:', urlEncode);
  
  let parameters = "";
  let stepCounter = 0;
  
  // Primero agregar todos los parámetros del payload
  for (const key in payload) {
    stepCounter++;
    console.log(`🐛 [DEBUG] - PASO ${stepCounter}: procesando clave "${key}"`);
    
    if (payload[key] !== undefined && payload[key] !== null) {
      const value = payload[key];
      console.log(`🐛 [DEBUG] - PASO ${stepCounter}: valor = "${value}" (tipo: ${typeof value})`);
      
      // Convertir números a string para la URL
      const stringValue = String(value);
      
      let paramPart = "";
      if (urlEncode) {
        paramPart = key + "=" + encodeURIComponent(stringValue) + "&";
        console.log(`🐛 [DEBUG] - PASO ${stepCounter}: agregando (encoded): "${paramPart}"`);
      } else {
        paramPart = key + "=" + stringValue + "&";
        console.log(`🐛 [DEBUG] - PASO ${stepCounter}: agregando (normal): "${paramPart}"`);
      }
      
      parameters += paramPart;
      console.log(`🐛 [DEBUG] - PASO ${stepCounter}: parameters ahora = "${parameters}"`);
    } else {
      console.log(`🐛 [DEBUG] - PASO ${stepCounter}: saltando "${key}" (undefined/null)`);
    }
  }
  
  console.log('🐛 [DEBUG] - parameters ANTES de timestamp:', parameters);
  
  // Luego agregar timestamp AL FINAL (como en el ejemplo oficial)
  if (parameters) {
    // Quitar el último &
    const withoutLastAmpersand = parameters.substring(0, parameters.length - 1);
    console.log('🐛 [DEBUG] - sin ultimo &:', withoutLastAmpersand);
    
    // Agregar timestamp
    parameters = withoutLastAmpersand + "&timestamp=" + timestamp;
    console.log('🐛 [DEBUG] - con timestamp agregado:', parameters);
  } else {
    parameters = "timestamp=" + timestamp;
    console.log('🐛 [DEBUG] - solo timestamp (payload vacio):', parameters);
  }
  
  console.log('🐛 [DEBUG] - parameters FINALES:', parameters);
  return parameters;
}

// 🔐 FUNCIÓN OFICIAL - Crear signature como en el ejemplo
function createBingXSignature(payload, timestamp) {
  const parameters = getParameters(payload, timestamp, false); // Sin URL encoding para signature
  const signature = crypto
    .createHmac('sha256', API_SECRET)
    .update(parameters)
    .digest('hex');
  
  console.log('🐛 [DEBUG] - parameters para signature:', parameters);
  console.log('🐛 [DEBUG] - signature creada:', signature);
  return signature;
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

// ⚙️ Establecer modo de margen ISOLATED
async function setMarginMode(symbol, marginMode = 'ISOLATED') {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  
  try {
    console.log(`🐛 [DEBUG] setMarginMode iniciado: ${symbol} -> ${marginMode}`);
    const timestamp = Date.now();
    const payload = { 
      symbol, 
      marginMode // 'ISOLATED' o 'CROSS'
    };
    
    console.log('🐛 [DEBUG] setMarginMode payload:', JSON.stringify(payload, null, 2));
    
    const signature = createBingXSignature(payload, timestamp);
    const parametersEncoded = getParameters(payload, timestamp, true);
    const url = `https://${HOST}/openApi/swap/v2/trade/marginMode?${parametersEncoded}&signature=${signature}`;
    
    console.log('🐛 [DEBUG] setMarginMode URL:', url);
    
    const config = {
      method: 'POST',
      url: url,
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => {
        console.log('🐛 [DEBUG] setMarginMode raw response:', resp);
        return resp;
      }
    };
    
    const res = await fastAxios(config);
    const data = JSON.parse(res.data);
    console.log('🐛 [DEBUG] setMarginMode respuesta:', data);
    
    if (data.code === 0) {
      console.log(`✅ Modo de margen establecido: ${marginMode} para ${symbol}`);
    } else {
      console.warn(`⚠️ No se pudo establecer modo ${marginMode}:`, data.msg);
    }
    
    return data;
  } catch (error) {
    console.error('🐛 [DEBUG] setMarginMode error:', error.message);
    console.warn('⚠️ Error al establecer modo de margen:', error.message);
    return null;
  }
}

// ⚙️ Establecer leverage 5x
async function setLeverage(symbol, leverage = 5) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  
  try {
    console.log('🐛 [DEBUG] setLeverage iniciado');
    const timestamp = Date.now();
    const payload = { 
      symbol, 
      side: 'LONG', 
      leverage: leverage
    };
    
    console.log('🐛 [DEBUG] setLeverage payload:', JSON.stringify(payload, null, 2));
    
    const signature = createBingXSignature(payload, timestamp);
    const parametersEncoded = getParameters(payload, timestamp, true);
    const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${parametersEncoded}&signature=${signature}`;
    
    console.log('🐛 [DEBUG] setLeverage URL:', url);
    
    const config = {
      method: 'POST',
      url: url,
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => {
        console.log('🐛 [DEBUG] setLeverage raw response:', resp);
        return resp;
      }
    };
    
    const res = await fastAxios(config);
    const data = JSON.parse(res.data);
    console.log('🐛 [DEBUG] setLeverage respuesta:', data);
    
    if (data.code === 0) {
      console.log(`✅ Leverage establecido: ${leverage}x para ${symbol}`);
    } else {
      console.warn(`⚠️ No se pudo establecer leverage ${leverage}x:`, data.msg);
    }
    
    return data;
  } catch (error) {
    console.error('🐛 [DEBUG] setLeverage error:', error.message);
    console.warn('⚠️ Error al establecer leverage:', error.message);
    return null;
  }
}

// 🛒 FUNCIÓN PRINCIPAL - Colocar orden con ISOLATED + 5x + 1 USDT
async function placeOrderInternal({ symbol, side, leverage = 5, usdtAmount = 1, marginMode = 'ISOLATED' }) {
  console.log('🐛 [DEBUG] placeOrderInternal iniciado con:', { symbol, side, leverage, usdtAmount, marginMode });
  
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    // 1️⃣ Establecer modo ISOLATED
    console.log('🔧 PASO 1: Estableciendo modo ISOLATED...');
    await setMarginMode(symbol, marginMode);
    
    // 2️⃣ Establecer leverage 5x
    console.log('🔧 PASO 2: Estableciendo leverage 5x...');
    await setLeverage(symbol, leverage);

    // 3️⃣ Obtener precio actual
    console.log('🔧 PASO 3: Obteniendo precio actual...');
    const price = await getCurrentPrice(symbol);
    console.log(`💰 Precio actual de ${symbol}: ${price} USDT`);
    
    // 4️⃣ Calcular cantidad con 1 USDT + 5x leverage
    console.log('🔧 PASO 4: Calculando cantidad...');
    const buyingPower = usdtAmount * leverage; // 1 * 5 = 5 USDT de poder de compra
    let quantity = buyingPower / price;
    quantity = Math.round(quantity * 1000) / 1000;
    quantity = Math.max(0.001, quantity);
    
    console.log(`🧮 Cálculo: ${usdtAmount} USDT × ${leverage}x = ${buyingPower} USDT de poder`);
    console.log(`🧮 Cantidad: ${buyingPower} ÷ ${price} = ${quantity}`);

    // 5️⃣ Construir payload según documentación BingX
    console.log('🔧 PASO 5: Construyendo orden...');
    const timestamp = Date.now();
    const orderSide = side.toUpperCase();
    
    // ✅ PAYLOAD SEGÚN DOCUMENTACIÓN OFICIAL BingX
    const payload = {
      symbol: symbol, // ORDER-USDT (con guión)
      type: 'MARKET',
      side: orderSide, // BUY o SELL
      quantity: quantity, // COMO NÚMERO (no string)
      workingType: 'CONTRACT_PRICE' // Requerido según documentación
    };

    console.log('🐛 [DEBUG] placeOrder payload FINAL:', JSON.stringify(payload, null, 2));
    console.log(`🏷️ Configuración FINAL: ${marginMode} mode, ${leverage}x leverage, ${usdtAmount} USDT`);

    // 6️⃣ Ejecutar orden
    console.log('🔧 PASO 6: Ejecutando orden...');
    const signature = createBingXSignature(payload, timestamp);
    const parametersEncoded = getParameters(payload, timestamp, true);
    const url = `https://${HOST}/openApi/swap/v2/trade/order?${parametersEncoded}&signature=${signature}`;

    console.log('🐛 [DEBUG] placeOrder URL FINAL:', url);

    const config = {
      method: 'POST',
      url: url,
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => {
        console.log('🐛 [DEBUG] placeOrder raw response:', resp);
        return resp;
      }
    };

    const res = await fastAxios(config);
    const data = JSON.parse(res.data);
    console.log('🐛 [DEBUG] placeOrder respuesta FINAL:', data);
    
    if (data.code === 0) {
      console.log('🎉 ¡ORDEN EJECUTADA EXITOSAMENTE!');
      console.log(`✅ Símbolo: ${symbol}`);
      console.log(`✅ Lado: ${orderSide}`);
      console.log(`✅ Cantidad: ${quantity}`);
      console.log(`✅ Modo: ${marginMode}`);
      console.log(`✅ Leverage: ${leverage}x`);
      console.log(`✅ Inversión: ${usdtAmount} USDT`);
      if (data.data?.orderId) {
        console.log(`✅ Order ID: ${data.data.orderId}`);
      }
    }
    
    return data;
  } catch (error) {
    console.error('🐛 [DEBUG] placeOrder error:', error.message);
    console.error('🐛 [DEBUG] placeOrder response:', error.response?.data);
    
    return {
      success: false,
      message: error.message,
      error: error.response?.data
    };
  }
}

// 🔄 Retry inteligente con configuración final
async function placeOrderWithSmartRetry(params) {
  const { symbol, side, leverage = 5, marginMode = 'ISOLATED' } = params;
  const normalizedSymbol = normalizeSymbol(symbol);

  console.log(`🚀 Intentando orden ${marginMode} con 1 USDT × ${leverage}x leverage para ${normalizedSymbol}...`);

  try {
    const result = await placeOrderInternal({
      symbol: normalizedSymbol,
      side,
      leverage,
      usdtAmount: 1, // ← FIJO EN 1 USDT
      marginMode
    });

    if (result && result.code === 0) {
      console.log(`✅ ÉXITO con 1 USDT en modo ${marginMode} × ${leverage}x`);
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
        usdtAmount: finalAmount,
        marginMode
      });
      
      if (retryResult && retryResult.code === 0) {
        console.log(`✅ ÉXITO con ${finalAmount} USDT en modo ${marginMode} × ${leverage}x`);
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

// 🏷️ Función pública - ISOLATED + 5x + 1 USDT por defecto
async function placeOrder(params) {
  // CONFIGURACIÓN FIJA FINAL
  const finalParams = { 
    marginMode: 'ISOLATED', // ← Modo aislado
    leverage: 5,            // ← 5x leverage
    usdtAmount: 1,          // ← 1 USDT por orden
    ...params 
  };
  return placeOrderWithSmartRetry(finalParams);
}

// 💵 Obtener balance USDT
async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  
  try {
    const timestamp = Date.now();
    const payload = {};
    
    const signature = createBingXSignature(payload, timestamp);
    const parametersEncoded = getParameters(payload, timestamp, true);
    const url = `https://${HOST}/openApi/swap/v2/user/balance?${parametersEncoded}&signature=${signature}`;
    
    const config = {
      method: 'GET',
      url: url,
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => {
        console.log('🐛 [DEBUG] balance raw response:', resp);
        return resp;
      }
    };
    
    const res = await fastAxios(config);
    const data = JSON.parse(res.data);
    console.log('🔍 Balance response:', data);
    
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

// 🛑 FUNCIÓN - Cerrar todas posiciones
async function closeAllPositions(symbol) {
  const startTime = Date.now();
  console.log('🐛 [DEBUG] closeAllPositions iniciado para símbolo:', symbol);
  
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  
  try {
    const timestamp = Date.now();
    const normalizedSymbol = normalizeSymbol(symbol);
    
    console.log('🐛 [DEBUG] closeAllPositions símbolo normalizado:', normalizedSymbol);
    
    const payload = {
      symbol: normalizedSymbol,
      side: 'BOTH',
      type: 'MARKET'
    };
    
    console.log('🐛 [DEBUG] closeAllPositions payload:', JSON.stringify(payload, null, 2));
    
    const signature = createBingXSignature(payload, timestamp);
    const parametersEncoded = getParameters(payload, timestamp, true);
    const url = `https://${HOST}/openApi/swap/v2/trade/closeAllPositions?${parametersEncoded}&signature=${signature}`;
    
    console.log('🐛 [DEBUG] closeAllPositions URL:', url);
    
    const config = {
      method: 'POST',
      url: url,
      headers: { 'X-BX-APIKEY': API_KEY },
      transformResponse: (resp) => {
        console.log('🐛 [DEBUG] closeAllPositions raw response:', resp);
        return resp;
      }
    };
    
    const res = await fastAxios(config);
    const data = JSON.parse(res.data);
    console.log('🐛 [DEBUG] closeAllPositions respuesta:', data);
    
    const latency = Date.now() - startTime;
    console.log(`⚡ Close procesado en ${latency}ms`);
    
    return data;
  } catch (error) {
    const latency = Date.now() - startTime;
    console.error('🐛 [DEBUG] closeAllPositions error:', error.message);
    console.error(`❌ Error close en ${latency}ms:`, error.message);
    
    return {
      success: false,
      message: error.message,
      error: error.response?.data
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
  setMarginMode,
  getCurrentPrice,
  closePosition,
  closeAllPositions,
  getContractInfo,
  placeOrderWithSmartRetry
};
