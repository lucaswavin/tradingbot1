require('dotenv').config();
const { placeOrder } = require('../services/bingx/api');

async function handleTradingViewWebhook(req, res) {
  const { symbol, side, qty, webhook_secret } = req.body;

  // Verifica tu secret, ajústalo según tu .env
  if (webhook_secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, msg: 'Webhook secret inválido' });
  }

  // Puedes validar la señal con tu lógica de estrategia aquí

  try {
    const response = await placeOrder({
      symbol,
      side,
      quantity: qty || 1,
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



