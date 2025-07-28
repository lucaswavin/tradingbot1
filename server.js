const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('🎉 Servidor funcionando en Railway!');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor HTTP en puerto ${PORT}`);
});
