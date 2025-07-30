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

// Función oficial de BingX para construir parámetros
function getParameters(payload, timestamp, urlEncode = false) {
  let parameters = "";
  
  console.log('📋 Payload original:', payload);
  
  for (const key in payload) {
    if (payload[key] !== undefined && payload[key] !== null) {
      if (urlEncode) {
        parameters += key + "=" + encodeURIComponent(payload[key]) + "&";
      } else {
        parameters += key + "=" + payload[key] + "&";
      }
    }
  }
  
  if (parameters) {
    parameters = parameters.substring(0, parameters.length - 1);
    parameters = parameters + "&timestamp=" + timestamp;
  } else {
    parameters = "timestamp=" + timestamp;
  }
  
  console.log('🔗 Parámetros construidos:', parameters);
  return parameters;
}

// Función para obtener el precio actual
async function getCurrentPrice(symbol) {
  console.log(`💰 Obteniendo precio actual para: ${symbol}`);
  
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
    console.log(`🌐 URL precio: ${url}`);
    
    const response = await axios.get(url, { timeout: 5000 });
    console.log('📊 Respuesta precio:', JSON.stringify(response.data, null, 2));
    
    if (response.data && response.data.code === 0) {
      const price = parseFloat(response.data.data.price);
      console.log(`✅ Precio obtenido: ${price} USDT`);
      return price;
    }
    
    throw new Error(`Error en respuesta precio: ${JSON.stringify(response.data)}`);
  } catch (error) {
    console.error('❌ Error obteniendo precio:', error.message);
    throw error;
  }
}

// Calcula quantity basado en USDT a invertir
async function calculateQuantity(symbol, usdtAmount = 5) {
  console.log(`🧮 Calculando quantity para ${symbol} con ${usdtAmount} USDT`);
  
  try {
    const price = await getCurrentPrice(symbol);
    let quantity = usdtAmount / price;
    
    console.log(`📐 Quantity inicial calculada: ${quantity}`);
    
    // Redondear a 3 decimales
    quantity = Math.round(quantity * 1000) / 1000;
    quantity = Math.max(0.001, quantity);
    
    console.log(`💡 Quantity final: ${quantity} contratos`);
    return quantity;
  } catch (error) {
    console.error('❌ Error calculando quantity:', error.message);
    console.log('🔄 Usando quantity por defecto: 0.001');
    return 0.001;
  }
}

// Establecer leverage según formato oficial
async function setLeverage(symbol, leverage = 5) {
  console.log(`🔧 Estableciendo leverage ${leverage}x para ${symbol}`);
  
  if (!API_KEY || !API_SECRET) {
    throw new Error('BingX API keys no configuradas');
  }

  try {
    const timestamp = new Date().getTime();
    
    // Payload según documentación oficial BingX
    const payload = {
      symbol: symbol,
      side: "LONG", // Requerido para leverage
      leverage: leverage
    };

    console.log('📋 Payload leverage:', payload);

    // Construir parámetros usando función oficial
    const parameters = getParameters(payload, timestamp, false);
    const parametersUrlEncoded = getParameters(payload, timestamp, true);
    
    console.log('🔐 Parámetros para firma:', parameters);
    console.log('🔗 Parámetros URL encoded:', parametersUrlEncoded);
    
    // Crear firma usando método oficial
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    console.log('🔐 Firma generada:', signature.substring(0, 16) + '...');
    
    // URL final según formato oficial
    const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${parametersUrlEncoded}&signature=${signature}`;
    console.log('🌐 URL leverage completa:', url);

    const response = await axios.post(url, null, {
      headers: {
        'X-BX-APIKEY': API_KEY
      },
      timeout: 8000,
      transformResponse: (resp) => {
        console.log('📄 Respuesta leverage raw:', resp);
        return resp;
      }
    });

    console.log('✅ Leverage - Status:', response.status);
    console.log('✅ Leverage - Data:', response.data);
    
    return JSON.parse(response.data);
  } catch (error) {
    console.warn('⚠️ Error leverage (continuando):', error.response?.data || error.message);
    return null; // No fallar por leverage
  }
}

// Función principal para colocar orden - FORMATO OFICIAL BINGX
async function placeOrder({ symbol, side, leverage = 5, usdtAmount = 5 }) {
  console.log('\n🚀 ===== INICIANDO ORDEN =====');
  console.log(`📊 Parámetros recibidos:`, { symbol, side, leverage, usdtAmount });
  
  if (!API_KEY || !API_SECRET) {
    throw new Error('BingX API keys no configuradas');
  }

  const normalizedSymbol = normalizeSymbol(symbol);
  console.log(`🎯 Procesando orden: ${side.toUpperCase()} ${normalizedSymbol}`);

  try {
    // 1. Establecer leverage (opcional)
    console.log('\n--- PASO 1: Establecer Leverage ---');
    await setLeverage(normalizedSymbol, leverage);

    // 2. Calcular quantity
    console.log('\n--- PASO 2: Calcular Quantity ---');
    const quantity = await calculateQuantity(normalizedSymbol, usdtAmount);

    // 3. Preparar payload EXACTO según código oficial BingX
    console.log('\n--- PASO 3: Preparar Payload Oficial ---');
    const timestamp = new Date().getTime();
    const orderSide = side.toUpperCase();
    
    // PAYLOAD EXACTO según ejemplo oficial de BingX
    const payload = {
      symbol: normalizedSymbol,
      side: orderSide,
      positionSide: orderSide === 'BUY' ? 'LONG' : 'SHORT',
      type: 'MARKET',
      quantity: quantity
    };

    console.log('📋 Payload oficial BingX:', payload);

    // 4. Construir parámetros usando función oficial
    console.log('\n--- PASO 4: Construir Parámetros Oficiales ---');
    const parameters = getParameters(payload, timestamp, false); // Para firma
    const parametersUrlEncoded = getParameters(payload, timestamp, true); // Para URL
    
    console.log('🔐 Parámetros para firma:', parameters);
    console.log('🔗 Parámetros URL encoded:', parametersUrlEncoded);
    
    // 5. Crear firma usando método oficial
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    console.log('🔐 Firma generada:', signature.substring(0, 16) + '...');

    // 6. Ejecutar orden con formato OFICIAL
    console.log('\n--- PASO 5: Ejecutar Orden Oficial ---');
    
    const url = `https://${HOST}/openApi/swap/v2/trade/order?${parametersUrlEncoded}&signature=${signature}`;
    console.log('🌐 URL orden completa:', url);

    const config = {
      method: 'POST',
      url: url,
      headers: {
        'X-BX-APIKEY': API_KEY
      },
      timeout: 10000,
      transformResponse: (resp) => {
        console.log('📄 Respuesta orden raw:', resp);
        return resp;
      }
    };

    console.log('⚙️ Config de request:', JSON.stringify(config, null, 2));

    const response = await axios(config);

    console.log('\n✅ ===== ORDEN EJECUTADA =====');
    console.log('📈 Status HTTP:', response.status);
    console.log('🎉 Respuesta BingX raw:', response.data);
    
    // Parsear respuesta JSON
    const responseData = JSON.parse(response.data);
    console.log('🎉 Respuesta BingX parseada:', JSON.stringify(responseData, null, 2));
    console.log('===========================\n');
    
    return responseData;

  } catch (error) {
    console.log('\n❌ ===== ERROR EN ORDEN =====');
    console.error('💥 Error en placeOrder:', error.message);
    
    if (error.response) {
      console.error('📊 Status HTTP:', error.response.status);
      console.error('📄 Headers:', error.response.headers);
      console.error('📄 Data raw:', error.response.data);
      
      try {
        const errorData = typeof error.response.data === 'string' ? 
          JSON.parse(error.response.data) : error.response.data;
        console.error('📄 Error parseado:', JSON.stringify(errorData, null, 2));
        
        return {
          success: false,
          error: errorData,
          code: error.response.status,
          message: errorData?.msg || 'Error desconocido'
        };
      } catch (parseError) {
        console.error('❌ Error parseando respuesta:', parseError.message);
        return {
          success: false,
          error: error.response.data,
          code: error.response.status,
          message: 'Error parseando respuesta'
        };
      }
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

  try {
    const timestamp = new Date().getTime();
    console.log('⏰ Timestamp generado:', timestamp);
    
    // Usar función oficial para construir parámetros
    const parameters = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    
    console.log('🔐 Obteniendo balance...');
    
    const url = `https://${HOST}/openApi/swap/v2/user/balance?${parameters}&signature=${signature}`;

    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'X-BX-APIKEY': API_KEY
      },
      transformResponse: (resp) => {
        return resp; // Mantener como string para manejar big ints
      }
    });

    console.log('✅ Balance obtenido - Status:', response.status);
    console.log('📄 Balance raw:', response.data);
    
    const balanceData = JSON.parse(response.data);
    console.log('📊 Balance parseado:', JSON.stringify(balanceData, null, 2));

    if (balanceData && balanceData.code === 0) {
      const data = balanceData.data;
      
      if (data && data.balance) {
        if (typeof data.balance === 'object' && data.balance.balance) {
          const balance = parseFloat(data.balance.balance);
          console.log(`💵 Balance final: ${balance} USDT`);
          return balance;
        }
      }
      
      if (Array.isArray(data)) {
        const usdt = data.find(item => item.asset === 'USDT');
        if (usdt) {
          const balance = parseFloat(usdt.balance || 0);
          console.log(`💵 Balance USDT: ${balance} USDT`);
          return balance;
        }
      }
    }

    throw new Error(`Formato de respuesta inesperado: ${JSON.stringify(balanceData)}`);
    
  } catch (error) {
    console.error('❌ Error obteniendo balance:', error.message);
    if (error.response) {
      console.error('📄 Data:', error.response.data);
    }
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
