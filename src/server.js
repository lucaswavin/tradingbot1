const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const webhookRoutes = require('../routes/webhook');
const dashboardRoutes = require('../routes/dashboard');

const app = express();
app.use(express.json());

app.use('/webhook', webhookRoutes);
app.use('/', dashboardRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Trading Bot iniciado en puerto ${PORT}`);
});

