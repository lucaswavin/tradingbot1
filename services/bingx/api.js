const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = "open-api.bingx.com";

// Convierte "TROLLSOLUSDT.P" -> "TROLLSOL-USDT"
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  let base = symbol.replace('.P', '');
  if (base.endsWith('USDT')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  return base;
}

// Construye los parámetros para la firma y la url
function getParameters(payload, timestamp, urlEncode = false) {
  let parameters = "";
  const keys = Object.keys(payload).filter(k => payload[k] !== undefined && payload[k] !== '');
  for (const key of keys) {
    if (urlEncode) {
      parameters += key + "=" + encodeURIComponent(payload[key]) + "&";
    } else {
      parameters += key + "=" + payload[key] + "&";
    }
  }
  parameters += "timestamp=" + timestamp;
  return parameters;
}

async function placeOrder({ symbol, side, quantity, leverage = 5, positionMode = 'ISOLATED' }) {
  symbol = normalizeSymbol(symbol);

  const payload = {
    symbol,
    side: side.toUpperCase(),
    positionSide: side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
    marginMode: positionMode.toUpperCase(),
    leverage: leverage.toString(),
    entrustType: 1,
    entrustVolume: quantity.toString()
  };

  const timestamp = Date.now();
  const paramStr = getParameters(payload, timestamp, false); // para la firma
  const signature = crypto.createHmac('sha256', API_SECRET).update(paramStr).digest('hex');
  const paramStrUrl = getParameters(payload, timestamp, true); // para la url
  const url = `https://${HOST}/openApi/swap/v2/trade/order?${paramStrUrl}&signature=${signature}`;

  const config = {
    method: 'POST',
    url: url,
    headers: {
      'X-BX-APIKEY': API_KEY,
      'Content-Type': 'application/json'
    }
  };

  // Logs para debug
  console.log("🌐 FULL URL:", url);
  console.log("🔐 Query a firmar:", paramStr);
  console.log("🟡 Headers:", config.headers);

  try {
    const resp = await axios(config);
    console.log(resp.status);
    console.log(resp.data);
    return resp.data;
  } catch (error) {
    if (error.response) {
      console.error('--- BingX API ERROR EN placeOrder ---');
      console.error(JSON.stringify(error.response.data));
      console.error('--- FIN ERROR ---');
      return error.response.data;
    } else {
      console.error('--- BingX API ERROR: NO RESPONSE ---');
      console.error(error);
      console.error('--- FIN ERROR ---');
      throw error;
    }
  }
}

async function getUSDTBalance() {
  const timestamp = Date.now();
  const paramStr = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', API_SECRET).update(paramStr).digest('hex');
  const url = `https://${HOST}/openApi/swap/v2/user/balance?timestamp=${timestamp}&signature=${signature}`;

  const config = {
    method: 'GET',
    url: url,
    headers: {
      'X-BX-APIKEY': API_KEY,
      'Content-Type': 'application/json'
    }
  };

  try {
    const resp = await axios(config);
    console.log('===== RESPUESTA REAL BINGX BALANCE =====');
    console.log(JSON.stringify(resp.data));
    console.log('========================================');
    if (resp.data && resp.data.code === 0 && resp.data.data) {
      if (resp.data.data.balance && typeof resp.data.data.balance === 'object') {
        return Number(resp.data.data.balance.balance);
      }
      if (Array.isArray(resp.data.data)) {
        const usdt = resp.data.data.find(item => item.asset === 'USDT');
        if (usdt) return Number(usdt.balance);
        else return 0;
      }
    }
    throw new Error('No se pudo obtener el balance.');
  } catch (error) {
    console.error('--- BingX API ERROR EN getUSDTBalance ---');
    if (error.response) {
      console.error(JSON.stringify(error.response.data));
    } else {
      console.error(error);
    }
    console.error('--- FIN ERROR ---');
    throw error;
  }
}

module.exports = {
  getUSDTBalance,
  placeOrder,
  normalizeSymbol
};


