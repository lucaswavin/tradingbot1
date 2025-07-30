require('dotenv').config();
const { placeOrder, getUSDTBalance, closePosition, closeAllPositions } = require('../services/bingx/api');

// Función original para mostrar señales en dashboard
exports.handleWebhook = async (req, res) => {
  console.log('\n📨 ===== WEBHOOK RECIBIDO =====');
  const data = req.body;
  console.log('📋 Datos completos del webhook:', JSON.stringify(data, null, 2));
  
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

// Función mejorada para trading automático con BingX
exports.handleTradingViewWebhook = async (req, res) => {
  console.log('\n🚀 ===== TRADING WEBHOOK RECIBIDO =====');
  const { symbol, side, webhook_secret, action, qty, strategy } = req.body;
  
  console.log('📋 Datos del trading webhook:', JSON.stringify(req.body, null, 2));
  console.log('🔍 Action detectado:', action);
  console.log('🔍 Strategy detectado:', strategy);

  // Verificar webhook secret
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
    // Determinar qué acción tomar basado en los parámetros
    console.log('\n--- ANALIZANDO ACCIÓN ---');
    let actionToTake = 'unknown';
    let orderSide = '';
    
    // Detectar acción basada en múltiples campos
    if (action) {
      console.log(`🎯 Action field: ${action}`);
      if (action.toLowerCase().includes('close') || action.toLowerCase().includes('exit')) {
        actionToTake = 'close';
      } else if (action.toLowerCase().includes('long') || action.toLowerCase().includes('buy')) {
        actionToTake = 'open_long';
        orderSide = 'BUY';
      } else if (action.toLowerCase().includes('short') || action.toLowerCase().includes('sell')) {
        actionToTake = 'open_short';
        orderSide = 'SELL';
      }
    }
    
    // Si no hay action, usar side como fallback
    if (actionToTake === 'unknown') {
      const sideUpper = side.toUpperCase();
      if (sideUpper === 'BUY' || sideUpper === 'LONG') {
        actionToTake = 'open_long';
        orderSide = 'BUY';
      } else if (sideUpper === 'SELL' || sideUpper === 'SHORT') {
        actionToTake = 'open_short';
        orderSide = 'SELL';
      } else if (sideUpper === 'CLOSE' || sideUpper === 'EXIT') {
        actionToTake = 'close';
      }
    }
    
    console.log(`✅ Acción determinada: ${actionToTake}`);
    console.log(`✅ Order side: ${orderSide}`);

    // Chequear balance antes de operar (solo para órdenes de apertura)
    let balance = 0;
    if (actionToTake.includes('open')) {
      console.log('\n--- VERIFICANDO BALANCE ---');
      balance = await getUSDTBalance();
      console.log(`💰 Balance verificado: ${balance} USDT`);
      
      const minBalance = 2;
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
    }

    let response;
    
    // Ejecutar acción correspondiente
    console.log('\n--- EJECUTANDO ACCIÓN ---');
    
    if (actionToTake === 'close') {
      console.log('🔒 CERRANDO POSICIÓN');
      console.log(`🎯 Cerrando todas las posiciones para: ${symbol}`);
      
      response = await closeAllPositions(symbol);
      
    } else if (actionToTake === 'open_long' || actionToTake === 'open_short') {
      console.log(`📈 ABRIENDO POSICIÓN: ${actionToTake.toUpperCase()}`);
      console.log(`🎯 Orden a ejecutar: ${orderSide} ${symbol}`);
      console.log('⚙️ Configuración: 5x leverage, 1 USDT o mínimo requerido');
      
      response = await placeOrder({
        symbol,
        side: orderSide,
        leverage: 5,
        usdtAmount: 1  // 1 USDT o el mínimo que requiera BingX
      });
      
    } else {
      console.log('❓ ACCIÓN NO RECONOCIDA');
      return res.status(400).json({
        ok: false,
        msg: 'Acción no reconocida',
        received: { symbol, side, action, strategy },
        help: 'Use action: "close", "long", "short" o side: "buy", "sell", "close"'
      });
    }

    console.log('\n--- PROCESANDO RESPUESTA ---');
    console.log('📨 Respuesta completa:', JSON.stringify(response, null, 2));

    // Guarda la señal para el dashboard
    if (!global.botState) global.botState = { signals: [] };
    
    const signalRecord = {
      symbol,
      side: side.toUpperCase(),
      action: action || side,
      actionTaken: actionToTake,
      orderSide: orderSide,
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
      console.log('✅ ACCIÓN EJECUTADA EXITOSAMENTE');
      if (response.data && response.data.orderId) {
        console.log('🎉 Order ID:', response.data.orderId);
      }
      console.log('=====================================\n');
      
      return res.json({ 
        ok: true, 
        msg: `${actionToTake} ejecutado exitosamente en BingX`, 
        action: actionToTake,
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
        msg: `Error ejecutando ${actionToTake} en BingX`, 
        action: actionToTake,
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

// Resto de funciones (test, status, etc.)
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

exports.getStatus = (req, res) => {
  const signals = global.botState?.signals || [];
  const lastSignals = signals.slice(-10);
  
  const stats = {
    totalSignals: signals.length,
    successfulTrades: signals.filter(s => s.orderSuccess === true).length,
    failedTrades: signals.filter(s => s.tradingExecuted === true && s.orderSuccess !== true).length,
    errorsCount: signals.filter(s => s.error).length,
    closeActions: signals.filter(s => s.actionTaken === 'close').length,
    openActions: signals.filter(s => s.actionTaken && s.actionTaken.includes('open')).length,
    lastSignalTime: signals.length > 0 ? signals[signals.length - 1].timestamp : 'Nunca',
    apiConfigured: !!(process.env.BINGX_API_KEY && process.env.BINGX_API_SECRET),
    webhookSecretConfigured: !!process.env.WEBHOOK_SECRET
  };
  
  res.json({
    ok: true,
    stats: stats,
    lastSignals: lastSignals,
    timestamp: new Date().toISOString()
  });
};

