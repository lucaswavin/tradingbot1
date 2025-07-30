// npm install axios crypto https -s
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.BINGX_API_KEY;
const API_SECRET = process.env.BINGX_API_SECRET;
const HOST = 'open-api.bingx.com';

// ⚡ OPTIMIZACIÓN: Pool de conexiones rápido\ nconst ultraFastAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 25,
  timeout: 2000,
  freeSocketTimeout: 4000
});

// ⚡ OPTIMIZACIÓN: Instancia axios
const fastAxios = axios.create({
  httpsAgent: ultraFastAgent,
  timeout: 5000,
  headers: {
    'Connection': 'keep-alive',
    'Content-Type': 'application/json'
  }
});

// 🔑 Log de configuración de claves
console.log('🔑 BingX API Keys configuradas:', {
  apiKey: API_KEY ? `${API_KEY.substring(0,8)}...` : 'NO CONFIGURADA',
  secret: API_SECRET ? `${API_SECRET.substring(0,8)}...` : 'NO CONFIGURADA'
});

// 🔄 Normalizar símbolos (e.g. BTCUSDT -> BTC-USDT)
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  console.log(`🔄 Normalizando símbolo: ${symbol}`);
  let base = symbol.replace(/\.P$/, '');
  if (base.endsWith('USDT') && !base.includes('-')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  console.log(`✅ Símbolo normalizado: ${symbol} → ${base}`);
  return base;
}

// 🔐 Construir parámetros oficiales ordenados y añadir timestamp
function getParametersOfficial(payload, timestamp, urlEncode = false) {
  const sortedKeys = Object.keys(payload).sort();
  let params = '';
  for (const key of sortedKeys) {
    const val = payload[key];
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

// 💰 Obtener precio actual de mercado
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

// ℹ️ Obtener detalles de contrato (mínimos, stepSize, minNotional)
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
          minNotional: parseFloat(contract.minNotional || '1')
        };
      }
    }
  } catch {
    console.warn('⚠️ Error en getContractInfo, usando valores por defecto');
  }
  return { minOrderQty: 0.001, tickSize: 0.01, stepSize: 0.001, minNotional: 1 };
}

// ⚙️ Establecer leverage
async function setLeverage(symbol, leverage = 5) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  const timestamp = Date.now();
  const payload = { symbol, side: 'LONG', leverage };
  const params = getParametersOfficial(payload, timestamp);
  const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
  const url = `https://${HOST}/openApi/swap/v2/trade/leverage?${params}&signature=${signature}`;
  console.log('🔧 Leverage URL:', url);
  const res = await fastAxios.post(url, null, { headers: { 'X-BX-APIKEY': API_KEY } });
  console.log('✅ Apalancamiento seteado:', res.data);
  return res.data;
}

// 🛒 Colocar orden interna (ahora con POST body)
async function placeOrderInternal({ symbol, side, leverage = 5, usdtAmount = 1 }) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');

  await setLeverage(symbol, leverage);

  const price = await getCurrentPrice(symbol);
  console.log(`💰 Precio de ${symbol}: ${price}`);
  const buyingPower = usdtAmount * leverage;
  let quantity = Math.round((buyingPower / price) * 1000) / 1000;
  quantity = Math.max(0.001, quantity);
  console.log(`🧮 Quantity: ${quantity}`);

  const timestamp = Date.now();
  const orderSide = side.toUpperCase();
  const payload = {
    symbol,
    side: orderSide,
    positionSide: orderSide === 'BUY' ? 'LONG' : 'SHORT',
    type: 'MARKET',
    quantity: quantity.toString(),
    workingType: 'CONTRACT_PRICE',
    priceProtect: 'false',
    timestamp
  };

  console.log('📋 Payload:', payload);

  const paramsForSig = getParametersOfficial(payload, timestamp);
  const signature = crypto.createHmac('sha256', API_SECRET).update(paramsForSig).digest('hex');
  const signedPayload = { ...payload, signature };

  const url = `https://${HOST}/openApi/swap/v2/trade/order`;
  console.log('🔧 Order URL:', url);
  const res = await fastAxios.post(url, signedPayload, { headers: { 'X-BX-APIKEY': API_KEY } });
  console.log('✅ Orden ejecutada:', res.data);
  return res.data;
}

// 🔄 Retry inteligente
async function placeOrderWithSmartRetry(params) {
  const symbol = normalizeSymbol(params.symbol);
  let result = await placeOrderInternal({ ...params, symbol });
  if (result?.code === 0) return result;
  const msg = result.msg || result.message || JSON.stringify(result);
  if (/minimum|min notional|insufficient/i.test(msg)) {
    console.warn('⚠️ Fallo por mínimo:', msg);
    const m = msg.match(/([\d.]+)/);
    let minNotional = m ? parseFloat(m[1]) * (await getCurrentPrice(symbol)) : null;
    if (!minNotional) {
      minNotional = (await getContractInfo(symbol)).minNotional;
    }
    const retryAmount = Math.ceil(minNotional * 1.1 * 100) / 100;
    console.log(`🔄 Reintentando con ${retryAmount} USDT`);
    result = await placeOrderInternal({ ...params, symbol, usdtAmount: retryAmount });
  }
  return result;
}

// 🏷️ Función pública
async function placeOrder(params) {
  return placeOrderWithSmartRetry(params);
}

// 💵 Obtener balance USDT
async function getUSDTBalance() {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  const timestamp = Date.now();
  const params = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', API_SECRET).update(params).digest('hex');
  const url = `https://${HOST}/openApi/swap/v2/user/balance?${params}&signature=${signature}`;
  const res = await fastAxios.get(url, { headers: { 'X-BX-APIKEY': API_KEY } });
  const data = typeof res.data==='string'?JSON.parse(res.data):res.data;
  if(data.code===0){
    const usdtItem=Array.isArray(data.data)?data.data.find(d=>d.asset==='USDT'):data.data.balance;
    return parseFloat(usdtItem.balance||usdtItem);
  }
  throw new Error(`Balance error: ${JSON.stringify(data)}`);
}

// 🛑 Cerrar todas posiciones
async function closeAllPositions(symbol) {
  if (!API_KEY || !API_SECRET) throw new Error('API key/secret no configurados');
  const timestamp=Date.now();
  const payload={symbol,side:'BOTH',type:'MARKET',timestamp};
  const params=getParametersOfficial(payload,timestamp);
  const signature=crypto.createHmac('sha256',API_SECRET).update(params).digest('hex');
  const url=`https://${HOST}/openApi/swap/v2/trade/closeAllPositions`;
  const res=await fastAxios.post(url,{...payload,signature},{headers:{'X-BX-APIKEY':API_KEY}});
  return res.data;
}

module.exports = {
  normalizeSymbol,
  getCurrentPrice,
  getContractInfo,
  setLeverage,
  placeOrder,
  getUSDTBalance,
  closeAllPositions
};


