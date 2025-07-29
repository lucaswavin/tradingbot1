require('dotenv').config();
const { placeOrder, getUSDTBalance } = require('../services/bingx/api');

// Función original para mostrar señales en dashboard
exports.handleWebhook = async (req, res) => {
  const data = req.body;
  console.log('📨 Webhook recibido:', JSON.stringify(data, null, 2));
  
  if (!global.botState) global.botState = { signals: [] };
  global.botState.signals.push({
    ...data,
    timestamp: new Date().toLocaleString()
  });
  
  res.json({ success: true, message: 'Señal recibida', data });
};

// Función para trading automático con BingX
exports.handleTradingViewWebhook = async (req, res) => {
  const { symbol, side, webhook_secret, action } = req.body;
  
  console.log('🚀 Trading webhook recibido:', JSON.stringify(req.body, null, 2));

  // Verifica el webhook secret si está configurado
  if (process.env.WEBHOOK_SECRET && webhook_secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, msg: 'Webhook secret inválido' });
  }

  // Validaciones básicas
  if (!symbol || !side) {
    return res.status(400).json({ 
      ok: false, 
      msg: 'Faltan parámetros requeridos: symbol y side' 
    });
  }

  try {
    // Chequea balance antes de operar
    const balance = await getUSDTBalance();
    console.log(`💰 Balance actual: ${balance} USDT`);
    
    if (balance < 2) {
      return res.status(400).json({ 
        ok: false, 
        msg: 'Balance insuficiente para operar', 
        balance 
      });
    }

    // Ejecuta la orden
    console.log(`📈 Ejecutando orden: ${side} ${symbol}`);
    const response = await placeOrder({
      symbol,
      side,
      leverage: 5,
      positionMode: 'ISOLATED'
    });

    // Guarda la señal para el dashboard
    if (!global.botState) global.botState = { signals: [] };
    global.botState.signals.push({
      symbol,
      side,
      action: action || side,
      timestamp: new Date().toLocaleString(),
      data: req.body,
      bingxResponse: response
    });

    if (response && response.code === 0) {
      return res.json({ 
        ok: true, 
        msg: 'Trade abierto en BingX', 
        data: response.data 
      });
    } else {
      return res.status(400).json({ 
        ok: false, 
        msg: 'Error BingX', 
        data: response 
      });
    }
  } catch (err) {
    console.error('❌ Error en trading webhook:', err.message);
    return res.status(500).json({ 
      ok: false, 
      msg: 'Error en el bot', 
      error: err.message 
    });
  }
};


