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

// Construye query string ordenado para firma
function buildQueryString(params) {
  const filtered = Object.keys(params)
    .filter(key => params[key] !== undefined && params[key] !== '')
    .sort(); // IMPORTANTE: orden alfabético para la firma
  
  console.log('📝 Claves ordenadas para firma:', filtered);
  
  const queryString = filtered
    .map(key => `${key}=${params[key]}`)
    .join('&');
    
  console.log('🔗 Query string construido:', queryString);
  return queryString;
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
    // Cada contrato vale 1 USD del activo base
    let quantity = usdtAmount / price;
    
    console.log(`📐 Quantity inicial calculada: ${quantity}`);
    
    // Redondear a 3 decimales (ajustar según el símbolo)
    quantity = Math.round(quantity * 1000) / 1000;
    
    // Mínimo 0.001 para la mayoría de pares
    quantity = Math.max(0.001, quantity);
    
    console.log(`💡 Quantity final: ${quantity} contratos (precio: ${price} USDT)`);
    return quantity;
  } catch (error) {
    console.error('❌ Error calculando quantity:', error.message);
    console.log('🔄 Usando quantity por defecto: 0.001');
    return 0.001; // Cantidad mínima por defecto
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

  const queryString = buildQueryString(params);
  const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
  
  console.log('🔐 Firma generada para leverage:', signature.substring(0, 16) + '...');
  
  const finalParams = { ...params, signature };
  const url = `https://${HOST}/openApi/swap/v2/trade/leverage`;
  
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
    // No fallar si el leverage ya está establecido
    console.warn('⚠️ Advertencia estableciendo leverage:', error.response?.data?.msg || error.message);
    if (error.response) {
      console.warn('📄 Datos del error leverage:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

// Función principal para colocar orden
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

    // 3. Preparar parámetros según documentación BingX
    console.log('\n--- PASO 3: Preparar Orden ---');
    const timestamp = Date.now();
    const orderSide = side.toUpperCase();
    
    const params = {
      positionSide: orderSide === 'BUY' ? 'LONG' : 'SHORT',
      quantity: quantity,
      side: orderSide,
      symbol: normalizedSymbol,
      timestamp: timestamp,
      type: 'MARKET'
    };

    console.log('📋 Parámetros de orden preparados:', params);

    // 4. Crear firma
    console.log('\n--- PASO 4: Crear Firma ---');
    const queryString = buildQueryString(params);
    const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
    
    console.log('🔐 Query para firma:', queryString);
    console.log('🔐 Firma generada:', signature.substring(0, 16) + '...');
    
    // 5. URL final con todos los parámetros
    const finalQueryString = `${queryString}&signature=${signature}`;
    const url = `https://${HOST}/openApi/swap/v2/trade/order?${finalQueryString}`;

    console.log('\n--- PASO 5: Ejecutar Orden ---');
    console.log('🌐 URL completa:', url);

    // 6. Ejecutar orden
    const response = await axios.post(url, null, {
      headers: {
        'X-BX-APIKEY': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    console.log('\n✅ ===== ORDEN EJECUTADA =====');
    console.log('📈 Status:', response.status);
    console.log('🎉 Respuesta BingX:', JSON.stringify(response.data, null, 2));
    console.log('===========================\n');
    
    return response.data;

  } catch (error) {
    console.log('\n❌ ===== ERROR EN ORDEN =====');
    console.error('💥 Error en placeOrder:', error.message);
    
    if (error.response) {
      console.error('📊 Status HTTP:', error.response.status);
      console.error('🔍 Headers respuesta:', error.response.headers);
      console.error('📄 Datos del error:', JSON.stringify(error.response.data, null, 2));
      
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
  
  const queryString = buildQueryString(params);
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
      
      // Manejar diferentes formatos de respuesta
      if (data && data.balance) {
        console.log('📊 Formato detectado: objeto con balance');
        // Formato: { balance: { balance: "123.45", availableMargin: "..." } }
        if (typeof data.balance === 'object' && data.balance.balance) {
          const balance = parseFloat(data.balance.balance);
          console.log(`💵 Balance extraído (objeto): ${balance} USDT`);
          return balance;
        }
        // Formato: { balance: "123.45" }
        if (typeof data.balance === 'string') {
          const balance = parseFloat(data.balance);
          console.log(`💵 Balance extraído (string): ${balance} USDT`);
          return balance;
        }
      }
      
      // Formato array: [{ asset: "USDT", balance: "123.45" }]
      if (Array.isArray(data)) {
        console.log('📊 Formato detectado: array de balances');
        console.log('🔍 Buscando USDT en array...');
        const usdt = data.find(item => item.asset === 'USDT');
        if (usdt) {
          const balance = parseFloat(usdt.balance || 0);
          console.log(`💵 Balance USDT encontrado: ${balance} USDT`);
          return balance;
        } else {
          console.log('⚠️ No se encontró USDT en el array');
          return 0;
        }
      }
      
      // Si data es directamente un número
      if (typeof data === 'number') {
        console.log(`💵 Balance directo: ${data} USDT`);
        return data;
      }
    }

    console.log('❌ Formato de respuesta no reconocido');
    throw new Error(`Formato de respuesta inesperado: ${JSON.stringify(response.data)}`);
    
  } catch (error) {
    console.log('\n❌ ===== ERROR BALANCE =====');
    console.error('💥 Error obteniendo balance:', error.message);
    if (error.response) {
      console.error('📊 Status:', error.response.status);
      console.error('📄 Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('🌐 Error de red:', error.message);
    }
    console.log('==========================\n');
    throw error;
  }
}

// Función para obtener posiciones
async function getPositions() {
  console.log('\n📊 ===== OBTENIENDO POSICIONES =====');
  
  if (!API_KEY || !API_SECRET) {
    throw new Error('BingX API keys no configuradas');
  }

  const timestamp = Date.now();
  const params = { timestamp };
  
  const queryString = buildQueryString(params);
  const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
  
  const url = `https://${HOST}/openApi/swap/v2/user/positions?${queryString}&signature=${signature}`;
  console.log('🌐 URL posiciones:', url);

  try {
    const response = await axios.get(url, {
      headers: {
        'X-BX-APIKEY': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Posiciones obtenidas:', JSON.stringify(response.data, null, 2));
    console.log('=================================\n');
    
    return response.data;
  } catch (error) {
    console.error('❌ Error obteniendo posiciones:', error.response?.data || error.message);
    if (error.response) {
      console.error('📄 Datos del error:', JSON.stringify(error.response.data, null, 2));
    }
    console.log('=================================\n');
    throw error;
  }
}

module.exports = {
  getUSDTBalance,
  placeOrder,
  normalizeSymbol,
  setLeverage,
  getPositions,
  getCurrentPrice
};
