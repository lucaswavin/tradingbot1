const { describe, it, expect, beforeEach, vi } = require('vitest');

// Mock de las dependencias
vi.mock('axios');
vi.mock('crypto');

const axios = require('axios');
const crypto = require('crypto');

// Import del módulo a testear
const {
  modifyPositionTPSL,
  placeOrder,
  closeAllPositions,
  getUSDTBalance
} = require('../services/bingx/api');

describe('🚀 BingX API Trading Bot Tests', () => {
  
  beforeEach(() => {
    // Limpiar todos los mocks antes de cada test
    vi.clearAllMocks();
    
    // Mock básico de crypto
    crypto.createHmac = vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn(() => 'mocked_signature')
    }));
    
    // Mock básico de axios
    axios.create = vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn()
    }));
  });

  describe('⚡ modifyPositionTPSL - Ultra Fast', () => {
    
    it('🧪 debería modificar TP/SL con cancelación paralela', async () => {
      // 🎭 ARRANGE - Preparar mocks
      const mockPosition = {
        size: 13.2,
        availableSize: 13.2,
        entryPrice: 0.152642,
        side: 'LONG'
      };
      
      const mockExistingOrders = [
        { orderId: '1953203874928615424', type: 'STOP_MARKET', stopPrice: '0.148830', symbol: 'DOLO-USDT' },
        { orderId: '1953203874651791360', type: 'TAKE_PROFIT_MARKET', stopPrice: '0.156460', symbol: 'DOLO-USDT' }
      ];
      
      const mockContract = {
        minOrderQty: 0.001,
        tickSize: 0.00001,
        stepSize: 0.001,
        minNotional: 1,
        maxLeverage: 20
      };

      // Mock de las funciones internas
      const mockSendRequest = vi.fn()
        .mockResolvedValueOnce({ code: 0, data: [mockPosition] }) // getPositionDetails
        .mockResolvedValueOnce({ code: 0, data: { orders: mockExistingOrders } }) // getExistingTPSLOrders
        .mockResolvedValueOnce({ code: 0, data: [mockContract] }) // getContractInfo
        .mockResolvedValueOnce({ code: 0 }) // cancel order 1
        .mockResolvedValueOnce({ code: 0 }) // cancel order 2
        .mockResolvedValueOnce({ code: 0, data: { orderId: 'new_tp_order' } }) // create TP
        .mockResolvedValueOnce({ code: 0, data: { orderId: 'new_sl_order' } }); // create SL

      // Reemplazar la función sendRequest internamente
      vi.doMock('../services/bingx/api', async () => {
        const actual = await vi.importActual('../services/bingx/api');
        return {
          ...actual,
          sendRequest: mockSendRequest
        };
      });

      // 🎬 ACT - Ejecutar la función
      const result = await modifyPositionTPSL({
        symbol: 'DOLO-USDT',
        side: 'BUY',
        tpPercent: 5,
        slPercent: 4
      });

      // 🔍 ASSERT - Verificar resultados
      expect(result.summary.mainSuccess).toBe(true);
      expect(result.summary.finalTPStatus).toBe(true);
      expect(result.summary.finalSLStatus).toBe(true);
      expect(result.summary.optimized).toBe(true);
      expect(result.summary.parallelProcessing).toBe(true);
    });

    it('🧪 debería fallar si no encuentra posición', async () => {
      const mockSendRequest = vi.fn()
        .mockResolvedValueOnce({ code: 0, data: [] }); // No position found

      await expect(modifyPositionTPSL({
        symbol: 'BTCUSDT',
        side: 'BUY',
        tpPercent: 5,
        slPercent: 3
      })).rejects.toThrow('No se encontró una posición LONG abierta para BTC-USDT');
    });
  });

  describe('🎯 placeOrder - Reentradas Inteligentes', () => {
    
    it('🧪 debería ejecutar reentrada con herencia de TP/SL', async () => {
      // 🎭 ARRANGE
      const mockExistingPosition = {
        exists: true,
        side: 'LONG',
        size: 26.4,
        entryPrice: 0.151115,
        isReentry: true
      };

      const mockExistingOrders = [
        { orderId: '123', type: 'TAKE_PROFIT_MARKET', stopPrice: '0.155398' },
        { orderId: '456', type: 'STOP_MARKET', stopPrice: '0.146832' }
      ];

      const mockFinalPosition = {
        size: 39.6,
        availableSize: 39.6,
        entryPrice: 0.151268,
        side: 'LONG'
      };

      // Mock sequence
      const mockSendRequest = vi.fn()
        .mockResolvedValueOnce({ code: 0, data: [mockExistingPosition] }) // checkExistingPosition
        .mockResolvedValueOnce({ code: 0, data: { orders: mockExistingOrders } }) // getExistingTPSLOrders
        .mockResolvedValueOnce({ code: 0 }) // setLeverage
        .mockResolvedValueOnce({ code: 0, data: { orderId: 'main_order_123' } }) // main order
        .mockResolvedValueOnce({ code: 0 }) // cancel old TP
        .mockResolvedValueOnce({ code: 0 }) // cancel old SL
        .mockResolvedValueOnce({ code: 0, data: [mockFinalPosition] }) // final position
        .mockResolvedValueOnce({ code: 0, data: { orderId: 'new_tp' } }) // new TP
        .mockResolvedValueOnce({ code: 0, data: { orderId: 'new_sl' } }); // new SL

      // 🎬 ACT - Reentrada SIN especificar nuevos TP/SL (debería heredar)
      const result = await placeOrder({
        symbol: 'DOLO-USDT',
        side: 'BUY',
        leverage: 2,
        usdtAmount: 1
        // Sin tpPercent ni slPercent - debería heredar los existentes
      });

      // 🔍 ASSERT
      expect(result.mainOrder.code).toBe(0);
      expect(result.finalPosition.size).toBe(39.6);
      expect(mockSendRequest).toHaveBeenCalledTimes(9);
    });

    it('🧪 debería ejecutar reentrada con nuevos TP/SL', async () => {
      // Similar al anterior pero CON tpPercent y slPercent especificados
      const result = await placeOrder({
        symbol: 'DOLO-USDT',
        side: 'BUY',
        leverage: 2,
        usdtAmount: 1,
        tpPercent: 5,
        slPercent: 6
      });

      // Debería usar los nuevos porcentajes, no los heredados
      expect(result.mainOrder.code).toBe(0);
    });
  });

  describe('💰 getUSDTBalance', () => {
    
    it('🧪 debería retornar balance correctamente', async () => {
      const mockSendRequest = vi.fn()
        .mockResolvedValueOnce({
          code: 0,
          data: { balance: { balance: '1234.56' } }
        });

      const balance = await getUSDTBalance();

      expect(balance).toBe(1234.56);
      expect(mockSendRequest).toHaveBeenCalledWith('GET', '/openApi/swap/v2/user/balance', {});
    });

    it('🧪 debería retornar 0 si hay error', async () => {
      const mockSendRequest = vi.fn()
        .mockResolvedValueOnce({ code: -1, msg: 'Error' });

      const balance = await getUSDTBalance();

      expect(balance).toBe(0);
    });
  });

  describe('🚫 closeAllPositions', () => {
    
    it('🧪 debería cerrar posiciones correctamente', async () => {
      const mockSendRequest = vi.fn()
        .mockResolvedValueOnce({
          code: 0,
          msg: 'Success'
        });

      const result = await closeAllPositions('DOLO-USDT');

      expect(result.code).toBe(0);
      expect(mockSendRequest).toHaveBeenCalledWith(
        'POST', 
        '/openApi/swap/v2/trade/closeAllPositions', 
        { symbol: 'DOLO-USDT' }
      );
    });
  });

  describe('🔧 Helper Functions', () => {
    
    it('🧪 normalizeSymbol debería normalizar símbolos correctamente', () => {
      const { normalizeSymbol } = require('../services/bingx/api');
      
      expect(normalizeSymbol('BTCUSDT')).toBe('BTC-USDT');
      expect(normalizeSymbol('ETHUSDT.P')).toBe('ETH-USDT');
      expect(normalizeSymbol('BTC-USDT')).toBe('BTC-USDT'); // Ya normalizado
    });

    it('🧪 validateWebhookData debería validar datos correctamente', () => {
      const { validateWebhookData } = require('../services/bingx/api');
      
      expect(() => validateWebhookData({
        symbol: 'BTCUSDT',
        side: 'BUY'
      })).not.toThrow();

      expect(() => validateWebhookData({
        symbol: 'BTCUSDT'
        // Falta side
      })).toThrow('Campos requeridos faltantes: symbol y side');
    });
  });

  describe('⚡ Performance Tests', () => {
    
    it('🧪 modifyPositionTPSL debería completarse en menos de 5 segundos', async () => {
      const startTime = Date.now();
      
      // Mock rápido
      const mockSendRequest = vi.fn()
        .mockResolvedValue({ code: 0, data: {} });

      try {
        await modifyPositionTPSL({
          symbol: 'BTCUSDT',
          side: 'BUY',
          tpPercent: 3,
          slPercent: 2
        });
      } catch (e) {
        // Ignorar errores, solo medir tiempo
      }

      const executionTime = Date.now() - startTime;
      expect(executionTime).toBeLessThan(5000); // Menos de 5 segundos
    });
  });

  describe('🛡️ Error Handling', () => {
    
    it('🧪 debería manejar errores de API correctamente', async () => {
      const mockSendRequest = vi.fn()
        .mockRejectedValueOnce(new Error('Network error'));

      await expect(modifyPositionTPSL({
        symbol: 'BTCUSDT',
        side: 'BUY',
        tpPercent: 5,
        slPercent: 3
      })).rejects.toThrow();
    });
  });

});

// 🎯 Tests de integración simulados
describe('🌐 Integration Tests (Mocked)', () => {
  
  it('🧪 flujo completo: crear posición → modificar TP/SL → cerrar', async () => {
    console.log('🚀 Simulando flujo completo de trading...');
    
    // 1. Crear posición
    const orderResult = await placeOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      leverage: 5,
      usdtAmount: 10,
      tpPercent: 3,
      slPercent: 2
    });
    
    // 2. Modificar TP/SL
    const modifyResult = await modifyPositionTPSL({
      symbol: 'BTCUSDT',
      side: 'BUY',
      tpPercent: 5,
      slPercent: 4
    });
    
    // 3. Cerrar posición
    const closeResult = await closeAllPositions('BTC-USDT');
    
    expect(orderResult).toBeDefined();
    expect(modifyResult).toBeDefined();
    expect(closeResult).toBeDefined();
    
    console.log('✅ Flujo completo simulado exitosamente');
  });
});
