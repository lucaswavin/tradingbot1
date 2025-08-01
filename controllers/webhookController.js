require('dotenv').config();
const {
  placeOrder,
  getUSDTBalance,
  closeAllPositions,
  getCurrentPrice
} = require('../services/bingx/api');

// ======== DASHBOARD SIGNAL HANDLER =========

exports.handleWebhook = async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('\n📨 ===== WEBHOOK RECIBIDO =====');
    const data = req.body;
    console.log('📋 Datos completos del webhook:', JSON.stringify(data, null, 2));
    res.json({ success: true, message: 'Señal recibida', data, receivedAt: startTime });
    setImmediate(() => processSignalForDashboard(data, startTime));
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
    if (global.botState.signals.length > 50) {
      global.botState.signals = global.botState.signals.slice(-50);
    }
    console.log(`📊 Señal guardada en dashboard. Total señales: ${global.botState.signals.length}`);
    console.log('==============================\n');
  } catch (error) {
    console.error('❌ Error procesando señal dashboard:', error);
  }
}

// ======== WEBHOOK DE TRADING ULTRA FLEXIBLE =========

exports.handleTradingViewWebhook = async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('\n🚀 ===== TRADING WEBHOOK RECIBIDO =====');
    const data = req.body;
    console.log('📋 Datos del trading webhook:', JSON.stringify(data, null, 2));
    res.json({
      ok: true,
      received: true,
      message: 'Trading signal received and processing',
      timestamp: startTime
    });
    setImmediate(() => processTradingSignalOptimized(data, startTime));
  } catch (error) {
    console.error('❌ Error crítico en trading webhook:', error);
    res.status(500).json({
      ok: false,
      msg: 'Error crítico en el bot',
      error: error.message
    });
  }
};

// ========== NÚCLEO LÓGICO: PROCESA Y ENVÍA ORDEN ==========

async function processTradingSignalOptimized(body, startTime) {
  console.log('\n🔧 === PROCESANDO SEÑAL DE TRADING ===');
  
  // Extraer TODOS los parámetros posibles
  const {
    symbol,
    side,
    webhook_secret,
    action,
    qty,
    quantity,
    strategy,
    leverage = 5,
    usdtAmount = 1,
    // TP/SL en porcentaje
    tpPercent,
    slPercent,
    tp_percent,
    sl_percent,
    // TP/SL en precio absoluto
    takeProfit,
    stopLoss,
    tpPrice,
    slPrice,
    tp_price,
    sl_price,
    take_profit,
    stop_loss,
    // Otros parámetros
    type = 'MARKET',
    limitPrice,
    limit_price,
    trailing,
    trailingPercent,
    trailing_percent,
    reduceOnly,
    reduce_only,
    positionSide,
    position_side,
    closeOnTrigger,
    close_on_trigger,
    ...rest
  } = body;

  try {
    console.log('🔍 Parámetros extraídos:');
    console.log(`   Symbol: ${symbol}`);
    console.log(`   Side: ${side}`);
    console.log(`   Action: ${action}`);
    console.log(`   Leverage: ${leverage}`);
    console.log(`   USD Amount: ${usdtAmount}`);
    console.log(`   TP Percent: ${tpPercent || tp_percent || 'No'}`);
    console.log(`   SL Percent: ${slPercent || sl_percent || 'No'}`);
    console.log(`   TP Price: ${takeProfit || tpPrice || tp_price || take_profit || 'No'}`);
    console.log(`   SL Price: ${stopLoss || slPrice || sl_price || stop_loss || 'No'}`);

    // SECRET VALIDATION
    if (process.env.WEBHOOK_SECRET && webhook_secret !== process.env.WEBHOOK_SECRET) {
      console.log('❌ Webhook secret inválido');
      await saveErrorRecord(body, 'Webhook secret inválido', startTime);
      return;
    }

    // BASIC VALIDATION
    if (!symbol || !side) {
      console.log('❌ Faltan parámetros requeridos: symbol y side');
      await saveErrorRecord(body, 'Faltan parámetros requeridos: symbol y side', startTime);
      return;
    }

    // DUPLICATE PREVENTION
    const signalId = `${symbol}_${action || side}_${Date.now()}`;
    if (
      global.lastTradingSignalId === signalId &&
      global.lastTradingSignalTime &&
      Date.now() - global.lastTradingSignalTime < 1000
    ) {
      console.log('⚠️ Señal de trading duplicada ignorada');
      return;
    }
    global.lastTradingSignalId = signalId;
    global.lastTradingSignalTime = Date.now();

    // DETERMINAR ACCIÓN: BUY/SELL/CLOSE
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

    // VERIFICAR BALANCE si es una orden de apertura
    let balance = 0;
    let balancePromise = null;
    if (actionToTake.includes('open')) {
      console.log('\n--- VERIFICANDO BALANCE ---');
      balancePromise = getUSDTBalance().catch(() => 0);
    }

    // ========== EXECUTE ACTION ==========
    console.log('\n--- EJECUTANDO ACCIÓN ---');
    let response;
    
    try {
      if (actionToTake === 'close') {
        console.log('🔒 CERRANDO POSICIÓN');
        response = await closeAllPositions(symbol);

      } else if (actionToTake === 'open_long' || actionToTake === 'open_short') {
        // Esperar balance
        if (balancePromise) {
          balance = await balancePromise;
          console.log(`💰 Balance verificado: ${balance} USDT`);
          
          const minBalance = 2;
          if (balance < minBalance) {
            console.log(`❌ BALANCE INSUFICIENTE: ${balance} < ${minBalance} USDT`);
            await saveSignalRecord(body, actionToTake, orderSide, null, balance, false, 'Balance insuficiente', startTime);
            return;
          }
          console.log('✅ Balance suficiente para operar');
        }

        // ====== CONSTRUIR PARÁMETROS DE ORDEN ======
        console.log('\n--- CONSTRUYENDO PARÁMETROS DE ORDEN ---');
        
        let orderParams = {
          symbol,
          side: orderSide,
          leverage: Number(leverage) || 5,
          usdtAmount: Number(usdtAmount) || 1,
          type: (type || 'MARKET').toUpperCase()
        };

        // Cantidad directa si se especifica
        if (qty) orderParams.quantity = Number(qty);
        if (quantity) orderParams.quantity = Number(quantity);

        // Precio límite para órdenes LIMIT
        if (limitPrice) orderParams.limitPrice = Number(limitPrice);
        if (limit_price) orderParams.limitPrice = Number(limit_price);

        // TP/SL en porcentaje (prioridad a snake_case)
        if (tp_percent) orderParams.tpPercent = Number(tp_percent);
        else if (tpPercent) orderParams.tpPercent = Number(tpPercent);

        if (sl_percent) orderParams.slPercent = Number(sl_percent);
        else if (slPercent) orderParams.slPercent = Number(slPercent);

        // TP/SL en precio absoluto (prioridad a snake_case)
        if (tp_price) orderParams.tpPrice = Number(tp_price);
        else if (tpPrice) orderParams.tpPrice = Number(tpPrice);
        else if (take_profit) orderParams.tpPrice = Number(take_profit);
        else if (takeProfit) orderParams.tpPrice = Number(takeProfit);

        if (sl_price) orderParams.slPrice = Number(sl_price);
        else if (slPrice) orderParams.slPrice = Number(slPrice);
        else if (stop_loss) orderParams.slPrice = Number(stop_loss);
        else if (stopLoss) orderParams.slPrice = Number(stopLoss);

        // Trailing stop
        if (trailing_percent) orderParams.trailingPercent = Number(trailing_percent);
        else if (trailingPercent) orderParams.trailingPercent = Number(trailingPercent);
        else if (trailing) orderParams.trailingPercent = Number(trailing);

        // Otros parámetros
        if (reduce_only !== undefined) orderParams.reduceOnly = reduce_only;
        else if (reduceOnly !== undefined) orderParams.reduceOnly = reduceOnly;

        if (position_side) orderParams.positionSide = position_side;
        else if (positionSide) orderParams.positionSide = positionSide;

        if (close_on_trigger !== undefined) orderParams.closeOnTrigger = close_on_trigger;
        else if (closeOnTrigger !== undefined) orderParams.closeOnTrigger = closeOnTrigger;

        // Agregar parámetros extras
        Object.assign(orderParams, rest);

        console.log('📋 Parámetros finales de la orden:');
        console.log(JSON.stringify(orderParams, null, 2));

        // EJECUTAR ORDEN
        console.log('\n🚀 Enviando orden a BingX...');
        response = await placeOrder(orderParams);

      } else {
        console.log('❓ ACCIÓN NO RECONOCIDA');
        await saveSignalRecord(body, actionToTake, orderSide, null, balance, false, 'Acción no reconocida', startTime);
        return;
      }

      // === PROCESAR RESPUESTA ===
      console.log('\n--- PROCESANDO RESPUESTA ---');
      console.log('📨 Respuesta completa:', JSON.stringify(response, null, 2));
      
      // Determinar si fue exitosa
      let orderSuccess = false;
      if (response) {
        // Para la nueva estructura de respuesta
        if (response.summary && response.summary.mainSuccess) {
          orderSuccess = true;
        }
        // Para respuesta simple
        else if (response.code === 0 || response.success === true) {
          orderSuccess = true;
        }
      }

      await saveSignalRecord(body, actionToTake, orderSide, response, balance, orderSuccess, null, startTime);

      if (orderSuccess) {
        console.log('✅ ACCIÓN EJECUTADA EXITOSAMENTE');
        if (response.summary) {
          console.log('📊 Resumen:');
          console.log(`   - Orden principal: ${response.summary.mainSuccess ? '✅' : '❌'}`);
          console.log(`   - Take Profit: ${response.summary.tpSuccess === null ? '⚪ No configurado' : response.summary.tpSuccess ? '✅' : '❌'}`);
          console.log(`   - Stop Loss: ${response.summary.slSuccess === null ? '⚪ No configurado' : response.summary.slSuccess ? '✅' : '❌'}`);
          console.log(`   - Leverage: ${response.summary.leverageSet ? '✅' : '⚠️'}`);
          console.log(`   - Cantidad: ${response.summary.executedQuantity}`);
          console.log(`   - Precio: ${response.summary.executedPrice}`);
        }
        if (response.data?.orderId || response.mainOrder?.data?.orderId) {
          console.log('🎉 Order ID:', response.data?.orderId || response.mainOrder?.data?.orderId);
        }
      } else {
        console.log('❌ ERROR EN LA RESPUESTA DE BINGX');
        console.log('📄 Error:', response?.msg || response?.message || 'Sin mensaje de error');
      }

    } catch (executionError) {
      console.log('❌ ERROR EN EJECUCIÓN:', executionError.message);
      console.error('💥 Stack trace:', executionError.stack);
      await saveSignalRecord(body, actionToTake, orderSide, null, balance, false, executionError.message, startTime);
    }

    console.log('=====================================');
    const totalLatency = Date.now() - startTime;
    console.log(`⚡ Tiempo total de procesamiento: ${totalLatency}ms\n`);

  } catch (error) {
    console.error('❌ Error crítico en procesamiento:', error);
    console.error('💥 Stack trace:', error.stack);
    await saveErrorRecord(body, error.message, startTime);
  }
}

// ====== GUARDADO DE RESULTADOS =======

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

// ======= UTILIDADES STATUS/METRICS =======
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
