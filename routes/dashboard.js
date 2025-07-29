const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');

router.get('/', dashboardController.dashboard);

router.post('/api/refresh-balance', async (req, res) => {
  // Solo para refrescar balance y recargar dashboard
  res.redirect('/');
});

module.exports = router;
