const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

// Ruta para señales que solo se muestran en dashboard (webhook original)
router.post('/', webhookController.handleWebhook);

// Ruta para trading automático con BingX
router.post('/trade', webhookController.handleTradingViewWebhook);

module.exports = router;
