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

// Firma los parámetros alfabéticamente para BingX (por body, no por URL)
function createSignature(payload) {
  const keys = Object.keys(payload).sort();
  const paramStr = keys.map(key => `${key}=${payload[key]}`).join('&');
  return crypto.createHmac('sha256', API_SECRET).update(paramStr).digest('hex');
}

// Calcula el tamaño de contrato para mover 1 USDT en el par
async function calcularEntrustVolume1USDT(symbol) {
  // 1. Obtiene el precio actual usando la API de BingX
  const priceData = await axios.get(`https://${HOST}/openApi/swap/v2/quote/price?symbol=${symbol}`);
  const price = parseFloat(priceData.data.data.price);

  // 2. Calcula el tamaño de contrato equivalente a 1 USDT
  let volume = 1 / price;

  // 3. Ajusta al tickSize mínimo (puedes consultar la API de contratos si necesitas ser exacto)
  // Aquí por defecto usamos 0.01, ajusta si lo necesitas
  const tickSize = 0.01;
  volume = Math.max(tickSize, Math.floor(volume / tickSize) * tickSize);

  return volume.toFixed(2);
}

// Crea una orden de mercado para mover 1 USDT en el par
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
    entrustType: 1, // market
    entrustVolume,
    timestamp: Date.now()
  };

  // Firma correcta (alfabético, todos los params, incluido timestamp)
  const signature = createSignature(payload);
  payload.signature = signature;

  const config = {
    method: 'POST',
    url: `https://${HOST}/openApi/swap/v2/trade/order`,
    headers: {
      'X-BX-APIKEY': API_KEY,
      'Content-Type': 'application/json'
    },
    data: payload
  };

  // Logs para debug
  console.log("🌐 FULL URL:", config.url);
  console.log("🔐 Body (payload):", JSON.stringify(payload));
  console.log("🟡 Headers:", config.headers);

  try {
    const resp = await axios(config);
    console.log('✅ BingX ORDER status:', resp.status);
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

// Consulta el balance de USDT
async function getUSDTBalance() {
  const payload = { timestamp: Date.now() };
  const signature = createSignature(payload);
  payload.signature = signature;

  const config = {
    method: 'GET',
    url: `https://${HOST}/openApi/swap/v2/user/balance`,
    headers: {
      'X-BX-APIKEY': API_KEY,
      'Content-Type': 'application/json'
    },
    params: payload
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



