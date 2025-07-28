// === SERVIDOR RAILWAY PARA TRADING BOT ===
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// === CONFIGURACIÓN ===
const CONFIG = {
    // TradingView
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || 'tu_clave_secreta_123',
    
    // BingX API
    BINGX_API_KEY: process.env.BINGX_API_KEY,
    BINGX_SECRET_KEY: process.env.BINGX_SECRET_KEY,
    BINGX_BASE_URL: 'https://open-api.bingx.com',
    
    // Trading
    DEFAULT_SYMBOL: 'BTC-USDT',
    DEFAULT_LEVERAGE: 5,
    DEFAULT_CAPITAL: 1
};

// === VARIABLES DE ESTADO ===
let tradingState = {
    isActive: false,
    currentPosition: null,
    scheduledTrades: [],
    tradeHistory: []
};

// === UTILIDADES BINGX ===
function createBingXSignature(params, secretKey) {
    const queryString = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
    
    return crypto
        .createHmac('sha256', secretKey)
        .update(queryString)
        .digest('hex');
}

async function bingXRequest(endpoint, params = {}, method = 'GET') {
    if (!CONFIG.BINGX_API_KEY || !CONFIG.BINGX_SECRET_KEY) {
        throw new Error('BingX API keys no configuradas');
    }

    const timestamp = Date.now();
    const requestParams = {
        ...params,
        timestamp
    };

    const signature = createBingXSignature(requestParams, CONFIG.BINGX_SECRET_KEY);
    requestParams.signature = signature;

    const url = `${CONFIG.BINGX_BASE_URL}${endpoint}`;
    
    try {
        const response = await axios({
            method,
            url,
            [method === 'GET' ? 'params' : 'data']: requestParams,
            headers: {
                'X-BX-APIKEY': CONFIG.BINGX_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    } catch (error) {
        console.error('Error BingX:', error.response?.data || error.message);
        throw error;
    }
}

// === FUNCIONES DE TRADING ===
async function executeOrder(signal) {
    console.log('🎯 Ejecutando orden:', signal);
    
    try {
        // Validar señal
        if (!signal.symbol || !signal.side || !signal.capital) {
            throw new Error('Señal incompleta');
        }

        // Calcular cantidad
        const marketPrice = await getMarketPrice(signal.symbol);
        const positionValue = signal.capital * (signal.leverage || CONFIG.DEFAULT_LEVERAGE);
        const quantity = (positionValue / marketPrice).toFixed(6);

        // Configurar apalancamiento
        await bingXRequest('/openApi/swap/v2/trade/leverage', {
            symbol: signal.symbol,
            side: 'BOTH',
            leverage: signal.leverage || CONFIG.DEFAULT_LEVERAGE
        }, 'POST');

        // Ejecutar orden
        const orderParams = {
            symbol: signal.symbol,
            side: signal.side, // BUY o SELL
            type: 'MARKET',
            quantity: quantity,
            timestamp: Date.now()
        };

        const orderResult = await bingXRequest('/openApi/swap/v2/trade/order', orderParams, 'POST');
        
        // Guardar estado
        tradingState.currentPosition = {
            orderId: orderResult.orderId,
            symbol: signal.symbol,
            side: signal.side,
            quantity: quantity,
            price: marketPrice,
            timestamp: new Date(),
            candles: 0,
            maxCandles: signal.exitAfterCandles || 5
        };

        // Guardar en historial
        tradingState.tradeHistory.push({
            type: 'ENTRY',
            ...tradingState.currentPosition,
            signal: signal
        });

        console.log('✅ Orden ejecutada:', orderResult);
        return orderResult;

    } catch (error) {
        console.error('❌ Error ejecutando orden:', error);
        throw error;
    }
}

async function getMarketPrice(symbol) {
    try {
        const response = await bingXRequest('/openApi/swap/v2/quote/price', { symbol });
        return parseFloat(response.price);
    } catch (error) {
        console.error('Error obteniendo precio:', error);
        throw error;
    }
}

async function closePosition() {
    if (!tradingState.currentPosition) {
        return { message: 'No hay posición abierta' };
    }

    try {
        const position = tradingState.currentPosition;
        
        // Cerrar posición
        const closeParams = {
            symbol: position.symbol,
            side: position.side === 'BUY' ? 'SELL' : 'BUY',
            type: 'MARKET',
            quantity: position.quantity,
            timestamp: Date.now()
        };

        const closeResult = await bingXRequest('/openApi/swap/v2/trade/order', closeParams, 'POST');
        
        // Calcular resultado
        const currentPrice = await getMarketPrice(position.symbol);
        let pnlPercent = 0;
        
        if (position.side === 'BUY') {
            pnlPercent = ((currentPrice - position.price) / position.price) * 100;
        } else {
            pnlPercent = ((position.price - currentPrice) / position.price) * 100;
        }

        // Guardar resultado
        tradingState.tradeHistory.push({
            type: 'EXIT',
            orderId: closeResult.orderId,
            symbol: position.symbol,
            price: currentPrice,
            pnlPercent: pnlPercent,
            timestamp: new Date(),
            candles: position.candles
        });

        console.log(`✅ Posición cerrada. PnL: ${pnlPercent.toFixed(2)}%`);
        
        tradingState.currentPosition = null;
        return closeResult;

    } catch (error) {
        console.error('❌ Error cerrando posición:', error);
        throw error;
    }
}

// === RUTAS API ===

// Webhook de TradingView
app.post('/webhook', async (req, res) => {
    try {
        const signal = req.body;
        
        // Validar clave secreta
        if (signal.secret !== CONFIG.WEBHOOK_SECRET) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        console.log('📡 Webhook recibido:', signal);
        
        // Ejecutar según tipo de señal
        if (signal.action === 'ENTRY') {
            await executeOrder(signal);
            res.json({ success: true, message: 'Orden ejecutada' });
        } else if (signal.action === 'EXIT') {
            await closePosition();
            res.json({ success: true, message: 'Posición cerrada' });
        } else {
            res.status(400).json({ error: 'Acción no válida' });
        }

    } catch (error) {
        console.error('Error webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Estado del bot
app.get('/api/status', (req, res) => {
    res.json({
        isActive: tradingState.isActive,
        currentPosition: tradingState.currentPosition,
        tradeHistory: tradingState.tradeHistory.slice(-10) // Últimos 10
    });
});

// Configurar bot
app.post('/api/config', (req, res) => {
    const { isActive } = req.body;
    tradingState.isActive = isActive;
    
    console.log(`🤖 Bot ${isActive ? 'activado' : 'desactivado'}`);
    res.json({ success: true, isActive: tradingState.isActive });
});

// Cerrar posición manual
app.post('/api/close', async (req, res) => {
    try {
        const result = await closePosition();
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Historial de trades
app.get('/api/history', (req, res) => {
    res.json(tradingState.tradeHistory);
});

// Test de conexión BingX
app.get('/api/test-bingx', async (req, res) => {
    try {
        const serverTime = await bingXRequest('/openApi/swap/v2/server/time');
        res.json({ success: true, serverTime });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === PÁGINA PRINCIPAL ===
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Trading Bot - Status</title>
        <meta charset="UTF-8">
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            .status { padding: 10px; border-radius: 5px; margin: 10px 0; }
            .active { background: #d4edda; color: #155724; }
            .inactive { background: #f8d7da; color: #721c24; }
            .position { background: #fff3cd; color: #856404; }
            button { padding: 10px 20px; margin: 5px; border: none; border-radius: 5px; cursor: pointer; }
            .btn-primary { background: #007bff; color: white; }
            .btn-danger { background: #dc3545; color: white; }
        </style>
    </head>
    <body>
        <h1>🤖 Trading Bot Control Panel</h1>
        
        <div id="status">
            <div class="status inactive">
                <h3>Estado: Cargando...</h3>
            </div>
        </div>
        
        <div>
            <button class="btn-primary" onclick="toggleBot()">Activar/Desactivar Bot</button>
            <button class="btn-danger" onclick="closePosition()">Cerrar Posición</button>
            <button class="btn-primary" onclick="testBingX()">Test BingX</button>
        </div>
        
        <h3>📊 Historial Reciente</h3>
        <div id="history"></div>
        
        <script>
            async function loadStatus() {
                try {
                    const response = await fetch('/api/status');
                    const data = await response.json();
                    
                    const statusDiv = document.getElementById('status');
                    statusDiv.innerHTML = \`
                        <div class="status \${data.isActive ? 'active' : 'inactive'}">
                            <h3>Estado: \${data.isActive ? 'Activo' : 'Inactivo'}</h3>
                        </div>
                        \${data.currentPosition ? \`
                        <div class="status position">
                            <h3>Posición Abierta:</h3>
                            <p>Símbolo: \${data.currentPosition.symbol}</p>
                            <p>Lado: \${data.currentPosition.side}</p>
                            <p>Velas: \${data.currentPosition.candles}/\${data.currentPosition.maxCandles}</p>
                        </div>
                        \` : '<div class="status inactive"><h3>Sin posición abierta</h3></div>'}
                    \`;
                    
                    // Mostrar historial
                    const historyDiv = document.getElementById('history');
                    historyDiv.innerHTML = data.tradeHistory.map(trade => \`
                        <div class="status">
                            <strong>\${trade.type}</strong> - \${trade.symbol} - 
                            \${new Date(trade.timestamp).toLocaleString()}
                            \${trade.pnlPercent ? \` - PnL: \${trade.pnlPercent.toFixed(2)}%\` : ''}
                        </div>
                    \`).join('');
                    
                } catch (error) {
                    console.error('Error loading status:', error);
                }
            }
            
            async function toggleBot() {
                try {
                    const response = await fetch('/api/status');
                    const current = await response.json();
                    
                    await fetch('/api/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ isActive: !current.isActive })
                    });
                    
                    loadStatus();
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function closePosition() {
                try {
                    await fetch('/api/close', { method: 'POST' });
                    alert('Posición cerrada');
                    loadStatus();
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }
            
            async function testBingX() {
                try {
                    const response = await fetch('/api/test-bingx');
                    const data = await response.json();
                    alert('BingX conectado correctamente');
                } catch (error) {
                    alert('Error BingX: ' + error.message);
                }
            }
            
            // Cargar estado cada 5 segundos
            setInterval(loadStatus, 5000);
            loadStatus();
        </script>
    </body>
    </html>
    `);
});

// === INICIAR SERVIDOR ===
app.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
    console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`🎛️ Panel: http://localhost:${PORT}`);
});

module.exports = app;
