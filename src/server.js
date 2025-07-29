const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const dashboardRoutes = require('../routes/dashboard');
const webhookRoutes = require('../routes/webhook'); // crea este archivo para tus webhooks

const app = express();
if (!global.botState) global.botState = { signals: [] };
app.use(express.json());

app.use('/webhook', webhookRoutes);
app.use('/', dashboardRoutes);

app.use((req, res) => {
  res.status(404).send('<h2>404 - No encontrado</h2>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Trading Bot iniciado en puerto ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
});
