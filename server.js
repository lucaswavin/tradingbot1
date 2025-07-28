const http = require('http');
const url = require('url');
const fs = require('fs'); // Opcional para persistencia

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || 'mi_clave_secreta';

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
      <html><head><title>Bot Activo</title><meta charset="UTF-8"></head>
      <body style="font-family: sans-serif; max-width: 800px; margin: auto;">
        <h1>🤖 Trading Bot Activo</h1>
        <p>Estado: ${botState.isActive ? '🟢 Activo' : '🔴 Pausado'}</p>
        <p>Total señales: ${botState.totalSignals}</p>
        <p>Webhook: <code>https://${req.headers.host}/webhook</code></p>
        <h2>Últimas señales:</h2>
        <ul>
          ${lastSignals.map(s => `<li>[${s.action}] ${s.symbol} @ ${s.timestamp}</li>`).join('')}
        </ul>
        <form method="POST" action="/api/toggle">
          <button type="submit">${botState.isActive ? '⏸️ Pausar' : '▶️ Activar'} Bot</button>
        </form>
        <form method="POST" action="/api/clear">
          <button type="submit">🗑️ Limpiar historial</button>
        </form>
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

      // Validación de seguridad
      if (!data.secret || data.secret !== SECRET) {
        console.warn('⚠️ Clave secreta inválida o ausente');
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
});
