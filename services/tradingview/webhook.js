module.exports = function validateTradingViewPayload(payload) {
  // Añade validaciones según tus necesidades
  if (!payload.symbol || !payload.action) return false;
  return true;
};
