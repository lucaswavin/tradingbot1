require('dotenv').config();
const { placeOrder } = require('../services/bingx/api');

async function handleTradingViewWebhook(req, res) {
  const { symbol, side, webhook_secret } = req.body;

  if (webhook_secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, msg: 'Webhook secret inválido' });
  }

  try {
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
  } catchrequire('dotenv').config();
const { placeOrder } = require('../services/bingx/api');

async function handleTradingViewWebhook(req, res) {
  const { symbol, side, webhook_secret } = req.body;

  if (webhook_secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, msg: 'Webhook secret inválido' });
  }

  try {
    const response = await placeOrder({
      symbol,
      side,
      leverage: 5,
      positionMode: 'ISOLATED'
    });

    if (response && response.code === 0) {
      return res.json({ ok: true, msg: 'Trade abierto en BingX', data: response.data });
    } else {
      return res.status(400).json({
        ok: false,
        msg: 'Error BingX',
        code: response.code,
        error: response.msg,
        data: response
      });
    }
  } catch (err) {
    console.error('Error en handleTradingViewWebhook:', err); // <- útil en Railway
    return res.status(500).json({ ok: false, msg: 'Error en el bot', error: err.message });
  }
}

module.exports = { handleTradingViewWebhook };



