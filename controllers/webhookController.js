const bingxService = require('../services/bingx/api');
const SECRET = process.env.WEBHOOK_SECRET || 'CAMBIAR_POR_TU_SECRET';

exports.handleWebhook = async (req, res) => {
  const data = req.body;
  if (!data.secret || data.secret !== SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const orderResult = await bingxService.executeOrder(data);
    res.json({ success: true, bingxResult: orderResult });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
};
