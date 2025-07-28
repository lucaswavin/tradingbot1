// === TRADING BOT BÁSICO CON TRADINGVIEW Y RAILWAY ===
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Configuración
const CONFIG = {
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || 'tu_clave_secreta_123'
};

// Estado del bot (simulado)
let tradingState = {
  isActive: false,
  currentPosition: null,
  tradeHistory: []
};

// === RUTAS API ===

// Webhook desde TradingView
app.post('/webhook', (req, res) => {
  const signal = req.body;

  if (signal.secret !== CONFIG.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('📡 Señal recibida:', signal);

  // Simula guardar en historial
  tradingState.tradeHistory.push({
    ...signal,
    timestamp: new Date(),
    type: signal.action || 'ENTRY'
  });

  res.json({ success: true, message: 'Señal recibida correctamente' });
});

// Estado actual
app.get('/api/status', (req, res) => {
  res.json({
    isActive: tradingState.isActive,
    currentPosition: tradingState.currentPosition,
    tradeHistory: tradingState.tradeHistory.slice(-10)
  });
});

// Activar/desactivar bot
app.post('/api/config', (req, res) => {
  tradingState.isActive = !!req.body.isActive;
  res.json({ success: true, isActive: tradingState.isActive });
});

// Cerrar posición simulada
app.post('/api/close', (req, res) => {
  tradingState.currentPosition = null;
  res.json({ success: true, message: 'Posición cerrada (simulada)' });
});

// Historial de señales
app.get('/api/history', (req, res) => {
  res.json(tradingState.tradeHistory);
});

// Panel web simple
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Trading Bot - Webhook</title>
        <meta charset="UTF-8">
        <style>
            body { font-family: Arial; max-width: 700px; margin: auto; padding: 20px; }
            .status { margin: 10px 0; padding: 10px; border-radius: 4px; background: #f1f1f1; }
            button { padding: 10px; margin: 5px; cursor: pointer; }
        </style>
    </head>
    <body>
        <h1>🤖 Webhook Activo</h1>
        <p>Este bot está listo para recibir señales desde TradingView.</p>

        <div class="status" id="estado">Cargando estado...</div>
        <div id="historial"></div>

        <button onclick="toggleBot()">Activar/Desactivar Bot</button>
        <button onclick="cerrar()">Cerrar posición</button>

        <script>
          async function cargarEstado() {
            const res = await fetch('/api/status');
            const data = await res.json();
            document.getElementById('estado').innerText = 
              data.isActive ? '✅ Bot Activo' : '⛔️ Bot Inactivo';

            const historial = document.getElementById('historial');
            historial.innerHTML = '<h3>Historial:</h3>' + data.tradeHistory.map(t =>
              \`<div class="status">[\${t.type}] \${t.symbol || ''} - \${new Date(t.timestamp).toLocaleString()}</div>\`
            ).join('');
          }

          async function toggleBot() {
            const res = await fetch('/api/status');
            const estado = await res.json();
            await fetch('/api/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ isActive: !estado.isActive })
            });
            cargarEstado();
          }

          async function cerrar() {
            await fetch('/api/close', { method: 'POST' });
            cargarEstado();
          }

          cargarEstado();
          setInterval(cargarEstado, 5000);
        </script>
    </body>
    </html>
  `);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
});
