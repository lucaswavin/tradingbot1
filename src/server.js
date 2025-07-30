const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const dashboardRoutes = require('../routes/dashboard');
const webhookRoutes = require('../routes/webhook');

const app = express();

// Optimizaciones para velocidad
app.disable('x-powered-by');
app.disable('etag');

// Estado global optimizado
if (!global.botState) {
  global.botState = { 
    signals: [],
    activePositions: new Map(),
    tradingEnabled: true,
    lastSignalId: null,
    lastProcessedTime: 0
  };
}

// Middleware optimizado para JSON
app.use(express.json({ 
  limit: '1mb',
  verify: (req, res, buf) => {
    if (buf.length === 0) return;
  }
}));

// Headers para optimizar conexiones
app.use((req, res, next) => {
  res.set({
    'Connection': 'keep-alive',
    'Keep-Alive': 'timeout=5, max=1000'
  });
  next();
});

// Rutas
app.use('/webhook', webhookRoutes);
app.use('/', dashboardRoutes);

// 404 optimizado
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Trading Bot OPTIMIZADO iniciado en puerto ${PORT}`);
  console.log(`⚡ Modo: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Métricas disponibles en: http://localhost:${PORT}/api/metrics`);
});

// Optimizaciones del servidor HTTP
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Manejo graceful de shutdown
process.on('SIGTERM', () => {
  console.log('🔄 Shutdown graceful iniciado...');
  server.close(() => {
    console.log('✅ Servidor cerrado correctamente');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('❌ Excepción no manejada:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rechazada:', reason);
});

module.exports = app;
