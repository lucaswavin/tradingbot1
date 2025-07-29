// src/server.js
const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const webhookRoutes = require('../routes/webhook');
const dashboardRoutes = require('../routes/dashboard');

const app = express();

// Para guardar señales globalmente
if (!global.botState) global.botState = { signals: [] };

app.use(express.json());

// Rutas principales
app.use('/webhook', webhookRoutes);     // (Asume que ya tienes routes/webhook.js)
app.use('/', dashboardRoutes);          // Dashboard visual en "/"

// 404 genérico
app.use((req, res) => {
  res.status(404).send('<h2>404 - No encontrado</h2>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Trading Bot iniciado en puerto ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
});
