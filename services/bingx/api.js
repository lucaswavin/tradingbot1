// services/bingx/api.js
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
  return crypto
    .createHmac('sha256', BINGX_API_SECRET)
    .update(query)
    .digest('hex');
}

async function bingXRequest(endpoint, params = {}, method = 'GET') {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) {
    throw new Error('BingX API keys no configuradas');
  }
  const timestamp = Date.now();
  const requestParams = { ...params, timestamp };
  const signature = createBingXSignature(requestParams);
  requestParams.signature = signature;
  const queryString = Object.keys(requestParams)
    .map(key => `${key}=${requestParams[key]}`)
    .join('&');
  const fullUrl = `${BINGX_BASE_URL}${endpoint}?${queryString}`;
  try {
    const response = await axios({
      url: fullUrl,
      method,
      headers: {
        'X-BX-APIKEY': BINGX_API_KEY,
        'Content-Type': 'application/json'
      }
    });
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

async function getUSDTBalance() {
  const res = await bingXRequest('/openApi/swap/v2/user/balance');
  console.log('===== RESPUESTA REAL BINGX BALANCE =====');
  console.log(JSON.stringify(res));
  console.log('========================================');

  if (res && res.code === 0 && res.data) {
    // Caso 1: formato objeto
    if (res.data.balance && typeof res.data.balance === 'object') {
      // El balance USDT está aquí
      return Number(res.data.balance.balance);
    }
    // Caso 2: formato array
    if (Array.isArray(res.data)) {
      const usdt = res.data.find(item => item.asset === 'USDT');
      if (usdt) return Number(usdt.balance);
      else return 0;
    }
  }
  // Si llega aquí, el formato no es soportado o es error
  throw new Error('No se pudo obtener el balance.');
}

module.exports = {
  bingXRequest,
  getUSDTBalance
};

