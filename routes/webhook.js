const express = require('express');
const router = express.Router();
const { handleTradingViewWebhook } = require('../controllers/webhookController');

router.post('/webhook', handleTradingViewWebhook);

module.exports = router;
