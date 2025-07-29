const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');

router.get('/', dashboardController.dashboard);

router.post('/api/refresh-balance', dashboardController.refreshBalance);

module.exports = router;
