const axios = require('axios');
const crypto = require('crypto');

const BINGX_API_KEY = process.env.BINGX_API_KEY;
const BINGX_API_SECRET = process.env.BINGX_API_SECRET;
const BINGX_BASE_URL = 'https://open-api.bingx.com';

// DEBUG: Agrega estos logs temporalmente
console.log('🔍 DEBUG - Variables de entorno:');
console.log('BINGX_API_KEY existe:', !!BINGX_API_KEY);
console.log('BINGX_API_SECRET existe:', !!BINGX_API_SECRET);
console.log('BINGX_API_KEY length:', BINGX_API_KEY ? BINGX_API_KEY.length : 0);

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
    console.log('❌ Error: BingX API keys no configuradas');
    console.log('API_KEY:', BINGX_API_KEY ? 'EXISTS' : 'MISSING');
    console.log('API_SECRET:', BINGX_API_SECRET ? 'EXISTS' : 'MISSING');
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
  
  console.log('🚀 Haciendo petición a BingX:', endpoint);
  
  try {
    const response = await axios({
      url: fullUrl,
      method,
      headers: {
        'X-BX-APIKEY': BINGX_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    console.log('✅ Respuesta exitosa de BingX');
    return response.data;
  } catch (error) {
    console.log('❌ Error en petición BingX:', error.message);
    if (error.response) {
      console.log('Response data:', error.response.data);
      console.log('Response status:', error.response.status);
      throw new Error(JSON.stringify(error.response.data));
    } else {
      throw error;
    }
  }
}

async function getUSDTBalance() {
  console.log('💰 Obteniendo balance USDT...');
  const res = await bingXRequest('/openApi/swap/v2/user/balance');
  if (res && Array.isArray(res.data)) {
    const usdt = res.data.find(item => item.asset === 'USDT');
    if (usdt) {
      console.log('✅ Balance USDT encontrado:', usdt.balance);
      return Number(usdt.balance);
    } else {
      console.log('⚠️ No se encontró USDT en el balance');
      return 0;
    }
  } else {
    console.log('❌ Respuesta inesperada:', res);
    throw new Error('No se pudo obtener el balance.');
  }
}

module.exports = {
  bingXRequest,
  getUSDTBalance
};

