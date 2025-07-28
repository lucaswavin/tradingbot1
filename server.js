const http = require('http');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || 'CAMBIAR_POR_TU_SECRET';

// === CONFIGURACIÓN BINGX ===
const BINGX_API_KEY = process.env.BINGX_API_KEY;
const BINGX_API_SECRET = process.env.BINGX_API_SECRET;
const BINGX_BASE_URL = 'https://open-api.bingx.com';

let botState = {
  isActive: true,
  signals: [],
  totalSignals: 0,
  bingxConnected: false,
  balance: 0
};

function parseBody(req, callback) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      callback(null, data);
    } catch (e) {
      callback(e, null);
    }
  });
}

// === FUNCIONES BINGX ===
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

async function makeHttpRequest(url, options) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? require('https') : require('http');
    
    const req = protocol.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          resolve(jsonData);
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
  const requestParams = {
    ...params,
    timestamp
  };

  const signature = createBingXSignature(requestParams);
  requestParams.signature = signature;

  const queryString = Object.keys(requestParams)
    .map(key => `${key}=${requestParams[key]}`)
    .join('&');

  const fullUrl = `${BINGX_BASE_URL}${endpoint}?${queryString}`;

  const options = {
    method: method,
    headers: {
      'X-BX-APIKEY': BINGX_API_KEY,
      'Content-Type': 'application/json'
    }
  };

  return await makeHttpRequest(fullUrl, options);
}

// === FUNCIONES DE TRADING ===
async function getBalance() {
  try {
    const response = await bingXRequest('/openApi/swap/v2/user/balance');
    console.log('✅ Balance obtenido:', response);
    botState.bingxConnected = true;
    return response;
  } catch (error) {
    console.error('❌ Error obteniendo balance:', error.message);
    botState.bingxConnected = false;
    throw error;
  }
}

async function executeOrder(signal) {
  try {
    console.log('🎯 Ejecutando orden:', signal);
    
    // Primero verificar balance
    const balance = await getBalance();
    console.log('💰 Balance verificado');

    // Configurar apalancamiento
    if (signal.leverage) {
      const leverageParams = {
        symbol: signal.symbol,
        side: 'BOTH',
        leverage: signal.leverage
      };
      
      const leverageResult = await bingXRequest('/openApi/swap/v2/trade/leverage', leverageParams, 'POST');
      console.log('⚡ Apalancamiento configurado:', leverageResult);
    }

    // Calcular cantidad de la orden
    const quantity = parseFloat(signal.capital) * (signal.leverage || 1) / signal.price;
    
    // Parámetros de la orden
    const orderParams = {
      symbol: signal.symbol,
      side: signal.direction === 'LONG' ? 'BUY' : 'SELL',
      type: 'MARKET',
      quantity: quantity.toFixed(6)
    };

    const orderResult = await bingXRequest('/openApi/swap/v2/trade/order', orderParams, 'POST');
    
    console.log('✅ Orden ejecutada:', orderResult);
    
    return {
      success: true,
      orderId: orderResult.orderId,
      symbol: signal.symbol,
      side: orderParams.side,
      quantity: orderParams.quantity,
      message: 'Orden ejecutada correctamente'
    };

  } catch (error) {
    console.error('❌ Error ejecutando orden:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// === SERVIDOR HTTP ===
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (path === '/' && req.method === 'GET') {
    const lastSignals = botState.signals.slice(-5).reverse();

    res.writeHead(200);
    res.end(`
      <!DOCTYPE html>
      <html><head><title>🤖 Trading Bot + BingX</title><meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: auto; padding: 20px; background: #f5f5f5; }
        .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin: 20px 0; }
        .status { padding: 15px; border-radius: 6px; margin: 10px 0; }
        .connected { background: #d4edda; color: #155724; }
        .disconnected { background: #f8d7da; color: #721c24; }
        .signal { background: #e3f2fd; padding: 10px; margin: 5px 0; border-radius: 4px; border-left: 4px solid #2196f3; }
        button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin: 5px; }
        .webhook-url { background: #e8f4f8; padding: 10px; border-radius: 4px; font-family: monospace; word-break: break-all; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat { text-align: center; background: #f8f9fa; padding: 15px; border-radius: 6px; }
      </style>
      </head>
      <body>
        <div class="container">
          <h1>🤖 Trading Bot + BingX</h1>
          
          <div class="status ${botState.bingxConnected ? 'connected' : 'disconnected'}">
            <h3>BingX: ${botState.bingxConnected ? '✅ Conectado' : '❌ Desconectado'}</h3>
            <p>Estado del bot: ${botState.isActive ? '🟢 Activo' : '🔴 Pausado'}</p>
          </div>

          <div class="stats">
            <div class="stat">
              <h3>📡 ${botState.totalSignals}</h3>
              <p>Señales Totales</p>
            </div>
            <div class="stat">
              <h3>📊 ${botState.signals.length}</h3>
              <p>En Historial</p>
            </div>
            <div class="stat">
              <h3>💰 $${botState.balance}</h3>
              <p>Balance</p>
            </div>
            <div class="stat">
              <h3>⏰ ${new Date().toLocaleTimeString()}</h3>
              <p>Hora Actual</p>
            </div>
          </div>

          <div>
            <h3>📡 Webhook URL:</h3>
            <div class="webhook-url">https://${req.headers.host}/webhook</div>
          </div>

          <div>
            <h3>🎛️ Controles:</h3>
            <form method="POST" action="/api/toggle" style="display: inline;">
              <button type="submit">${botState.isActive ? '⏸️ Pausar' : '▶️ Activar'} Bot</button>
            </form>
            <form method="POST" action="/api/test-bingx" style="display: inline;">
              <button type="submit">🧪 Test BingX</button>
            </form>
            <form method="POST" action="/api/clear" style="display: inline;">
              <button type="submit">🗑️ Limpiar</button>
            </form>
            <button onclick="location.reload()">🔄 Actualizar</button>
          </div>

          <div>
            <h3>📊 Últimas señales (${lastSignals.length}):</h3>
            ${lastSignals.length === 0 ? 
              '<p>No hay señales aún.</p>' :
              lastSignals.map(s => `
                <div class="signal">
                  <strong>[${s.action}]</strong> ${s.symbol} @ ${s.timestamp}
                  <br><small>Datos: ${JSON.stringify(s.data, null, 2)}</small>
                </div>
              `).join('')
            }
          </div>
        </div>
      </body></html>
    `);

  } else if (path === '/webhook' && req.method === 'POST') {
    parseBody(req, async (err, data) => {
      if (err) {
        console.error('❌ JSON inválido:', err);
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'JSON inválido' }));
        return;
      }

      console.log('📡 Webhook recibido:', data);

      if (!data.secret || data.secret !== SECRET) {
        console.warn('⚠️ Clave secreta inválida');
        res.writeHead(401);
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return;
      }

      if (!botState.isActive) {
        console.log('⏸️ Bot pausado. Señal ignorada.');
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: 'Bot pausado' }));
        return;
      }

      // Guardar señal
      const signal = {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        data,
        symbol: data.symbol,
        action: data.action
      };

      botState.signals.push(signal);
      botState.totalSignals++;
      if (botState.signals.length > 100) {
        botState.signals = botState.signals.slice(-100);
      }

      // EJECUTAR ORDEN REAL EN BINGX
      if (data.action === 'ENTRY') {
        try {
          const orderResult = await executeOrder(data);
          signal.orderResult = orderResult;
          
          console.log(`✅ Orden BingX: ${orderResult.success ? 'EXITOSA' : 'FALLIDA'}`);
          
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Señal procesada y orden ejecutada',
            bingxResult: orderResult
          }));
        } catch (error) {
          console.error('❌ Error en orden BingX:', error);
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Señal recibida pero error en BingX',
            error: error.message
          }));
        }
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Señal procesada' }));
      }
    });

  } else if (path === '/api/test-bingx' && req.method === 'POST') {
    try {
      const balance = await getBalance();
      console.log('🧪 Test BingX exitoso');
      res.writeHead(302, { Location: '/' });
      res.end();
    } catch (error) {
      console.error('🧪 Test BingX fallido:', error);
      res.writeHead(302, { Location: '/' });
      res.end();
    }

  } else if (path === '/api/toggle' && req.method === 'POST') {
    botState.isActive = !botState.isActive;
    console.log(`🎛️ Bot ${botState.isActive ? 'activado' : 'pausado'}`);
    res.writeHead(302, { Location: '/' });
    res.end();

  } else if (path === '/api/clear' && req.method === 'POST') {
    const cleared = botState.signals.length;
    botState.signals = [];
    botState.totalSignals = 0;
    console.log(`🗑️ Historial limpiado (${cleared} señales)`);
    res.writeHead(302, { Location: '/' });
    res.end();

  } else if (path === '/webhook' && req.method === 'GET') {
    res.writeHead(200);
    res.end(`
      <div style="font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h2>📡 Webhook BingX Activo</h2>
        <p>✅ Endpoint listo para recibir señales de TradingView</p>
        <p><strong>Estado:</strong> ${botState.isActive ? '🟢 Activo' : '🔴 Pausado'}</p>
        <p><strong>BingX:</strong> ${botState.bingxConnected ? '✅ Conectado' : '❌ Desconectado'}</p>
        <p><a href="/">← Volver al Panel</a></p>
      </div>
    `);

  } else {
    res.writeHead(404);
    res.end('<h1>404 - No encontrado</h1><p><a href="/">Volver al panel</a></p>');
  }
});

// === INICIALIZAR ===
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Trading Bot iniciado en puerto ${PORT}`);
  console.log(`📡 Webhook activo en /webhook`);
  
  // Test inicial de BingX
  try {
    await getBalance();
    console.log('✅ BingX conectado correctamente');
  } catch (error) {
    console.log('⚠️ BingX no conectado:', error.message);
  }
});
