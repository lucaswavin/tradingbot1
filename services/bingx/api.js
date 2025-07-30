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

    // CÁLCULO CORRECTO: margin × leverage = poder de compra
    const price = await getCurrentPrice(symbol);
    console.log(`💰 Precio actual de ${symbol}: ${price} USDT`);
    console.log(`💳 Margin deseado: ${usdtAmount} USDT`);
    console.log(`⚡ Leverage: ${leverage}x`);
    
    // Poder de compra = margin × leverage
    const buyingPower = usdtAmount * leverage;
    console.log(`🚀 Poder de compra: ${usdtAmount} USDT × ${leverage}x = ${buyingPower} USDT`);
    
    // Quantity basada en el poder de compra
    let quantity = buyingPower / price;
    quantity = Math.round(quantity * 1000) / 1000; // 3 decimales
    quantity = Math.max(0.001, quantity); // Mínimo técnico
    
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

    const parameters = getParameters(payload, timestamp, false);
    const parametersUrlEncoded = getParameters(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/order?${parametersUrlEncoded}&signature=${signature}`;

    const response = await axios.post(url, null, {
      headers: { 'X-BX-APIKEY': API_KEY },
      timeout: 10000,
      transformResponse: (resp) => resp
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
      const finalAmount = Math.ceil(minimumRequired * 1.1 * 100) / 100; // Redondear hacia arriba
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
