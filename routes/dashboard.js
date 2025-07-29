// routes/dashboard.js
const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');

router.get('/', dashboardController.dashboard);

// Opcional: actualizar balance forzado con botón
router.post('/api/refresh-balance', async (req, res) => {
  try {
    await require('../services/bingx/api').getUSDTBalance();
  } catch (e) {}
  res.redirect('/');
});

module.exports = router;
