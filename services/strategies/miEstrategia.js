function validarSenal(signal) {
  // Validación básica: solo opera si llegan TODOS los campos críticos
  if (
    !signal ||
    !signal.symbol ||
    !signal.side ||
    !['buy', 'sell'].includes(signal.side.toLowerCase()) ||
    !signal.price ||
    !signal.qty ||
    Number(signal.qty) <= 0
  ) {
    return false;
  }

  // Si solo quieres operar ciertos pares en BingX, descomenta esto:
  // if (!['BTCUSDT', 'ETHUSDT'].includes(signal.symbol.toUpperCase())) return false;

  // Si quieres filtrar por monto máximo:
  // if (Number(signal.qty) > 5) return false;

  // Si quieres filtrar por horario (solo operar entre 8h y 22h UTC):
  // const fecha = signal.timestamp ? new Date(Number(signal.timestamp)) : new Date();
  // const hora = fecha.getUTCHours();
  // if (hora < 8 || hora > 22) return false;

  // Puedes meter logs para debugging si quieres:
  // console.log('Señal aceptada:', signal);

  return true;
}

module.exports = { validarSenal };
