const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const webhookController = require('../controllers/webhookController'); // ← Ya lo tienes

router.get('/', dashboardController.dashboard);
router.post('/api/refresh-balance', dashboardController.refreshBalance);
router.get('/api/metrics', webhookController.getMetrics); // ← AGREGAR ESTA LÍNEA

module.exports = router;
