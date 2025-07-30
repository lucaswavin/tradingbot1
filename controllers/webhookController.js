require('dotenv').config();
const { placeOrder, getUSDTBalance, closePosition, closeAllPositions } = require('../services/bingx/api');

// 🚀 FUNCIÓN ORIGINAL OPTIMIZADA PARA DASHBOARD
exports.handleWebhook = async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('\n📨 ===== WEBHOOK RECIBIDO =====');
    const data = req.body;
    console.log('📋 Datos completos del webhook:', JSON.stringify(data, null, 2));
    
    // ✅ RESPUESTA ULTRA-RÁPIDA
    res.json({ success: true, message: 'Señal recibida', data, receivedAt: startTime });
    
    // 🚀 PROCESAMIENTO EN BACKGROUND
    setImmediate(() => {
      processSignalForDashboard(data, startTime);
    });
    
  } catch (error) {
    console.error('❌ Error en webhook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

async function processSignalForDashboard(data, startTime) {
  try {
    if (!global.botState) global.botState = { signals: [] };
    
    const signalData = {
      ...data,
      timestamp: new Date().toLocaleString(),
      receivedAt: new Date().toISOString(),
      processingTime: Date.now() - startTime
    };
    
    global.botState.signals.push(signalData);
    
    // Mantener solo las últimas 50 para velocidad
    if (global.botState.signals.length > 50) {
      global.botState.signals = global.botState.signals.slice(-50);
    }
    
    console.log(`📊 Señal guardada en dashboard. Total señales: ${global.botState.signals.length}`);
    console.log('==============================\n');
  } catch (error) {
    console.error('❌ Error procesando señal dashboard:', error);
  }
}

// 🔥 FUNCIÓN DE TRADING ULTRA-OPTIMIZADA
exports.handleTradingViewWebhook = async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('\n🚀 ===== TRADING WEBHOOK RECIBIDO =====');
    const { symbol, side, webhook_secret, action, qty, strategy } = req.body;
    
    console.log('📋 Datos del trading webhook:', JSON.stringify(req.body, null, 2));
    
    // ✅ RESPUESTA INMEDIATA (antes de validaciones pesadas)
    res.json({ 
      ok: true, 
      received: true,
      message: 'Trading signal received and processing',
      timestamp: startTime
    });
    
    // 🚀 PROCESAMIENTO OPTIMIZADO EN BACKGROUND
    setImmediate(() => {
      processTradingSignalOptimized(req.body, startTime);
    });

  } catch (error) {
    console.error('❌ Error crítico en trading webhook:', error);
    res.status(500).json({ 
      ok: false, 
      msg: 'Error crítico en el bot', 
      error: error.message
    });
  }
};

async function processTradingSignalOptimized(requestBody, startTime) {
  const { symbol, side, webhook_secret, action, qty, strategy } = requestBody;
  
  try {
    console.log('🔍 Action detectado:', action);
    console.log('🔍 Strategy detectado:', strategy);

    // ✅ VALIDACIÓN RÁPIDA DE WEBHOOK SECRET
    if (process.env.WEBHOOK_SECRET && webhook_secret !== process.env.WEBHOOK_SECRET) {
      console.log('❌ Webhook secret inválido');
      await saveErrorRecord(requestBody, 'Webhook secret inválido', startTime);
      return;
    }

    // ✅ VALIDACIONES BÁSICAS ULTRA-RÁPIDAS
    if (!symbol || !side) {
      console.log('❌ Faltan parámetros requeridos');
      await saveErrorRecord(requestBody, 'Faltan parámetros requeridos: symbol y side', startTime);
      return;
    }

    // ✅ DEDUPLICACIÓN RÁPIDA
    const signalId = `${symbol}_${action || side}_${Date.now()}`;
    if (global.lastTradingSignalId === signalId && 
        global.lastTradingSignalTime && 
        (Date.now() - global.lastTradingSignalTime) < 1000) {
      console.log('⚠️ Señal de trading duplicada ignorada');
      return;
    }
    global.lastTradingSignalId = signalId;
    global.lastTradingSignalTime = Date.now();

    // ✅ DETERMINAR ACCIÓN DE FORMA ULTRA-OPTIMIZADA
    console.log('\n--- ANALIZANDO ACCIÓN (OPTIMIZADO) ---');
    let actionToTake = 'unknown';
    let orderSide = '';
    
    if (action) {
      const actionLower = action.toLowerCase();
      if (actionLower.includes('close') || actionLower.includes('exit')) {
        actionToTake = 'close';
      } else if (actionLower.includes('long') || actionLower.includes('buy')) {
        actionToTake = 'open_long';
        orderSide = 'BUY';
      } else if (actionLower.includes('short') || actionLower.includes('sell')) {
        actionToTake = 'open_short';
        orderSide = 'SELL';
      }
    }
    
    // Fallback optimizado usando side
    if (actionToTake === 'unknown') {
      const sideUpper = side.toUpperCase();
      switch (sideUpper) {
        case 'BUY':
        case 'LONG':
          actionToTake = 'open_long';
          orderSide = 'BUY';
          break;
        case 'SELL':
        case 'SHORT':
          actionToTake = 'open_short';
          orderSide = 'SELL';
          break;
        case 'CLOSE':
        case 'EXIT':
          actionToTake = 'close';
          break;
      }
    }
    
    console.log(`✅ Acción determinada: ${actionToTake}`);
    console.log(`✅ Order side: ${orderSide}`);

    // ✅ VERIFICACIÓN DE BALANCE OPTIMIZADA (solo para aperturas y en paralelo)
    let balance = 0;
    let balancePromise = null;
    
    if (actionToTake.includes('open')) {
      console.log('\n--- VERIFICANDO BALANCE (PARALELO) ---');
      balancePromise = getUSDTBalance().catch(() => 0); // No bloquear si falla
    }

    // 🔥 EJECUCIÓN INMEDIATA (en paralelo con balance si es necesario)
    console.log('\n--- EJECUTANDO ACCIÓN (ULTRA-RÁPIDO) ---');
    let response;
    
    try {
      if (actionToTake === 'close') {
        console.log('🔒 CERRANDO POSICIÓN');
        console.log(`🎯 Cerrando todas las posiciones para: ${symbol}`);
        response = await closeAllPositions(symbol);
        
      } else if (actionToTake === 'open_long' || actionToTake === 'open_short') {
        // Esperar balance solo si se está calculando
        if (balancePromise) {
          balance = await balancePromise;
          console.log(`💰 Balance verificado: ${balance} USDT`);
          
          const minBalance = 2;
          if (balance < minBalance) {
            console.log(`❌ BALANCE INSUFICIENTE: ${balance} < ${minBalance} USDT`);
            await saveSignalRecord(requestBody, actionToTake, orderSide, null, balance, false, 'Balance insuficiente', startTime);
            return;
          }
          console.log('✅ Balance suficiente para operar');
        }
        
        console.log(`📈 ABRIENDO POSICIÓN: ${actionToTake.toUpperCase()}`);
        console.log(`🎯 Orden a ejecutar: ${orderSide} ${symbol}`);
        console.log('⚙️ Configuración: 5x leverage, 1 USDT o mínimo requerido');
        
        response = await placeOrder({
          symbol,
          side: orderSide,
          leverage: 5,
          usdtAmount: 1
        });
        
      } else {
        console.log('❓ ACCIÓN NO RECONOCIDA');
        await saveSignalRecord(requestBody, actionToTake, orderSide, null, balance, false, 'Acción no reconocida', startTime);
        return;
      }

      // ✅ EVALUAR Y GUARDAR RESULTADO
      console.log('\n--- PROCESANDO RESPUESTA ---');
      console.log('📨 Respuesta completa:', JSON.stringify(response, null, 2));

      const orderSuccess = response && (response.code === 0 || response.success === true);
      
      await saveSignalRecord(requestBody, actionToTake, orderSide, response, balance, orderSuccess, null, startTime);

      if (orderSuccess) {
        console.log('✅ ACCIÓN EJECUTADA EXITOSAMENTE');
        if (response.data?.orderId) {
          console.log('🎉 Order ID:', response.data.orderId);
        }
      } else {
        console.log('❌ ERROR EN LA RESPUESTA DE BINGX');
        console.log('📄 Error:', response?.msg || response?.message || 'Sin mensaje');
      }

    } catch (executionError) {
      console.log('❌ ERROR EN EJECUCIÓN:', executionError.message);
      await saveSignalRecord(requestBody, actionToTake, orderSide, null, balance, false, executionError.message, startTime);
    }

    console.log('=====================================\n');

    // ✅ LOG DE RENDIMIENTO
    const totalLatency = Date.now() - startTime;
    console.log(`⚡ Tiempo total de procesamiento: ${totalLatency}ms`);

  } catch (error) {
    console.error('❌ Error crítico en procesamiento:', error);
    await saveErrorRecord(requestBody, error.message, startTime);
  }
}

// ✅ FUNCIONES OPTIMIZADAS PARA GUARDAR SEÑALES
async function saveSignalRecord(requestBody, actionTaken, orderSide, response, balance, orderSuccess, errorMessage, startTime) {
  try {
    if (!global.botState) global.botState = { signals: [] };
    
    const signalRecord = {
      symbol: requestBody.symbol,
      side: requestBody.side ? requestBody.side.toUpperCase() : 'UNKNOWN',
      action: requestBody.action || requestBody.side,
      actionTaken,
      orderSide,
      timestamp: new Date().toLocaleString(),
      receivedAt: new Date().toISOString(),
      data: requestBody,
      bingxResponse: response,
      tradingExecuted: true,
      balance,
      orderSuccess,
      error: errorMessage,
      processingTime: Date.now() - startTime
    };
    
    global.botState.signals.push(signalRecord);
    
    // Mantener solo las últimas 50 para velocidad
    if (global.botState.signals.length > 50) {
      global.botState.signals = global.botState.signals.slice(-50);
    }
    
    console.log(`📊 Señal guardada en dashboard. Total: ${global.botState.signals.length}`);
    
  } catch (error) {
    console.error('❌ Error guardando señal:', error);
  }
}

async function saveErrorRecord(requestBody, errorMessage, startTime) {
  try {
    if (!global.botState) global.botState = { signals: [] };
    
    const errorRecord = {
      symbol: requestBody.symbol || 'UNKNOWN',
      side: requestBody.side ? requestBody.side.toUpperCase() : 'UNKNOWN',
      action: requestBody.action || 'ERROR',
      timestamp: new Date().toLocaleString(),
      receivedAt: new Date().toISOString(),
      data: requestBody,
      error: errorMessage,
      tradingExecuted: false,
      processingTime: Date.now() - startTime
    };
    
    global.botState.signals.push(errorRecord);
    
    if (global.botState.signals.length > 50) {
      global.botState.signals = global.botState.signals.slice(-50);
    }
    
    console.log('📊 Error guardado en dashboard');
    
  } catch (error) {
    console.error('❌ Error guardando error:', error);
  }
}

// ✅ RESTO DE FUNCIONES (mantenidas igual para compatibilidad)
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
    webhookSecretConfigured: !!process.env.WEBHOOK_SECRET,
    averageProcessingTime: signals.length > 0 
      ? (signals.reduce((sum, s) => sum + (s.processingTime || 0), 0) / signals.length).toFixed(1) + 'ms'
      : '0ms'
  };
  
  res.json({
    ok: true,
    stats: stats,
    lastSignals: lastSignals,
    timestamp: new Date().toISOString()
  });
};

exports.getMetrics = (req, res) => {
  const signals = global.botState?.signals || [];
  const lastSignals = signals.slice(-10);
  
  const successfulTrades = signals.filter(s => s.orderSuccess === true).length;
  const failedTrades = signals.filter(s => s.tradingExecuted === true && s.orderSuccess !== true).length;
  const totalTrades = signals.filter(s => s.tradingExecuted === true).length;
  
  const processingTimes = signals.filter(s => s.processingTime).map(s => s.processingTime);
  const avgProcessingTime = processingTimes.length > 0 
    ? (processingTimes.reduce((sum, time) => sum + time, 0) / processingTimes.length).toFixed(1)
    : 0;
  
  const metrics = {
    totalSignals: signals.length,
    totalTrades: totalTrades,
    successfulTrades: successfulTrades,
    failedTrades: failedTrades,
    successRate: totalTrades > 0 ? ((successfulTrades / totalTrades) * 100).toFixed(1) : 0,
    averageProcessingTime: `${avgProcessingTime}ms`,
    maxProcessingTime: processingTimes.length > 0 ? `${Math.max(...processingTimes)}ms` : '0ms',
    minProcessingTime: processingTimes.length > 0 ? `${Math.min(...processingTimes)}ms` : '0ms',
    lastSignalTime: signals.length > 0 ? signals[signals.length - 1].timestamp : 'Nunca',
    serverUptime: `${Math.floor(process.uptime() / 60)} minutos`,
    memoryUsage: {
      used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
      total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)} MB`
    },
    apiConfigured: !!(process.env.BINGX_API_KEY && process.env.BINGX_API_SECRET),
    webhookSecretConfigured: !!process.env.WEBHOOK_SECRET
  };
  
  res.json({
    ok: true,
    metrics: metrics,
    recentSignals: lastSignals,
    timestamp: new Date().toISOString()
  });
};
