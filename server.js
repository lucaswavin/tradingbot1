const http = require('http');
const url = require('url');
const fs = require('fs'); // opcional

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || 'cambia-esto';

// Estado interno del bot
let botState = {
  isActive: true,
  signals: [],
  totalSignals: 0
};

// === FUNCIONES ===
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

// === SERVIDOR ===
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;

  // CORS + headers básicos
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // === PANEL PRINCIPAL ===
  if (path === '/' && req.method === 'GET') {
    const lastSignals = botState.signals.slice(-10).reverse();

    res.writeHead(200);
    res.end(`
      <!DOCTYPE html>
      <html><head><title>🤖 Trading Bot</title><meta charset="UTF-8">
      <style>
        body { font-family: Arial; max-width: 800px; margin: auto; padding: 20px; background: #f5f5f5; }
        .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin: 20px 0; }
        .status { padding: 15px; border-radius: 6px; margin: 10px 0; }
        .active { background: #d4edda; color: #155724; }
        .inactive { background: #f8d7da; color: #721c24; }
        .signal { background: #e3f2fd; padding: 10px; margin: 5px 0; border-radius: 4px; border-left: 4px solid #2196f3; }
        button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin: 5px; }
        .webhook-url { background: #e8f4f8; padding: 10px; border-radius: 4px; font-family: monospace; word-break: break-word; }
      </style>
      </head><body>
        <div class="container">
          <h1>🤖 Trading Bot</h1>
          <div class="status ${botState.isActive ? 'active' : 'inactive'}">
            <p><strong>Estado:</strong> ${botState.isActive ? '🟢 Activo' : '🔴 Pausado'}</p>
            <p><strong>Total señales:</strong> ${botState.totalSignals}</p>
          </div>

          <div>
            <h3>📡 Webhook URL</h3>
            <div class="webhook-url">https://${req.headers.host}/webhook</div>
          </div>

          <div>
            <h3>🎛️ Controles</h3>
            <form method="POST" action="/api/toggle" style="display:inline;">
              <button type="submit">${botState.isActive ? '⏸️ Pausar' : '▶️ Activar'} Bot</button>
            </form>
            <form method="POST" action="/api/clear" style="display:inline;">
              <button type="submit">🗑️ Limpiar historial</button>
            </form>
            <button onclick="location.reload()">🔄 Actualizar</button>
          </div>

          <h3>📊 Últimas señales</h3>
          ${lastSignals.length === 0 ? '<p>🔕 Aún no hay señales recibidas.</p>' :
            lastSignals.map(s => `
              <div class="signal">
                <strong>[${s.action}]</strong> ${s.symbol} @ ${s.timestamp}
                <br><small>${JSON.stringify(s.data)}</small>
              </div>
            `).join('')
          }
        </div>
      </body></html>
    `);
    return;
  }

  // === ENDPOINT WEBHOOK ===
  if (path === '/webhook' && req.method === 'POST') {
    parseBody(req, (err, data) => {
      if (err) {
        console.error('❌ JSON inválido:', err);
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'JSON inválido' }));
        return;
      }

      // Validación de clave secreta
      if (data.secret !== SECRET) {
        console.warn('❌ Clave secreta incorrecta');
        res.writeHead(401);
        res.end(JSON.stringify({ success: false, error: 'Clave inválida' }));
        return;
      }

      // Validar campos básicos
      if (!data.action || !data.symbol) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Faltan campos obligatorios (action, symbol)' }));
        return;
      }

      if (!botState.isActive) {
        console.log('⏸️ Bot pausado. Señal ignorada.');
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: 'Bot pausado' }));
        return;
      }

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

      console.log(`✅ Señal recibida: ${signal.action} - ${signal.symbol}`);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, message: 'Señal recibida' }));
    });
    return;
  }

  // === WEBHOOK INFO PAGE ===
  if (path === '/webhook' && req.method === 'GET') {
    res.writeHead(200);
    res.end(`
      <div style="font-family: Arial; max-width: 600px; margin: 50px auto;">
        <h2>📡 Webhook activo</h2>
        <p>Listo para recibir señales POST de TradingView</p>
        <p><strong>Estado:</strong> ${botState.isActive ? '🟢 Activo' : '🔴 Pausado'}</p>
        <p><strong>Total señales:</strong> ${botState.totalSignals}</p>
        <p><a href="/">← Volver al panel</a></p>
      </div>
    `);
    return;
  }

  // === TOGGLE BOT ===
  if (path === '/api/toggle' && req.method === 'POST') {
    botState.isActive = !botState.isActive;
    console.log(`🎛️ Bot ${botState.isActive ? 'activado' : 'pausado'}`);
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // === CLEAR HISTORY ===
  if (path === '/api/clear' && req.method === 'POST') {
    const count = botState.signals.length;
    botState.signals = [];
    botState.totalSignals = 0;
    console.log(`🗑️ Historial limpiado (${count} señales)`);
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // === API STATUS ===
  if (path === '/api/status' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(botState));
    return;
  }

  // === 404 ===
  res.writeHead(404);
  res.end('<h1>404 - No encontrado</h1><p><a href="/">Volver al panel</a></p>');
});

// === INICIAR SERVIDOR ===
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bot iniciado en puerto ${PORT}`);
  console.log(`📡 Webhook: /webhook`);
  console.log(`🔑 Clave secreta cargada desde entorno`);
});
