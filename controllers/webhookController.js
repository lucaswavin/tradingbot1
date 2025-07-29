exports.handleWebhook = async (req, res) => {
  const data = req.body;
  if (!global.botState) global.botState = { signals: [] };
  global.botState.signals.push({
    ...data,
    timestamp: new Date().toLocaleString()
  });
  res.json({ success: true, message: 'Señal recibida', data });
};

