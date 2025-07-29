const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = "open-api.bingx.com";

// Normaliza el symbol de TradingView a BingX
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  let base = symbol.replace('.P', '');
  if (base.endsWith('USDT')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  return base;
}

// Calcula el tamaño de contrato para mover 1 USDT en el par
async function calcularEntrustVolume1USDT(symbol) {
  const priceData = await axios.get(`https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`);
  const price = parseFloat(priceData.data.data.price);

  // Por defecto, el mínimo en BingX suele ser 0.01, pero puede cambiar según el par
  let volume = 1 / price;
  const tickSize = 0.01;
  volume = Math.max(tickSize, Math.floor(volume / tickSize) * tickSize);

  return volume.toFixed(2); // Ajusta los decimales según el par si hace falta
}

async function placeOrder({ symbol, side, leverage = 5, positionMode = 'ISOLATED' }) {
  symbol = normalizeSymbol(symbol);

  // Calcula el tamaño de contrato para 1 USDT
  const entrustVolume = await calcularEntrustVolume1USDT(symbol);

  const payload = {
    symbol,
    side: side.toUpperCase(),
    positionSide: side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
    marginMode: positionMode.toUpperCase(),
    leverage: leverage.toString(),
    entrustType: 1, // 1 = market
    entrustVolume
  };

  const timestamp = Date.now();
  let paramStr = "";
  for (const key in payload) {
    paramStr += key + "=" + payload[key] + "&";
  }
  paramStr += "timestamp=" + timestamp;
  const signature = crypto.createHmac('sha256', API_SECRET).update(paramStr).digest('hex');
  let paramStrUrl = "";
  for (const key in payload) {
    paramStrUrl += key + "=" + encodeURIComponent(payload[key]) + "&";
  }
  paramStrUrl += "timestamp=" + timestamp;
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

module.exports = {
  placeOrder,
  normalizeSymbol
};



