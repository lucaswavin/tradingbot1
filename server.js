const http = require('http');
const url = require('url');
const fs = require('fs'); // Opcional para persistencia

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || 'Lucas?1234';

let botState = {
  isActive: true,
  signals: [],
  totalSignals: 0
};

// Cargar historial si lo deseas (opcional)
// try {
//   const saved = fs.readFileSync('signals.json', 'utf8');
//   botState = JSON.parse(saved);
//   console.log('📁 Historial cargado.');
// } catch (e) {
//   console.log('📁 Sin historial previo.');
// }

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

function saveSignals() {
  // fs.writeFileSync('signals.json', JSON.stringify(botState, null, 2));
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;

  // CORS y Headers
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*'); // Editar si quieres restringir
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (path === '/' && req.method === 'GET') {
    const lastSignals = botState.signals.slice(-10).reverse();

    res.writeHead(200);
    res.end(`
      <!DOCTYPE html>
      <html><head><title>🤖 Trading Bot Activo</title><meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: auto; padding: 20px; background: #f5f5f5; }
        .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin: 20px 0; }
        .status { padding: 15px; border-radius: 6px; margin: 10px 0; }
        .active { background: #d4edda; color: #155724; }
        .inactive { background: #f8d7da; color: #721c24; }
        .signal { background: #e3f2fd; padding: 10px; margin: 5px 0; border-radius: 4px; border-left: 4px solid #2196f3; }
        button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin: 5px; }
        .webhook-url { background: #e8f4f8; padding: 10px; border-radius: 4px; font-family: monospace; word-break: break-all; }
      </style>
      </head>
      <body>
        <div class="container">
          <h1>🤖 Trading Bot Activo</h1>
          <div class="status ${botState.isActive ? 'active' : 'inactive'}">
            <p><strong>Estado:</strong> ${botState.isActive ? '🟢 Activo' : '🔴 Pausado'}</p>
            <p><strong>Total señales:</strong> ${botState.totalSignals}</p>
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
            <form method="POST" action="/api/clear" style="display: inline;">
              <button type="submit">🗑️ Limpiar historial</button>
            </form>
            <button onclick="location.reload()">🔄 Actualizar</button>
          </div>

          <div>
            <h3>📊 Últimas señales (${lastSignals.length}):</h3>
            ${lastSignals.length === 0 ? 
              '<p>No hay señales aún. Configura TradingView para empezar.</p>' :
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
    parseBody(req, (err, data) => {
      if (err) {
        console.error('❌ JSON inválido:', err);
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'JSON inválido' }));
        return;
      }

      console.log('📡 Petición recibida:', data);

      // Validación de seguridad
      if (!data.secret || data.secret !== SECRET) {
        console.warn('⚠️ Clave secreta inválida. Recibida:', data.secret, 'Esperada:', SECRET);
        res.writeHead(401);
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return;
      }

      // Validación de campos obligatorios
      if (!data.action || !data.symbol) {
        console.warn('⚠️ Faltan campos requeridos');
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Campos requeridos: action, symbol' }));
        return;
      }

      if (!botState.isActive) {
        console.log('⏸️ Bot pausado. Señal ignorada.');
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: 'Bot pausado. Señal ignorada.' }));
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

      // saveSignals(); // opcional

      console.log(`✅ Señal procesada: ${signal.action} - ${signal.symbol}`);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, message: 'Señal procesada', id: signal.id }));
    });

  } else if (path === '/webhook' && req.method === 'GET') {
    // Info del webhook
    res.writeHead(200);
    res.end(`
      <div style="font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h2>📡 Webhook Endpoint Activo</h2>
        <p>✅ Este endpoint está listo para recibir señales POST de TradingView</p>
        <p><strong>Estado:</strong> ${botState.isActive ? '🟢 Activo' : '🔴 Pausado'}</p>
        <p><strong>Total señales:</strong> ${botState.totalSignals}</p>
        <p><strong>Secret esperado:</strong> ${SECRET}</p>
        <p><a href="/">← Volver al Panel</a></p>
      </div>
    `);

  } else if (path === '/api/toggle' && req.method === 'POST') {
    botState.isActive = !botState.isActive;
    console.log(`🎛️ Bot ${botState.isActive ? 'activado' : 'pausado'}`);
    res.writeHead(302, { Location: '/' });
    res.end();

  } else if (path === '/api/clear' && req.method === 'POST') {
    const cleared = botState.signals.length;
    botState.signals = [];
    botState.totalSignals = 0;
    // saveSignals(); // opcional
    console.log(`🗑️ Historial limpiado (${cleared} señales)`);
    res.writeHead(302, { Location: '/' });
    res.end();

  } else if (path === '/api/status' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(botState));

  } else {
    res.writeHead(404);
    res.end('<h1>404 - No encontrado</h1><p><a href="/">Volver al panel</a></p>');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bot listo en puerto ${PORT}`);
  console.log(`📡 Webhook activo en /webhook`);
  console.log(`🔑 Secret configurado: ${SECRET}`);
});
