const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = "open-api.bingx.com";

console.log('🔑 BingX API Keys configuradas:', {
  apiKey: API_KEY ? `${API_KEY.substring(0, 8)}...` : 'NO CONFIGURADA',
  secret: API_SECRET ? `${API_SECRET.substring(0, 8)}...` : 'NO CONFIGURADA'
});

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

function getParameters(payload, timestamp, urlEncode = false) {
  let parameters = "";
  for (const key in payload) {
    if (payload[key] !== undefined && payload[key] !== null) {
      parameters += urlEncode
        ? `${key}=${encodeURIComponent(payload[key])}&`
        : `${key}=${payload[key]}&`;
    }
  }
  parameters += `timestamp=${timestamp}`;
  return parameters;
}

async function getCurrentPrice(symbol) {
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`;
    const response = await axios.get(url, { timeout: 5000 });
    if (response.data?.code === 0) {
      return parseFloat(response.data.data.price);
    }
    throw new Error(`Respuesta inválida: ${JSON.stringify(response.data)}`);
  } catch (error) {
    console.error('❌ Error obteniendo precio:', error.message);
    throw error;
  }
}

async function getContractInfo(symbol) {
  try {
    const url = `https://${HOST}/openApi/swap/v2/quote/contracts`;
    const response = await axios.get(url, { timeout: 5000 });
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

async function setLeverage(symbol, leverage = 5) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    const timestamp = Date.now();
    const payload = {
      symbol,
      side: "LONG",
      leverage
    };
    const parameters = getParameters(payload, timestamp, false);
    const parametersUrlEncoded = getParameters(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${parametersUrlEncoded}&signature=${signature}`;
    const response = await axios.post(url, null, {
      headers: { 'X-BX-APIKEY': API_KEY },
      timeout: 8000,
      transformResponse: (resp) => resp // Mantener como string
    });
    return JSON.parse(response.data);
  } catch (error) {
    console.warn('⚠️ Error al establecer leverage:', error.message);
    return null;
  }
}

async function placeOrderInternal({ symbol, side, leverage = 5, usdtAmount = 1 }) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    await setLeverage(symbol, leverage);

    const timestamp = Date.now();
    const orderSide = side.toUpperCase();
    const payload = {
      symbol,
      side: orderSide,
      positionSide: orderSide === 'BUY' ? 'LONG' : 'SHORT',
      type: 'MARKET',
      quoteOrderQty: usdtAmount.toString(),
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'false'
    };

    const parameters = getParameters(payload, timestamp, false);
    const parametersUrlEncoded = getParameters(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/order?${parametersUrlEncoded}&signature=${signature}`;

    const response = await axios.post(url, null, {
      headers: { 'X-BX-APIKEY': API_KEY },
      timeout: 10000,
      transformResponse: (resp) => resp // Mantener como string
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

async function placeOrderWithSmartRetry(params) {
  const { symbol, side, leverage = 5 } = params;
  const normalizedSymbol = normalizeSymbol(symbol);

  console.log(`🚀 Intentando orden con 1 USDT para ${normalizedSymbol}...`);

  try {
    // Primer intento con 1 USDT
    return await placeOrderInternal({
      symbol: normalizedSymbol,
      side,
      leverage,
      usdtAmount: 1
    });
  } catch (error) {
    const errorMsg = error?.message || JSON.stringify(error);
    const needsRetry = errorMsg.includes('less than') || errorMsg.toLowerCase().includes('min notional');

    if (!needsRetry) throw error;

    // Segundo intento: obtener mínimo real
    console.warn(`⚠️ Orden con 1 USDT falló, reintentando con mínimo real de BingX...`);
    const contractInfo = await getContractInfo(normalizedSymbol);
    const minNotional = contractInfo.minNotional || 10;

    console.log(`🔄 Reintentando con ${minNotional} USDT`);
    return await placeOrderInternal({
      symbol: normalizedSymbol,
      side,
      leverage,
      usdtAmount: minNotional
    });
  }
}

async function placeOrder(params) {
  return await placeOrderWithSmartRetry(params);
}

// 💵 Balance function CORREGIDA
async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    const timestamp = Date.now();
    const parameters = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/user/balance?${parameters}&signature=${signature}`;
    
    const response = await axios.get(url, {
      headers: { 'X-BX-APIKEY': API_KEY },
      timeout: 8000,
      transformResponse: (resp) => resp // ← CLAVE: Mantener como string
    });

    console.log('🔍 Balance response type:', typeof response.data);
    console.log('🔍 Balance response:', response.data);

    // Parsear solo si es string
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    
    if (data.code === 0) {
      // Manejar diferentes formatos de respuesta
      if (data.data && data.data.balance) {
        // Formato: { data: { balance: { balance: "123.45" } } }
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
    console.error('🔍 Error details:', error);
    throw error;
  }
}

async function closePosition(symbol, side = 'BOTH') {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  try {
    const timestamp = Date.now();
    const normalizedSymbol = normalizeSymbol(symbol);
    const payload = {
      symbol: normalizedSymbol,
      side: side,
      type: 'MARKET'
    };
    const parameters = getParameters(payload, timestamp, false);
    const parametersUrlEncoded = getParameters(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/closeAllPositions?${parametersUrlEncoded}&signature=${signature}`;

    const response = await axios.post(url, null, {
      headers: { 'X-BX-APIKEY': API_KEY },
      timeout: 10000,
      transformResponse: (resp) => resp // Mantener como string
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
