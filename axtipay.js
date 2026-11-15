// ---------------------------------------------------------------------
// Integración con AxtiPay (pay.axti.mx)
//
// - Cada recibo pendiente tiene su link de pago por el saldo que le falta.
// - Cada cliente con 2 o más recibos pendientes tiene un link de "saldo total".
// - Cuando un recibo ya no se debe (se pagó por fuera, se aplicó saldo a favor),
//   su link se cancela en AxtiPay para evitar pagos dobles.
// - AxtiPay avisa a /api/axtipay/webhook cuando un link se paga.
//
// Referencias que se mandan a AxtiPay:
//   R-<reciboId>-<seq>    link de un recibo
//   C-<clienteId>-<seq>   link de saldo total del cliente
// "seq" sube cada vez que un link termina (pagado o cancelado), para que el
// siguiente cobro sea un link nuevo.
// ---------------------------------------------------------------------
const crypto = require('crypto');

const config = {
  url: (process.env.AXTIPAY_URL || 'https://pay.axti.mx').replace(/\/+$/, ''),
  integration: process.env.AXTIPAY_INTEGRATION || 'gestor',
  secret: process.env.AXTIPAY_SECRET || '',
};

const activo = () => Boolean(config.secret);
const aCentavos = (v) => Math.round(Number(v || 0) * 100);
const deCentavos = (c) => (c / 100).toFixed(2);
const telefono = (t) => String(t || '').replace(/\D/g, '').slice(-10);

function firmar(cuerpo, ts = Math.floor(Date.now() / 1000)) {
  const hmac = crypto.createHmac('sha256', config.secret).update(`${ts}.${cuerpo}`).digest('hex');
  return `t=${ts},v1=${hmac}`;
}

// Verifica el encabezado X-AxtiPay-Signature de un aviso recibido.
function verificarFirma(cuerpoCrudo, encabezado) {
  if (!activo()) return false;
  const partes = Object.fromEntries(
    String(encabezado || '').split(',').map((p) => p.trim().split('=', 2)).filter((p) => p.length === 2)
  );
  const ts = Number(partes.t);
  if (!ts || !partes.v1 || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const esperado = crypto.createHmac('sha256', config.secret).update(`${ts}.${cuerpoCrudo}`).digest('hex');
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(partes.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function llamar(datos) {
  const cuerpo = JSON.stringify(datos);
  const res = await fetch(`${config.url}/api/v1/links`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'AxtiPay-Gestor/1.0',
      'x-axtipay-integration': config.integration,
      'x-axtipay-signature': firmar(cuerpo),
    },
    body: cuerpo,
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function conceptoRecibo(r) {
  const base = r.tipo === 'parcialidad' && r.total_parcialidades
    ? `${r.nombre_servicio} (cuota ${r.numero_cuota} de ${r.total_parcialidades})`
    : r.nombre_servicio;
  return base.slice(0, 120);
}

// ---------------------------------------------------------------------
// Sincronización: crea, actualiza o cancela links según el estado actual
// ---------------------------------------------------------------------
// Las sincronizaciones se forman en fila para que nunca corran dos a la vez.
let cola = Promise.resolve();

function sincronizar(pool) {
  if (!activo()) return Promise.resolve({ omitido: true });
  const tarea = cola.then(() => ejecutarSincronizacion(pool));
  cola = tarea.catch(() => {});
  return tarea;
}

async function ejecutarSincronizacion(pool) {
  const resumen = { creados: 0, actualizados: 0, cancelados: 0, errores: 0 };

  // --- Links por recibo ---
  const [recibos] = await pool.query(`
    SELECT r.*, c.nombre AS cliente_nombre, c.whatsapp AS cliente_whatsapp,
           s.nombre_servicio, s.tipo, s.total_parcialidades
    FROM recibos_emitidos r
    JOIN clientes c ON c.id = r.cliente_id
    JOIN servicios_contratados s ON s.id = r.servicio_id
    WHERE r.estado = 'pendiente' OR r.axtipay_url IS NOT NULL
  `);

  for (const r of recibos) {
    const restante = aCentavos(r.monto) - aCentavos(r.saldo_aplicado);
    const ref = `R-${r.id}-${r.axtipay_seq}`;
    try {
      if (r.estado === 'pendiente' && restante > 0) {
        if (r.axtipay_url && aCentavos(r.axtipay_monto) === restante) continue;
        const link = await llamar({
          external_ref: ref,
          amount: deCentavos(restante),
          concept: conceptoRecibo(r),
          client: r.cliente_nombre,
          client_phone: telefono(r.cliente_whatsapp),
        });
        if (link.status === 'pending') {
          await pool.query('UPDATE recibos_emitidos SET axtipay_url = ?, axtipay_monto = ? WHERE id = ?', [
            link.url, deCentavos(restante), r.id,
          ]);
          resumen[r.axtipay_url ? 'actualizados' : 'creados']++;
        } else {
          // El link ya se pagó o canceló en AxtiPay: se usa uno nuevo en la siguiente vuelta.
          await pool.query(
            'UPDATE recibos_emitidos SET axtipay_url = NULL, axtipay_monto = NULL, axtipay_seq = axtipay_seq + 1 WHERE id = ?',
            [r.id]
          );
        }
      } else if (r.axtipay_url) {
        await llamar({ external_ref: ref, cancel: true });
        await pool.query(
          'UPDATE recibos_emitidos SET axtipay_url = NULL, axtipay_monto = NULL, axtipay_seq = axtipay_seq + 1 WHERE id = ?',
          [r.id]
        );
        resumen.cancelados++;
      }
    } catch (err) {
      resumen.errores++;
      console.error(`[axtipay] recibo ${r.id}:`, err.message);
    }
  }

  // --- Link de saldo total por cliente (2 o más recibos pendientes) ---
  const [clientes] = await pool.query(`
    SELECT c.id, c.nombre, c.whatsapp, c.axtipay_cuenta_url, c.axtipay_cuenta_monto, c.axtipay_seq,
           COALESCE(SUM(CASE WHEN r.estado = 'pendiente' THEN r.monto - r.saldo_aplicado END), 0) AS adeudo,
           COALESCE(SUM(CASE WHEN r.estado = 'pendiente' AND r.monto - r.saldo_aplicado > 0 THEN 1 ELSE 0 END), 0) AS pendientes
    FROM clientes c
    LEFT JOIN recibos_emitidos r ON r.cliente_id = c.id
    GROUP BY c.id
    HAVING pendientes >= 2 OR c.axtipay_cuenta_url IS NOT NULL
  `);

  for (const c of clientes) {
    const adeudo = aCentavos(c.adeudo);
    const ref = `C-${c.id}-${c.axtipay_seq}`;
    try {
      if (Number(c.pendientes) >= 2 && adeudo > 0) {
        if (c.axtipay_cuenta_url && aCentavos(c.axtipay_cuenta_monto) === adeudo) continue;
        const link = await llamar({
          external_ref: ref,
          amount: deCentavos(adeudo),
          concept: `Saldo pendiente (${c.pendientes} recibos)`,
          client: c.nombre,
          client_phone: telefono(c.whatsapp),
        });
        if (link.status === 'pending') {
          await pool.query('UPDATE clientes SET axtipay_cuenta_url = ?, axtipay_cuenta_monto = ? WHERE id = ?', [
            link.url, deCentavos(adeudo), c.id,
          ]);
          resumen[c.axtipay_cuenta_url ? 'actualizados' : 'creados']++;
        } else {
          await pool.query(
            'UPDATE clientes SET axtipay_cuenta_url = NULL, axtipay_cuenta_monto = NULL, axtipay_seq = axtipay_seq + 1 WHERE id = ?',
            [c.id]
          );
        }
      } else if (c.axtipay_cuenta_url) {
        await llamar({ external_ref: ref, cancel: true });
        await pool.query(
          'UPDATE clientes SET axtipay_cuenta_url = NULL, axtipay_cuenta_monto = NULL, axtipay_seq = axtipay_seq + 1 WHERE id = ?',
          [c.id]
        );
        resumen.cancelados++;
      }
    } catch (err) {
      resumen.errores++;
      console.error(`[axtipay] cliente ${c.id}:`, err.message);
    }
  }

  return resumen;
}

// Sincroniza sin detener la respuesta si AxtiPay tarda o falla.
function sincronizarEnSegundoPlano(pool) {
  if (!activo()) return;
  sincronizar(pool).catch((err) => console.error('[axtipay] sincronización:', err.message));
}

// Cancela en AxtiPay los links de recibos o clientes que se van a borrar.
async function cancelarLinks(referencias) {
  if (!activo()) return;
  for (const ref of referencias) {
    try {
      await llamar({ external_ref: ref, cancel: true });
    } catch (err) {
      console.error(`[axtipay] cancelar ${ref}:`, err.message);
    }
  }
}

function parseReferencia(ref) {
  const m = /^([RC])-(\d+)-(\d+)$/.exec(String(ref || ''));
  return m ? { tipo: m[1], id: Number(m[2]), seq: Number(m[3]) } : null;
}

module.exports = {
  config,
  activo,
  verificarFirma,
  sincronizar,
  sincronizarEnSegundoPlano,
  cancelarLinks,
  parseReferencia,
};
