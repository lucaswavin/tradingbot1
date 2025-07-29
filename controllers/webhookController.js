require('dotenv').config();
const { placeOrder } = require('../services/bingx/api');
const { validarSenal } = require('../services/strategies/miEstrategia');

async function handleTradingViewWebhook(req, res) {
  // LOG DE DEBUG
  console.log('🟢 Señal recibida en webhook:', JSON.stringify(req.body));
  const { symbol, side, webhook_secret } = req.body;

  // CHEQUEA EL SECRET
  if (webhook_secret !== process.env.WEBHOOK_SECRET) {
    console.log('❌ Webhook secret inválido');
    return res.status(401).json({ ok: false, msg: 'Webhook secret inválido' });
  }

  // VALIDA LA SEÑAL
  if (!validarSenal(req.body)) {
    console.log('❌ Señal rechazada por validarSenal:', req.body);
    return res.status(200).json({ ok: false, msg: 'Señal ignorada por estrategia' });
  }

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
    // LOG DE LA RESPUESTA DE BINGX
    console.log('📤 Respuesta de placeOrder:', response);

    if (response && response.code === 0) {
      return res.json({ ok: true, msg: 'Trade abierto en BingX', data: response.data });
    } else {
      return res.status(400).json({ ok: false, msg: 'Error BingX', data: response });
    }
  } catch (err) {
    // LOG DE ERRORES DE CÓDIGO
    console.log('💥 Error en try/catch:', err);
    return res.status(500).json({ ok: false, msg: 'Error en el bot', error: err.message });
  }
}

module.exports = { handleTradingViewWebhook };


