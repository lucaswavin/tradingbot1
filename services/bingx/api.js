const crypto = require('crypto');
const https = require('https');

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

function makeHttpRequest(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
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
  const options = {
    method,
    headers: {
      'X-BX-APIKEY': BINGX_API_KEY,
      'Content-Type': 'application/json'
    }
  };
  return await makeHttpRequest(fullUrl, options);
}

async function getBalance() {
  try {
    const res = await bingXRequest('/openApi/swap/v2/user/balance');
    // Puedes guardar el balance global si quieres (opcional)
    if (!global.botState) global.botState = {};
    global.botState.balance = res?.data?.balance || 0;
    return res;
  } catch (error) {
    throw error;
  }
}

module.exports = {
  bingXRequest,
  getBalance
};

