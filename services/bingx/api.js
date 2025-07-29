const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = "open-api.bingx.com";

console.log('🔑 BingX API Keys configuradas:', {
  apiKey: API_KEY ? `${API_KEY.substring(0, 8)}...` : 'NO CONFIGURADA',
  secret: API_SECRET ? `${API_SECRET.substring(0, 8)}...` : 'NO CONFIGURADA'
});

// Normaliza el symbol de TradingView a BingX
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  
  console.log(`🔄 Normalizando símbolo: ${symbol}`);
  
  let base = symbol.replace('.P', '');
  // BingX usa formato como BTC-USDT para perpetuos
  if (base.endsWith('USDT') && !base.includes('-')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  
  console.log(`✅ Símbolo normalizado: ${symbol} → ${base}`);
  return base;
}

// Función para obtener el precio actual
async function getCurrentPrice(symbol) {
  console.log(`💰 Obteniendo precio actual para: ${symbol}`);
  
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
    console.log(`🌐 URL precio: ${url}`);
    
    const response = await axios.get(url);
    console.log('📊 Respuesta precio completa:', JSON.stringify(response.data, null, 2));
    
    if (response.data && response.data.code === 0) {
      const price = parseFloat(response.data.data.price);
      console.log(`✅ Precio obtenido: ${price} USDT`);
      return price;
    }
    
    throw new Error(`Error en respuesta: ${JSON.stringify(response.data)}`);
  } catch (error) {
    console.error('❌ Error obteniendo precio:', error.message);
    if (error.response) {
      console.error('📄 Datos de error:', error.response.data);
    }
    throw error;
  }
}

// Calcula quantity basado en USDT a invertir
async function calculateQuantity(symbol, usdtAmount = 5) {
  console.log(`🧮 Calculando quantity para ${symbol} con ${usdtAmount} USDT`);
  
  try {
    const price = await getCurrentPrice(symbol);
    
    // Para contratos perpetuos, quantity es el número de contratos
    let quantity = usdtAmount / price;
    
    console.log(`📐 Quantity inicial calculada: ${quantity}`);
    
    // Redondear a 3 decimales
    quantity = Math.round(quantity * 1000) / 1000;
    
    // Mínimo 0.001 para la mayoría de pares
    quantity = Math.max(0.001, quantity);
    
    console.log(`💡 Quantity final: ${quantity} contratos (precio: ${price} USDT)`);
    return quantity;
  } catch (error) {
    console.error('❌ Error calculando quantity:', error.message);
    console.log('🔄 Usando quantity por defecto: 0.001');
    return 0.001;
  }
}

// Establecer leverage
async function setLeverage(symbol, leverage = 5) {
  console.log(`🔧 Estableciendo leverage ${leverage}x para ${symbol}`);
  
  if (!API_KEY || !API_SECRET) {
    throw new Error('BingX API keys no configuradas');
  }

  const timestamp = Date.now();
  const params = {
    leverage: leverage,
    symbol: symbol,
    timestamp: timestamp
  };

  console.log('📋 Parámetros leverage:', params);

  // Crear query string ordenado
  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
  const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
  
  console.log('🔐 Query string leverage:', queryString);
  console.log('🔐 Firma generada para leverage:', signature.substring(0, 16) + '...');
  
  const url = `https://${HOST}/openApi/swap/v2/trade/leverage`;
  const finalParams = { ...params, signature };
  
  console.log('🌐 URL leverage:', url);
  console.log('📤 Parámetros finales leverage:', finalParams);

  try {
    const response = await axios.post(url, null, {
      params: finalParams,
      headers: {
        'X-BX-APIKEY': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Leverage establecido exitosamente:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.warn('⚠️ Advertencia estableciendo leverage:', error.response?.data?.msg || error.message);
    if (error.response) {
      console.warn('📄 Datos del error leverage:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

// Función principal para colocar orden - CORREGIDA
async function placeOrder({ symbol, side, leverage = 5, usdtAmount = 5 }) {
  console.log('\n🚀 ===== INICIANDO ORDEN =====');
  console.log(`📊 Parámetros recibidos:`, { symbol, side, leverage, usdtAmount });
  
  if (!API_KEY || !API_SECRET) {
    throw new Error('BingX API keys no configuradas');
  }

  const normalizedSymbol = normalizeSymbol(symbol);
  console.log(`🎯 Procesando orden: ${side.toUpperCase()} ${normalizedSymbol}`);

  try {
    // 1. Establecer leverage
    console.log('\n--- PASO 1: Establecer Leverage ---');
    await setLeverage(normalizedSymbol, leverage);

    // 2. Calcular quantity
    console.log('\n--- PASO 2: Calcular Quantity ---');
    const quantity = await calculateQuantity(normalizedSymbol, usdtAmount);

    // 3. Preparar parámetros CORRECTOS según BingX API
    console.log('\n--- PASO 3: Preparar Orden ---');
    const timestamp = Date.now();
    const orderSide = side.toUpperCase();
    
    // PARÁMETROS CORRECTOS para BingX
    const orderParams = {
      positionSide: orderSide === 'BUY' ? 'LONG' : 'SHORT',
      quantity: quantity.toString(), // Convertir a string
      side: orderSide,
      symbol: normalizedSymbol,
      timestamp: timestamp,
      type: 'MARKET'
    };

    console.log('📋 Parámetros de orden preparados:', orderParams);

    // 4. Crear query string ORDENADO ALFABÉTICAMENTE
    console.log('\n--- PASO 4: Crear Firma ---');
    const sortedKeys = Object.keys(orderParams).sort();
    console.log('📝 Claves ordenadas:', sortedKeys);
    
    const queryString = sortedKeys.map(key => `${key}=${orderParams[key]}`).join('&');
    console.log('🔐 Query string ordenado:', queryString);
    
    const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
    console.log('🔐 Firma generada:', signature.substring(0, 16) + '...');

    // 5. Ejecutar orden con FORMATO CORRECTO
    console.log('\n--- PASO 5: Ejecutar Orden ---');
    const url = `https://${HOST}/openApi/swap/v2/trade/order`;
    
    // Parámetros finales con firma
    const finalParams = {
      ...orderParams,
      signature: signature
    };

    console.log('🌐 URL orden:', url);
    console.log('📤 Parámetros finales de orden:', finalParams);

    // ENVIAR COMO FORM DATA, NO QUERY STRING
    const response = await axios.post(url, null, {
      params: finalParams, // BingX espera los parámetros como query params
      headers: {
        'X-BX-APIKEY': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    console.log('\n✅ ===== ORDEN EJECUTADA =====');
    console.log('📈 Status HTTP:', response.status);
    console.log('🎉 Respuesta BingX:', JSON.stringify(response.data, null, 2));
    console.log('===========================\n');
    
    return response.data;

  } catch (error) {
    console.log('\n❌ ===== ERROR EN ORDEN =====');
    console.error('💥 Error en placeOrder:', error.message);
    
    if (error.response) {
      console.error('📊 Status HTTP:', error.response.status);
      console.error('🔍 Headers respuesta:', error.response.headers);
      console.error('📄 Datos del error COMPLETOS:', JSON.stringify(error.response.data, null, 2));
      
      // Log adicional para debug
      if (error.response.data && error.response.data.msg) {
        console.error('📝 Mensaje específico del error:', error.response.data.msg);
      }
      
      return {
        success: false,
        error: error.response.data,
        code: error.response.status,
        message: error.response.data?.msg || 'Error desconocido'
      };
    } else {
      console.error('🌐 Error de red:', error.message);
      console.log('============================\n');
      throw error;
    }
  }
}

// Función para obtener balance
async function getUSDTBalance() {
  console.log('\n💰 ===== OBTENIENDO BALANCE =====');
  
  if (!API_KEY || !API_SECRET) {
    throw new Error('BingX API keys no configuradas');
  }

  const timestamp = Date.now();
  const params = { timestamp };
  
  console.log('📋 Parámetros balance:', params);
  
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
  
  console.log('🔐 Firma balance:', signature.substring(0, 16) + '...');
  
  const url = `https://${HOST}/openApi/swap/v2/user/balance?${queryString}&signature=${signature}`;
  console.log('🌐 URL balance:', url);

  try {
    const response = await axios.get(url, {
      headers: {
        'X-BX-APIKEY': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Respuesta balance completa:', JSON.stringify(response.data, null, 2));

    if (response.data && response.data.code === 0) {
      const data = response.data.data;
      
      console.log('🔍 Analizando estructura del balance...');
      
      if (data && data.balance) {
        console.log('📊 Formato detectado: objeto con balance');
        if (typeof data.balance === 'object' && data.balance.balance) {
          const balance = parseFloat(data.balance.balance);
          console.log(`💵 Balance extraído (objeto): ${balance} USDT`);
          return balance;
        }
        if (typeof data.balance === 'string') {
          const balance = parseFloat(data.balance);
          console.log(`💵 Balance extraído (string): ${balance} USDT`);
          return balance;
        }
      }
      
      if (Array.isArray(data)) {
        console.log('📊 Formato detectado: array de balances');
        const usdt = data.find(item => item.asset === 'USDT');
        if (usdt) {
          const balance = parseFloat(usdt.balance || 0);
          console.log(`💵 Balance USDT encontrado: ${balance} USDT`);
          return balance;
        }
      }
      
      if (typeof data === 'number') {
        console.log(`💵 Balance directo: ${data} USDT`);
        return data;
      }
    }

    throw new Error(`Formato de respuesta inesperado: ${JSON.stringify(response.data)}`);
    
  } catch (error) {
    console.log('\n❌ ===== ERROR BALANCE =====');
    console.error('💥 Error obteniendo balance:', error.message);
    if (error.response) {
      console.error('📊 Status:', error.response.status);
      console.error('📄 Data:', JSON.stringify(error.response.data, null, 2));
    }
    console.log('==========================\n');
    throw error;
  }
}

module.exports = {
  getUSDTBalance,
  placeOrder,
  normalizeSymbol,
  setLeverage,
  getCurrentPrice
};
