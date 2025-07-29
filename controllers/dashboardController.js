const { getUSDTBalance } = require('../services/bingx/api');

exports.dashboard = async (req, res) => {
  let usdtBalance = '-';
  let bingxConnected = false;
  try {
    usdtBalance = await getUSDTBalance();
    bingxConnected = true;
  } catch (e) {
    usdtBalance = '-';
    bingxConnected = false;
  }

  const signals = global.botState?.signals || [];
  const lastSignals = signals.slice(-5).reverse();

  res.send(`
    <html>
      <head>
        <title>🤖 Trading Bot + BingX</title>
        <meta charset="UTF-8" />
        <style>
          body { font-family: Arial, sans-serif; max-width: 700px; margin: 40px auto; background: #f5f5f5; }
          .container { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
          .status { margin-bottom: 20px; }
          .status.connected { color: green; }
          .status.disconnected { color: red; }
          .webhook-url { background:#e3f2fd; padding:10px; border-radius:5px; font-family:monospace; }
          .signal { background: #fafafa; margin: 10px 0; padding: 10px; border-radius: 6px; border-left: 4px solid #007bff;}
          button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer;}
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🤖 Trading Bot + BingX</h1>
          <div class="status ${bingxConnected ? 'connected' : 'disconnected'}">
            <b>BingX:</b> ${bingxConnected ? 'Conectado' : 'No conectado'}
          </div>
          <div>
            <b>Balance:</b> <span style="font-size:1.2em;">${usdtBalance} USDT</span>
            <form method="POST" action="/api/refresh-balance" style="display:inline;">
              <button type="submit">Actualizar Balance</button>
            </form>
          </div>
          <hr/>
          <div>
            <b>Webhook URL para TradingView:</b>
            <div class="webhook-url">https://${req.headers.host}/webhook</div>
          </div>
          <hr/>
          <div>
            <h2>Últimas señales</h2>
            ${lastSignals.length === 0
              ? '<p>No hay señales recientes.</p>'
              : lastSignals.map(s => `
                  <div class="signal">
                    <b>${s.action || '-'}</b> <b>${s.symbol || '-'}</b> @ ${s.timestamp || ''}
                    <br/><small>${JSON.stringify(s.data || s, null, 2)}</small>
                  </div>
                `).join('')
            }
          </div>
        </div>
      </body>
    </html>
  `);
};
