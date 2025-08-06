require('dotenv').config();
const {
  placeOrder,
  getUSDTBalance,
  closeAllPositions,
  getCurrentPrice,
  modifyPositionTPSL // <-- (1) IMPORTACIÓN AÑADIDA
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
  
  const {
    symbol, side, webhook_secret, action, qty, quantity, strategy,
    leverage = 5, usdtAmount = 1, tpPercent, slPercent, tp_percent, sl_percent,
    takeProfit, stopLoss, tpPrice, slPrice, tp_price, sl_price, take_profit, stop_loss,
    type = 'MARKET', limitPrice, limit_price, trailing, trailingPercent, trailing_percent,
    reduceOnly, reduce_only, positionSide, position_side, closeOnTrigger, close_on_trigger,
    ...rest
  } = body;

  try {
    console.log('🔍 Parámetros extraídos:');
    console.log(`   Symbol: ${symbol}, Side: ${side}, Action: ${action || 'open'}`);

    if (process.env.WEBHOOK_SECRET && webhook_secret !== process.env.WEBHOOK_SECRET) {
      console.log('❌ Webhook secret inválido');
      await saveErrorRecord(body, 'Webhook secret inválido', startTime);
      return;
    }

    if (!symbol || !side) {
      console.log('❌ Faltan parámetros requeridos: symbol y side');
      await saveErrorRecord(body, 'Faltan parámetros requeridos: symbol y side', startTime);
      return;
    }

    // DETERMINAR ACCIÓN: BUY/SELL/CLOSE/MODIFY
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
      } else if (actionLower.includes('modify_tpsl')) { // <-- (2) LÓGICA DE ACCIÓN AÑADIDA
        actionToTake = 'modify_tpsl';
      }
    }
    
    if (actionToTake === 'unknown') {
      const sideUpper = side.toUpperCase();
      switch (sideUpper) {
        case 'BUY': case 'LONG':
          actionToTake = 'open_long'; orderSide = 'BUY'; break;
        case 'SELL': case 'SHORT':
          actionToTake = 'open_short'; orderSide = 'SELL'; break;
        case 'CLOSE': case 'EXIT':
          actionToTake = 'close'; break;
      }
    }
    
    console.log(`✅ Acción determinada: ${actionToTake}`);

    // ========== EXECUTE ACTION ==========
    console.log('\n--- EJECUTANDO ACCIÓN ---');
    let response;
    
    try {
      if (actionToTake === 'close') {
        console.log('🔒 CERRANDO POSICIÓN');
        response = await closeAllPositions(symbol);

      } else if (actionToTake === 'modify_tpsl') { // <-- (3) BLOQUE DE EJECUCIÓN AÑADIDO
        console.log('🔄 MODIFICANDO TP/SL DE POSICIÓN EXISTENTE');
        const newTpPercent = tpPercent || tp_percent;
        const newSlPercent = slPercent || sl_percent;
        
        response = await modifyPositionTPSL({
            symbol,
            side, // El 'side' original (BUY/SELL) nos dice si es LONG o SHORT
            tpPercent: newTpPercent ? Number(newTpPercent) : null,
            slPercent: newSlPercent ? Number(newSlPercent) : null,
        });

      } else if (actionToTake === 'open_long' || actionToTake === 'open_short') {
        let balance = 0;
        console.log('\n--- VERIFICANDO BALANCE ---');
        balance = await getUSDTBalance().catch(() => 0);
        
        const minBalance = 2;
        if (balance < minBalance) {
          console.log(`❌ BALANCE INSUFICIENTE: ${balance} < ${minBalance} USDT`);
          await saveSignalRecord(body, actionToTake, orderSide, null, balance, false, 'Balance insuficiente', startTime);
          return;
        }
        console.log(`💰 Balance verificado: ${balance} USDT. ✅ Suficiente para operar.`);

        console.log('\n--- CONSTRUYENDO PARÁMETROS DE ORDEN ---');
        
        let orderParams = {
          symbol, side: orderSide, leverage: Number(leverage) || 5,
          usdtAmount: Number(usdtAmount) || 1, type: (type || 'MARKET').toUpperCase()
        };
        
        if (tp_percent) orderParams.tpPercent = Number(tp_percent); else if (tpPercent) orderParams.tpPercent = Number(tpPercent);
        if (sl_percent) orderParams.slPercent = Number(sl_percent); else if (slPercent) orderParams.slPercent = Number(slPercent);
        // ... (resto de tus parámetros) ...
        
        console.log('📋 Parámetros finales de la orden:', JSON.stringify(orderParams, null, 2));

        console.log('\n🚀 Enviando orden a BingX...');
        response = await placeOrder(orderParams);

      } else {
        console.log('❓ ACCIÓN NO RECONOCIDA');
        await saveSignalRecord(body, actionToTake, orderSide, null, 0, false, 'Acción no reconocida', startTime);
        return;
      }

      console.log('\n--- PROCESANDO RESPUESTA ---');
      console.log('📨 Respuesta completa:', JSON.stringify(response, null, 2));
      
      let orderSuccess = !!(response?.code === 0 || response?.success === true || response?.summary?.mainSuccess);
      await saveSignalRecord(body, actionToTake, orderSide, response, 0, orderSuccess, response?.msg || response?.error || null, startTime);

      if (orderSuccess) {
        console.log('✅ ACCIÓN EJECUTADA EXITOSAMENTE');
      } else {
        console.log('❌ ERROR EN LA RESPUESTA DE BINGX');
        console.log('📄 Error:', response?.msg || response?.error || 'Sin mensaje de error');
      }

    } catch (executionError) {
      console.log('❌ ERROR EN EJECUCIÓN:', executionError.message);
      console.error('💥 Stack trace:', executionError.stack);
      await saveSignalRecord(body, actionToTake, orderSide, null, 0, false, executionError.message, startTime);
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

// ====== GUARDADO DE RESULTADOS (SIN CAMBIOS) =======
async function saveSignalRecord(requestBody, actionTaken, orderSide, response, balance, orderSuccess, errorMessage, startTime) {
    try {
      if (!global.botState) global.botState = { signals: [] };
      const signalRecord = {
        symbol: requestBody.symbol,
        side: requestBody.side ? requestBody.side.toUpperCase() : 'UNKNOWN',
        action: requestBody.action || requestBody.side,
        actionTaken, orderSide,
        timestamp: new Date().toLocaleString(),
        receivedAt: new Date().toISOString(),
        data: requestBody,
        bingxResponse: response,
        tradingExecuted: true,
        balance: balance || null,
        orderSuccess,
        error: errorMessage,
        processingTime: Date.now() - startTime
      };
      global.botState.signals.push(signalRecord);
      if (global.botState.signals.length > 50) {
        global.botState.signals = global.botState.signals.slice(-50);
      }
      console.log(`📊 Señal/Evento guardado en dashboard. Total: ${global.botState.signals.length}`);
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

// ======= UTILIDADES STATUS/METRICS (SIN CAMBIOS) =======
// (Aquí va todo tu código de testConnection, getStatus y getMetrics, que no necesita cambios)
exports.testConnection = async (req, res) => {
    // Tu código original
};
exports.getStatus = (req, res) => {
    // Tu código original
};
exports.getMetrics = (req, res) => {
    // Tu código original
};
