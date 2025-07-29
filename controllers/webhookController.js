require('dotenv').config();
const { placeOrder, getUSDTBalance } = require('../services/bingx/api');

// Valida balance antes de operar y ejecuta la orden
async function handleTradingViewWebhook(req, res) {
  const { symbol, side, webhook_secret } = req.body;

  if (webhook_secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, msg: 'Webhook secret inválido' });
  }

  try {
    // Chequea balance antes de operar
    const balance = await getUSDTBalance();
    if (balance < 2) {
      return res.status(400).json({ ok: false, msg: 'Balance insuficiente para operar', balance });
    }

    const response = await placeOrder({
      symbol,
      side,
      leverage: 5,
      positionMode: 'ISOLATED'
    });

    if (response && response.code === 0) {
      return res.json({ ok: true, msg: 'Trade abierto en BingX', data: response.data });
    } else {
      return res.status(400).json({ ok: false, msg: 'Error BingX', data: response });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, msg: 'Error en el bot', error: err.message });
  }
}

module.exports = { handleTradingViewWebhook };


