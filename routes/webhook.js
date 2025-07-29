const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

console.log('🛣️ Configurando rutas de webhook...');

// Ruta para señales que solo se muestran en dashboard (webhook original)
// URL: POST /webhook
router.post('/', webhookController.handleWebhook);
console.log('✅ Ruta configurada: POST /webhook (solo dashboard)');

// Ruta para trading automático con BingX
// URL: POST /webhook/trade
router.post('/trade', webhookController.handleTradingViewWebhook);
console.log('✅ Ruta configurada: POST /webhook/trade (trading automático)');

// Ruta para probar la conexión con BingX
// URL: GET /webhook/test
router.get('/test', webhookController.testConnection);
console.log('✅ Ruta configurada: GET /webhook/test (test conexión)');

// Ruta para ver el estado y estadísticas del bot
// URL: GET /webhook/status
router.get('/status', webhookController.getStatus);
console.log('✅ Ruta configurada: GET /webhook/status (estadísticas)');

// Ruta de información sobre las rutas disponibles
// URL: GET /webhook/info
router.get('/info', (req, res) => {
  console.log('ℹ️ Solicitada información de rutas');
  
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  res.json({
    ok: true,
    message: 'Trading Bot - Rutas disponibles',
    routes: {
      dashboard: {
        url: `${baseUrl}/`,
        method: 'GET',
        description: 'Ver dashboard con señales y balance'
      },
      webhookDashboard: {
        url: `${baseUrl}/webhook`,
        method: 'POST',
        description: 'Recibir señales solo para mostrar en dashboard',
        example: {
          symbol: 'BTCUSDT.P',
          side: 'buy',
          timestamp: '2025-07-30T10:00:00Z'
        }
      },
      webhookTrading: {
        url: `${baseUrl}/webhook/trade`,
        method: 'POST',
        description: 'Recibir señales y ejecutar trading automático en BingX',
        example: {
          symbol: 'BTCUSDT.P',
          side: 'buy',
          webhook_secret: 'tu_secret_aqui'
        }
      },
      testConnection: {
        url: `${baseUrl}/webhook/test`,
        method: 'GET',
        description: 'Probar conexión con BingX API'
      },
      botStatus: {
        url: `${baseUrl}/webhook/status`,
        method: 'GET',
        description: 'Ver estadísticas y estado del bot'
      },
      info: {
        url: `${baseUrl}/webhook/info`,
        method: 'GET',
        description: 'Ver esta información de rutas'
      }
    },
    configuration: {
      tradingViewUrl: `${baseUrl}/webhook/trade`,
      apiConfigured: !!(process.env.BINGX_API_KEY && process.env.BINGX_API_SECRET),
      webhookSecretRequired: !!process.env.WEBHOOK_SECRET
    },
    timestamp: new Date().toISOString()
  });
});
console.log('✅ Ruta configurada: GET /webhook/info (información)');

// Middleware para manejar rutas no encontradas en webhook
router.use('*', (req, res) => {
  console.log(`❌ Ruta no encontrada: ${req.method} ${req.originalUrl}`);
  console.log('🔍 IP:', req.ip || req.connection.remoteAddress);
  console.log('🔍 User-Agent:', req.get('User-Agent'));
  
  res.status(404).json({
    ok: false,
    error: 'Ruta no encontrada',
    method: req.method,
    url: req.originalUrl,
    availableRoutes: [
      'POST /webhook',
      'POST /webhook/trade', 
      'GET /webhook/test',
      'GET /webhook/status',
      'GET /webhook/info'
    ],
    message: 'Visita GET /webhook/info para ver todas las rutas disponibles'
  });
});

console.log('🎯 Todas las rutas de webhook configuradas correctamente\n');

module.exports = router;
