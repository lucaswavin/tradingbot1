// npm install axios crypto
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

// == CONFIGURACIÓN
const API_KEY = process.env.BINGX_API_KEY || 'AQUI_TU_API_KEY';
const API_SECRET = process.env.BINGX_API_SECRET || 'AQUI_TU_API_SECRET';
const HOST = 'open-api.bingx.com';

// == POOL CONEXIONES RÁPIDO
const ultraFastAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 25,
  timeout: 2000,
  freeSocketTimeout: 4000
});

const fastAxios = axios.create({
  httpsAgent: ultraFastAgent,
  timeout: 5000,
  headers: {
    'Connection': 'keep-alive',
    'Content-Type': 'application/json'
  }
});

// == NORMALIZADOR DE SÍMBOLOS
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  let base = symbol.replace(/\.P$/, '');
  if (base.endsWith('USDT') && !base.includes('-')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  return base;
}

// == GENERADOR DE PARAMS QUERY (NO DUPLICA TIMESTAMP, SIEMPRE ORDENADO)
function getParametersOfficial(payload, timestamp, urlEncode = false) {
  const payloadWithoutTimestamp = { ...payload };
  delete payloadWithoutTimestamp.timestamp;
  const sortedKeys = Object.keys(payloadWithoutTimestamp).sort();
  let params = '';
  for (const key of sortedKeys) {
    const val = payloadWithoutTimestamp[key];
    if (val !== undefined && val !== null) {
      params += urlEncode
        ? `${key}=${encodeURIComponent(val)}&`
        : `${key}=${val}&`;
    }
  }
  if (params) {
    params = params.slice(0, -1) + `&timestamp=${timestamp}`;
  } else {
    params = `timestamp=${timestamp}`;
  }
  return params;
}

// == OBTENER PRECIO ACTUAL
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

// == OBTENER INFO DEL CONTRATO (mínimos, step, etc)
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
    // no pasa nada
  }
  return { minOrderQty: 0.001, tickSize: 0.01, stepSize: 0.001, minNotional: 1 };
}

// == SETEAR LEVERAGE
async function setLeverage(symbol, leverage = 5) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  try {
    const timestamp = Date.now();
    const payload = { symbol, side: 'LONG', leverage };
    const params = getParametersOfficial(payload, timestamp, false);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${parametersUrlEncoded}&signature=${signature}`;
    const res = await fastAxios.post(url, null, { 
      headers: { 'X-BX-APIKEY': API_KEY }
    });
    return res.data;
  } catch (error) {
    return null;
  }
}

// == COLOCAR ORDEN INTERNA (CORRECTAMENTE CON PARAMS EN URL Y FIRMA)
async function placeOrderInternal({ symbol, side, leverage = 5, usdtAmount = 1 }) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  try {
    await setLeverage(symbol, leverage);
    const price = await getCurrentPrice(symbol);
    const buyingPower = usdtAmount * leverage;
    let quantity = buyingPower / price;
    quantity = Math.round(quantity * 1000) / 1000;
    quantity = Math.max(0.001, quantity);

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
    const params = getParametersOfficial(payload, timestamp, false);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/order?${parametersUrlEncoded}&signature=${signature}`;
    const res = await fastAxios.post(url, null, { 
      headers: { 'X-BX-APIKEY': API_KEY }
    });
    return res.data;
  } catch (error) {
    const data = error.response?.data;
    return {
      success: false,
      message: error.message,
      error: typeof data === 'string' ? JSON.parse(data) : data
    };
  }
}

// == RETRY INTELIGENTE: Si el mínimo falla, busca el mínimo real y reintenta
async function placeOrderWithSmartRetry(params) {
  const { symbol, side, leverage = 5 } = params;
  const normalizedSymbol = normalizeSymbol(symbol);
  try {
    const result = await placeOrderInternal({
      symbol: normalizedSymbol,
      side,
      leverage,
      usdtAmount: 1
    });
    if (result && result.code === 0) {
      return result;
    }
    const errorMsg = result?.msg || result?.message || JSON.stringify(result);
    const needsRetry = errorMsg.includes('minimum') || 
                       errorMsg.includes('less than') || 
                       errorMsg.includes('min ') ||
                       errorMsg.toLowerCase().includes('min notional') ||
                       errorMsg.includes('insufficient');
    if (needsRetry) {
      let minimumRequired = null;
      const match = errorMsg.match(/([\d.]+)\s+([A-Z]+)/);
      if (match) {
        const minQuantity = parseFloat(match[1]);
        const price = await getCurrentPrice(normalizedSymbol);
        minimumRequired = minQuantity * price;
      }
      if (!minimumRequired) {
        const contractInfo = await getContractInfo(normalizedSymbol);
        minimumRequired = contractInfo.minNotional || 10;
      }
      const finalAmount = Math.ceil(minimumRequired * 1.1 * 100) / 100;
      return await placeOrderInternal({
        symbol: normalizedSymbol,
        side,
        leverage,
        usdtAmount: finalAmount
      });
    }
    return result;
  } catch (error) {
    throw error;
  }
}

// == FUNCIÓN PÚBLICA
async function placeOrder(params) {
  return placeOrderWithSmartRetry(params);
}

// == OBTENER BALANCE USDT
async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  try {
    const timestamp = Date.now();
    const parameters = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', API_SECRET).update(parameters).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/user/balance?${parameters}&signature=${signature}`;
    const res = await fastAxios.get(url, { 
      headers: { 'X-BX-APIKEY': API_KEY }
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
    throw error;
  }
}

// == CERRAR TODAS LAS POSICIONES
async function closeAllPositions(symbol) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  try {
    const timestamp = Date.now();
    const normalizedSymbol = normalizeSymbol(symbol);
    const payload = {
      symbol: normalizedSymbol,
      side: 'BOTH',
      type: 'MARKET'
    };
    const params = getParametersOfficial(payload, timestamp, false);
    const parametersUrlEncoded = getParametersOfficial(payload, timestamp, true);
    const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
    const url = `https://${HOST}/openApi/swap/v2/trade/closeAllPositions?${parametersUrlEncoded}&signature=${signature}`;
    const res = await fastAxios.post(url, null, { 
      headers: { 'X-BX-APIKEY': API_KEY }
    });
    return res.data;
  } catch (error) {
    const data = error.response?.data;
    return {
      success: false,
      message: error.message,
      error: typeof data === 'string' ? JSON.parse(data) : data
    };
  }
}

// Alias
async function closePosition(symbol, side = 'BOTH') {
  return await closeAllPositions(symbol);
}

// == EXPORTABLES O MAIN DIRECTO ==
async function main() {
  // Ejemplo de abrir un short con 1 USDT y 5x leverage
  const resultado = await placeOrder({
    symbol: "ORDERUSDT.P", // acepta formato original
    side: "sell",
    leverage: 5
  });
  console.log("Resultado de la orden:", resultado);
}
main();

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

