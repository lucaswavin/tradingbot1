const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 
    'Content-Type': 'text/html; charset=utf-8' 
  });
  
  if (req.url === '/') {
    res.end(`
      <h1>🤖 Trading Bot - Básico</h1>
      <p>✅ Servidor funcionando correctamente</p>
      <p>📡 Webhook URL: ${req.headers.host}/webhook</p>
      <p>⏰ ${new Date().toLocaleString()}</p>
    `);
  } else if (req.url === '/webhook') {
    res.end(`
      <h2>📡 Webhook Endpoint</h2>
      <p>✅ Este endpoint está listo para recibir señales de TradingView</p>
    `);
  } else {
    res.writeHead(404);
    res.end('<h1>404 - Página no encontrada</h1>');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
  console.log(`📡 Webhook disponible en /webhook`);
});
