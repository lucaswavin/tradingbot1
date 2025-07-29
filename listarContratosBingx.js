const axios = require('axios');

// Normaliza el symbol como hace tu bot
function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  let base = symbol.replace('.P', '');
  if (base.endsWith('USDT')) {
    base = base.replace(/USDT$/, '-USDT');
  }
  return base;
}

async function listarContratosBingX() {
  const url = `https://open-api.bingx.com/openApi/swap/v2/quote/contracts`;
  const res = await axios.get(url);

  if (!res.data.data) {
    console.error("No se pudo obtener la lista de contratos.");
    return;
  }

  // Lista ordenada y limpia
  res.data.data
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .forEach(c => {
      console.log(
        `🔸 ${c.symbol} | lotSize: ${c.lotSize} | leverage: ${c.maxLeverage}x | status: ${c.status} | name: ${c.symbolName}`
      );
    });

  // Si quieres ver un contrato concreto:
  const buscar = "BTC-USDT";
  const info = res.data.data.find(c => c.symbol === buscar);
  if (info) {
    console.log("\n=== INFO DETALLADA DEL PAR ===");
    console.log(info);
  }
}

listarContratosBingX();
