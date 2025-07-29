require('dotenv').config();
const { placeOrder } = require('../services/bingx/api');
const { validarSenal } = require('../services/strategies/miEstrategia');

async function handleTradingViewWebhook(req, res) {
  const { symbol, side, webhook_secret } = req.body;

  // Seguridad: comprueba el secreto
  if (webhook_secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, msg: 'Webhook secret inválido' });
  }

  // Valida la señal (puedes ver logs aquí si quieres)
  if (!validarSenal(req.body)) {
    return res.status(200).json({ ok: false, msg: 'Señal ignorada por estrategia' });
  }

  // PARÁMETROS FIJOS: 1 USDT, apalancamiento 5x, isolated
  const quantity = 1;
  const leverage = 5;
  const positionMode = 'isolated';

  try {
    const response = await placeOrder({
      symbol,
      side,
      quantity,
      leverage,
      positionMode
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

// ¡NO olvides exportar!
module.exports = { handleTradingViewWebhook };

