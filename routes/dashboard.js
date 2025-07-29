const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');

router.get('/', dashboardController.dashboard);

// Endpoint para actualizar balance manualmente (opcional)
router.post('/api/refresh-balance', async (req, res) => {
  // Solo refresca, luego redirige al dashboard
  await require('../services/bingx/api').getBalance();
  res.redirect('/');
});

module.exports = router;
