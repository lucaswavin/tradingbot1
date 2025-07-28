const express = require('express');
const app = express();

// Railway requiere HOST y PORT específicos
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.get('/', (req, res) => {
  res.send('✅ Tu servidor Railway está funcionando 🎉');
});

// IMPORTANTE: Escuchar en 0.0.0.0, no localhost
app.listen(PORT, HOST, () => {
  console.log(`🚀 Servidor escuchando en ${HOST}:${PORT}`);
});
