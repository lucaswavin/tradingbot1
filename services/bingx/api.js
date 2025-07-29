const axios = require('axios');
const crypto = require('crypto');

const BINGX_API_KEY = process.env.BINGX_API_KEY;
const BINGX_API_SECRET = process.env.BINGX_API_SECRET;
const BINGX_BASE_URL = 'https://open-api.bingx.com';

function createBingXSignature(params) {
  const query = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  console.log('🔐 Query a firmar:', query);
  return crypto
    .createHmac('sha256', BINGX_API_SECRET)
    .update(query)
    .digest('hex');
}

async function bingXRequest(endpoint, params = {}, method = 'GET') {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) {
    throw new Error('BingX API keys no configuradas');
  }
  // Debug: Valor real de la API KEY
  console.log('🟢 API KEY:', BINGX_API_KEY.length > 0 ? '[OK]' : '[VACÍA]');

  const timestamp = Date.now();
  const requestParams = { ...params, timestamp };
  const signature = createBingXSignature(requestParams);
  requestParams.signature = signature;
  const queryString = Object.keys(requestParams)
    .map(key => `${key}=${requestParams[key]}`)
    .join('&');
  const fullUrl = `${BINGX_BASE_URL}${endpoint}?${queryString}`;

  // Debug: Headers enviados
  const headers = {
    'X-BX-APIKEY': BINGX_API_KEY,
    'Content-Type': 'application/json'
  };
  console.log('🟡 Headers:', headers);
  console.log('🌐 FULL URL:', fullUrl);

  try {
    const response = await axios({
      url: fullUrl,
      method,
      headers: headers
    });
    // Debug: Headers de respuesta de BingX
    console.log('🔴 Response Headers:', response.headers);
    return response.data;
  } catch (error) {
    if (error.response) {
      console.error('--- BingX API ERROR EN bingXRequest ---');
      console.error(JSON.stringify(error.response.data));
      console.error('--- FIN ERROR ---');
      return error.response.data; // para debug
    } else {
      console.error('--- BingX API ERROR: NO RESPONSE ---');
      console.error(error);
      console.error('--- FIN ERROR ---');
      throw error;
    }
  }
}

async function placeOrder({ symbol, side, quantity, leverage = 5, positionMode = 'ISOLATED' }) {
  // Intenta probar con y sin .P en el symbol, según docs de BingX
  if (symbol.endsWith('.P')) symbol = symbol.replace('.P', '');

  const params = {
    symbol,
    side: side.toUpperCase(),
    positionSide: side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
    marginMode: positionMode.toUpperCase(),
    leverage: leverage.toString(),
    entrustType: 1,
    entrustVolume: quantity.toString()
    // source: "API" // Quita este campo si sigue fallando
  };
  console.log('📦 Params de placeOrder:', params);
  return await bingXRequest('/openApi/swap/v2/trade/order', params, 'POST');
}

async function getUSDTBalance() {
  const res = await bingXRequest('/openApi/swap/v2/user/balance');
  console.log('===== RESPUESTA REAL BINGX BALANCE =====');
  console.log(JSON.stringify(res));
  console.log('========================================');
  if (res && res.code === 0 && res.data) {
    if (res.data.balance && typeof res.data.balance === 'object') {
      return Number(res.data.balance.balance);
    }
    if (Array.isArray(res.data)) {
      const usdt = res.data.find(item => item.asset === 'USDT');
      if (usdt) return Number(usdt.balance);
      else return 0;
    }
  }
  throw new Error('No se pudo obtener el balance.');
}

module.exports = {
  bingXRequest,
  getUSDTBalance,
  placeOrder
};

