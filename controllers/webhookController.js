require('dotenv').config();
const { placeOrder, getUSDTBalance } = require('../services/bingx/api');

// Función original para mostrar señales en dashboard
exports.handleWebhook = async (req, res) => {
  console.log('\n📨 ===== WEBHOOK RECIBIDO =====');
  const data = req.body;
  console.log('📋 Datos completos del webhook:', JSON.stringify(data, null, 2));
  console.log('🌐 Headers:', JSON.stringify(req.headers, null, 2));
  console.log('🔗 URL:', req.url);
  console.log('🔗 Method:', req.method);
  
  if (!global.botState) global.botState = { signals: [] };
  
  // Siempre guardar la señal para el dashboard
  const signalData = {
    ...data,
    timestamp: new Date().toLocaleString(),
    receivedAt: new Date().toISOString()
  };
  
  global.botState.signals.push(signalData);
  console.log(`📊 Señal guardada en dashboard. Total señales: ${global.botState.signals.length}`);
  
  console.log('==============================\n');
  res.json({ success: true, message: 'Señal recibida', data });
};

// Función para trading automático con BingX
exports.handleTradingViewWebhook = async (req, res) => {
  console.log('\n🚀 ===== TRADING WEBHOOK RECIBIDO =====');
  const { symbol, side, webhook_secret, action, qty } = req.body;
  
  console.log('📋 Datos del trading webhook:', JSON.stringify(req.body, null, 2));
  console.log('🌐 Headers recibidos:', JSON.stringify(req.headers, null, 2));
  console.log('🔗 URL completa:', req.url);
  console.log('🔗 IP origen:', req.ip || req.connection.remoteAddress);

  // Verificar webhook secret si está configurado
  console.log('\n--- VERIFICANDO SEGURIDAD ---');
  console.log('🔐 Webhook secret configurado:', process.env.WEBHOOK_SECRET ? 'SÍ' : 'NO');
  console.log('🔐 Secret recibido:', webhook_secret ? `${webhook_secret.substring(0, 5)}...` : 'NO ENVIADO');
  
  if (process.env.WEBHOOK_SECRET && webhook_secret !== process.env.WEBHOOK_SECRET) {
    console.log('❌ WEBHOOK SECRET INVÁLIDO');
    return res.status(401).json({ ok: false, msg: 'Webhook secret inválido' });
  }
  console.log('✅ Secret válido o no requerido');

  // Validaciones básicas
  console.log('\n--- VALIDANDO PARÁMETROS ---');
  console.log('📊 Symbol:', symbol);
  console.log('📊 Side:', side);
  console.log('📊 Action:', action);
  console.log('📊 Quantity:', qty);
  
  if (!symbol || !side) {
    console.log('❌ FALTAN PARÁMETROS REQUERIDOS');
    return res.status(400).json({ 
      ok: false, 
      msg: 'Faltan parámetros requeridos: symbol y side',
      received: { symbol, side, action, qty }
    });
  }
  console.log('✅ Parámetros básicos válidos');

  try {
    // Chequea balance antes de operar
    console.log('\n--- VERIFICANDO BALANCE ---');
    const balance = await getUSDTBalance();
    console.log(`💰 Balance verificado: ${balance} USDT`);
    
    const minBalance = 5;
    if (balance < minBalance) {
      console.log(`❌ BALANCE INSUFICIENTE: ${balance} < ${minBalance} USDT`);
      return res.status(400).json({ 
        ok: false, 
        msg: `Balance insuficiente para operar. Mínimo: ${minBalance} USDT`, 
        balance: balance,
        required: minBalance
      });
    }
    console.log('✅ Balance suficiente para operar');

    // Ejecuta la orden
    console.log('\n--- EJECUTANDO ORDEN EN BINGX ---');
    console.log(`🎯 Orden a ejecutar: ${side.toUpperCase()} ${symbol}`);
    console.log('⚙️ Configuración: 5x leverage, 5 USDT por orden');
    
    const response = await placeOrder({
      symbol,
      side,
      leverage: 5,
      usdtAmount: 5
    });

    console.log('\n--- PROCESANDO RESPUESTA ---');
    console.log('📨 Respuesta completa de BingX:', JSON.stringify(response, null, 2));

    // Guarda la señal para el dashboard
    if (!global.botState) global.botState = { signals: [] };
    
    const signalRecord = {
      symbol,
      side: side.toUpperCase(),
      action: action || side,
      timestamp: new Date().toLocaleString(),
      receivedAt: new Date().toISOString(),
      data: req.body,
      bingxResponse: response,
      tradingExecuted: true,
      balance: balance,
      orderSuccess: response && (response.code === 0 || response.success === true)
    };
    
    global.botState.signals.push(signalRecord);
    console.log(`📊 Señal guardada en dashboard. Total: ${global.botState.signals.length}`);

    // Evaluar respuesta
    if (response && (response.code === 0 || response.success === true)) {
      console.log('✅ ORDEN EJECUTADA EXITOSAMENTE');
      console.log('🎉 Order ID:', response.data?.orderId || 'N/A');
      console.log('=====================================\n');
      
      return res.json({ 
        ok: true, 
        msg: 'Trade ejecutado exitosamente en BingX', 
        data: response.data || response,
        balance: balance,
        timestamp: new Date().toISOString()
      });
    } else {
      console.log('❌ ERROR EN LA RESPUESTA DE BINGX');
      console.log('📄 Código de error:', response?.code || 'N/A');
      console.log('📄 Mensaje:', response?.msg || response?.message || 'Sin mensaje');
      console.log('=====================================\n');
      
      return res.status(400).json({ 
        ok: false, 
        msg: 'Error ejecutando orden en BingX', 
        data: response,
        errorCode: response?.code,
        errorMessage: response?.msg || response?.message
      });
    }
  } catch (err) {
    console.log('\n❌ ===== ERROR CRÍTICO =====');
    console.error('💥 Error en trading webhook:', err.message);
    console.error('📚 Stack trace:', err.stack);
    
    // Marcar el error en la señal
    if (!global.botState) global.botState = { signals: [] };
    
    const errorRecord = {
      symbol,
      side: side ? side.toUpperCase() : 'UNKNOWN',
      action: action || 'ERROR',
      timestamp: new Date().toLocaleString(),
      receivedAt: new Date().toISOString(),
      data: req.body,
      error: err.message,
      errorStack: err.stack,
      tradingExecuted: false
    };
    
    global.botState.signals.push(errorRecord);
    console.log('📊 Error guardado en dashboard');
    console.log('============================\n');
    
    return res.status(500).json({ 
      ok: false, 
      msg: 'Error crítico en el bot', 
      error: err.message,
      timestamp: new Date().toISOString(),
      symbol: symbol,
      side: side
    });
  }
};

// Función adicional para debug
exports.testConnection = async (req, res) => {
  console.log('\n🔧 ===== TEST DE CONEXIÓN =====');
  
  try {
    console.log('📊 Testeando conexión con BingX...');
    const balance = await getUSDTBalance();
    
    console.log('✅ CONEXIÓN EXITOSA');
    console.log(`💰 Balance actual: ${balance} USDT`);
    console.log('==============================\n');
    
    res.json({
      ok: true,
      msg: 'Conexión con BingX exitosa',
      balance: balance,
      timestamp: new Date().toISOString(),
      apiConfigured: !!(process.env.BINGX_API_KEY && process.env.BINGX_API_SECRET)
    });
  } catch (error) {
    console.log('❌ ERROR DE CONEXIÓN');
    console.error('💥 Error:', error.message);
    console.log('==============================\n');
    
    res.status(500).json({
      ok: false,
      msg: 'Error conectando con BingX',
      error: error.message,
      timestamp: new Date().toISOString(),
      apiConfigured: !!(process.env.BINGX_API_KEY && process.env.BINGX_API_SECRET)
    });
  }
};

// Debug: mostrar estado del bot
exports.getStatus = (req, res) => {
  console.log('\n📊 ===== ESTADO DEL BOT =====');
  
  const signals = global.botState?.signals || [];
  const lastSignals = signals.slice(-10);
  
  const stats = {
    totalSignals: signals.length,
    successfulTrades: signals.filter(s => s.orderSuccess === true).length,
    failedTrades: signals.filter(s => s.tradingExecuted === true && s.orderSuccess !== true).length,
    errorsCount: signals.filter(s => s.error).length,
    lastSignalTime: signals.length > 0 ? signals[signals.length - 1].timestamp : 'Nunca',
    apiConfigured: !!(process.env.BINGX_API_KEY && process.env.BINGX_API_SECRET),
    webhookSecretConfigured: !!process.env.WEBHOOK_SECRET
  };
  
  console.log('📈 Estadísticas:', stats);
  console.log('============================\n');
  
  res.json({
    ok: true,
    stats: stats,
    lastSignals: lastSignals,
    timestamp: new Date().toISOString()
  });
};


