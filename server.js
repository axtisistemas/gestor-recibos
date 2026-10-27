require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const pool = require('./db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'cambia_esto',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 horas
  })
);

app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}

function setFlash(req, tipo, mensaje) {
  req.session.flash = { tipo, mensaje };
}

// Envuelve rutas async para que un error no tumbe el servidor
const ruta = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------
// Utilidades de fechas y dinero
// ---------------------------------------------------------------------
function inicioDelDia(fecha) {
  const f = new Date(fecha);
  f.setHours(0, 0, 0, 0);
  return f;
}

function formatoFecha(f) {
  const y = f.getFullYear();
  const m = String(f.getMonth() + 1).padStart(2, '0');
  const d = String(f.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseFecha(texto) {
  const [y, m, d] = String(texto).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function sumarDias(fecha, dias) {
  const f = new Date(fecha);
  f.setDate(f.getDate() + dias);
  return f;
}

function ultimoDiaDelMes(anio, mesIndex0) {
  return new Date(anio, mesIndex0 + 1, 0).getDate();
}

// Día 31 en un mes de 30 días -> día 30, etc.
function fechaVencimientoEnMes(diaCobro, anio, mesIndex0) {
  return new Date(anio, mesIndex0, Math.min(diaCobro, ultimoDiaDelMes(anio, mesIndex0)));
}

const aCentavos = (v) => Math.round(Number(v || 0) * 100);
const deCentavos = (c) => (c / 100).toFixed(2);

// ---------------------------------------------------------------------
// Configuración de cobros
// Días de anticipación con que se genera el recibo antes de su vencimiento,
// según la frecuencia. Puedes ajustar estos números a tu gusto.
// ---------------------------------------------------------------------
const DIAS_ANTICIPACION = { mensual: 10, quincenal: 5, semanal: 2, diaria: 0 };
const INTERVALO_DIAS = { quincenal: 15, semanal: 7, diaria: 1 };
const FRECUENCIAS = ['diaria', 'semanal', 'quincenal', 'mensual'];

// ---------------------------------------------------------------------
// Saldo a favor: se aplica a los recibos pendientes más antiguos primero
// ---------------------------------------------------------------------
async function aplicarSaldoFavor(clienteId) {
  const conn = await pool.getConnection();
  let aplicadoTotal = 0;
  try {
    await conn.beginTransaction();
    const [[cliente]] = await conn.query('SELECT saldo_favor FROM clientes WHERE id = ? FOR UPDATE', [clienteId]);
    if (cliente) {
      let saldo = aCentavos(cliente.saldo_favor);
      if (saldo > 0) {
        const [recibos] = await conn.query(
          `SELECT id, monto, saldo_aplicado FROM recibos_emitidos
           WHERE cliente_id = ? AND estado = 'pendiente'
           ORDER BY fecha_vencimiento ASC, id ASC
           FOR UPDATE`,
          [clienteId]
        );
        for (const r of recibos) {
          if (saldo <= 0) break;
          const yaAplicado = aCentavos(r.saldo_aplicado);
          const restante = aCentavos(r.monto) - yaAplicado;
          if (restante <= 0) continue;
          const aplicar = Math.min(saldo, restante);
          const estado = aplicar >= restante ? 'pagado' : 'pendiente';
          await conn.query('UPDATE recibos_emitidos SET saldo_aplicado = ?, estado = ? WHERE id = ?', [
            deCentavos(yaAplicado + aplicar),
            estado,
            r.id
          ]);
          saldo -= aplicar;
          aplicadoTotal += aplicar;
        }
        await conn.query('UPDATE clientes SET saldo_favor = ? WHERE id = ?', [deCentavos(saldo), clienteId]);
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return aplicadoTotal / 100;
}

// ---------------------------------------------------------------------
// Generación de recibos
// ---------------------------------------------------------------------
async function insertarRecibo(servicio, numeroCuota, fechaEmision, fechaVencimiento) {
  const [r] = await pool.query(
    `INSERT IGNORE INTO recibos_emitidos
       (servicio_id, cliente_id, monto, numero_cuota, fecha_emision, fecha_vencimiento, estado)
     VALUES (?, ?, ?, ?, ?, ?, 'pendiente')`,
    [servicio.id, servicio.cliente_id, servicio.monto, numeroCuota, fechaEmision, fechaVencimiento]
  );
  return r.affectedRows > 0;
}

// Próximo ciclo mensual sin recibo (nunca anterior a la fecha de alta del servicio)
async function proximoCicloMensual(servicio, hoy) {
  const alta = servicio.creado_en ? inicioDelDia(parseFecha(servicio.creado_en)) : null;
  let cursor = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  for (let i = 0; i < 3; i++) {
    const vencimiento = fechaVencimientoEnMes(servicio.dia_cobro_mensual, cursor.getFullYear(), cursor.getMonth());
    if (!alta || vencimiento >= alta) {
      const [existentes] = await pool.query(
        'SELECT id FROM recibos_emitidos WHERE servicio_id = ? AND fecha_vencimiento = ?',
        [servicio.id, formatoFecha(vencimiento)]
      );
      if (existentes.length === 0) return vencimiento;
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return null;
}

let verificando = false;

async function verificarCobrosDelDia() {
  const resumen = { generados: 0, finalizados: 0, saldoAplicado: 0 };
  if (verificando) return resumen;
  verificando = true;

  try {
    const hoy = inicioDelDia(new Date());
    const fechaHoy = formatoFecha(hoy);
    const clientesAfectados = new Set();

    const [servicios] = await pool.query(
      `SELECT * FROM servicios_contratados WHERE activo = 1 AND tipo IN ('recurrente', 'parcialidad')`
    );

    for (const s of servicios) {
      const esParcialidad = s.tipo === 'parcialidad';
      const frecuencia = esParcialidad && FRECUENCIAS.includes(s.frecuencia) ? s.frecuencia : 'mensual';

      if (esParcialidad && s.parcialidades_pagadas >= s.total_parcialidades) {
        await pool.query('UPDATE servicios_contratados SET activo = 0 WHERE id = ?', [s.id]);
        resumen.finalizados++;
        continue;
      }

      if (frecuencia === 'mensual') {
        if (!s.dia_cobro_mensual) continue;
        const vencimiento = await proximoCicloMensual(s, hoy);
        if (!vencimiento || hoy < sumarDias(vencimiento, -DIAS_ANTICIPACION.mensual)) continue;

        const cuota = esParcialidad ? s.parcialidades_pagadas + 1 : null;
        const creado = await insertarRecibo(s, cuota, fechaHoy, formatoFecha(vencimiento));
        if (!creado) continue;

        resumen.generados++;
        clientesAfectados.add(s.cliente_id);

        if (esParcialidad) {
          const sigueActivo = cuota < s.total_parcialidades ? 1 : 0;
          await pool.query('UPDATE servicios_contratados SET parcialidades_pagadas = ?, activo = ? WHERE id = ?', [
            cuota,
            sigueActivo,
            s.id
          ]);
          if (!sigueActivo) resumen.finalizados++;
        }
      } else {
        // Parcialidades diarias, semanales o quincenales a partir de fecha_inicio
        if (!s.fecha_inicio) continue;
        const inicio = parseFecha(s.fecha_inicio);
        const intervalo = INTERVALO_DIAS[frecuencia];
        const anticipacion = DIAS_ANTICIPACION[frecuencia];

        let generadas = s.parcialidades_pagadas;
        let nuevas = 0;
        while (generadas < s.total_parcialidades && nuevas < 400) {
          const vencimiento = sumarDias(inicio, generadas * intervalo);
          if (hoy < sumarDias(vencimiento, -anticipacion)) break;
          await insertarRecibo(s, generadas + 1, fechaHoy, formatoFecha(vencimiento));
          generadas++;
          nuevas++;
        }

        if (nuevas > 0) {
          const sigueActivo = generadas < s.total_parcialidades ? 1 : 0;
          await pool.query('UPDATE servicios_contratados SET parcialidades_pagadas = ?, activo = ? WHERE id = ?', [
            generadas,
            sigueActivo,
            s.id
          ]);
          resumen.generados += nuevas;
          clientesAfectados.add(s.cliente_id);
          if (!sigueActivo) resumen.finalizados++;
        }
      }
    }

    for (const clienteId of clientesAfectados) {
      resumen.saldoAplicado += await aplicarSaldoFavor(clienteId);
    }
  } finally {
    verificando = false;
  }

  return resumen;
}

// ---------------------------------------------------------------------
// Autenticación
// ---------------------------------------------------------------------
app.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/clientes');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE username = ?', [username]);
    const usuario = rows[0];
    if (!usuario || !(await bcrypt.compare(password, usuario.password_hash))) {
      return res.render('login', { error: 'Usuario o contraseña incorrectos.' });
    }
    req.session.usuario = { id: usuario.id, username: usuario.username };
    res.redirect('/clientes');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Error del servidor. Intenta de nuevo.' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireAuth, (req, res) => res.redirect('/clientes'));

// ---------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------
app.get('/clientes', requireAuth, ruta(async (req, res) => {
  const [clientes] = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM servicios_contratados s WHERE s.cliente_id = c.id AND s.activo = 1) AS servicios_activos
     FROM clientes c
     ORDER BY c.nombre ASC`
  );
  res.render('clientes', { clientes });
}));

app.post('/clientes', requireAuth, ruta(async (req, res) => {
  const { nombre, whatsapp, direccion, notas } = req.body;
  if (!nombre || !whatsapp) {
    setFlash(req, 'error', 'Nombre y WhatsApp son obligatorios.');
    return res.redirect('/clientes');
  }
  await pool.query('INSERT INTO clientes (nombre, whatsapp, direccion, notas) VALUES (?, ?, ?, ?)', [
    nombre,
    whatsapp,
    direccion || null,
    notas || null
  ]);
  setFlash(req, 'ok', 'Cliente creado correctamente.');
  res.redirect('/clientes');
}));

app.post('/clientes/:id/actualizar', requireAuth, ruta(async (req, res) => {
  const { nombre, whatsapp, direccion, notas } = req.body;
  await pool.query('UPDATE clientes SET nombre = ?, whatsapp = ?, direccion = ?, notas = ? WHERE id = ?', [
    nombre,
    whatsapp,
    direccion || null,
    notas || null,
    req.params.id
  ]);
  setFlash(req, 'ok', 'Cliente actualizado.');
  res.redirect('/clientes/' + req.params.id);
}));

app.post('/clientes/:id/eliminar', requireAuth, ruta(async (req, res) => {
  await pool.query('DELETE FROM clientes WHERE id = ?', [req.params.id]);
  setFlash(req, 'ok', 'Cliente eliminado.');
  res.redirect('/clientes');
}));

app.get('/clientes/:id', requireAuth, ruta(async (req, res) => {
  const [clienteRows] = await pool.query('SELECT * FROM clientes WHERE id = ?', [req.params.id]);
  if (clienteRows.length === 0) return res.redirect('/clientes');

  const [servicios] = await pool.query(
    'SELECT * FROM servicios_contratados WHERE cliente_id = ? ORDER BY activo DESC, creado_en DESC',
    [req.params.id]
  );
  const [abonos] = await pool.query(
    'SELECT * FROM abonos_cliente WHERE cliente_id = ? ORDER BY fecha DESC, id DESC LIMIT 20',
    [req.params.id]
  );
  const [[adeudo]] = await pool.query(
    `SELECT COALESCE(SUM(monto - saldo_aplicado), 0) AS total
     FROM recibos_emitidos WHERE cliente_id = ? AND estado = 'pendiente'`,
    [req.params.id]
  );

  res.render('cliente_detalle', {
    cliente: clienteRows[0],
    servicios,
    abonos,
    adeudo: Number(adeudo.total),
    hoy: formatoFecha(new Date())
  });
}));

// Abono / adelanto: suma al saldo a favor y se aplica a recibos pendientes
app.post('/clientes/:id/abonos', requireAuth, ruta(async (req, res) => {
  const clienteId = req.params.id;
  const monto = Number(req.body.monto);
  if (!(monto > 0)) {
    setFlash(req, 'error', 'Ingresa un monto de abono válido.');
    return res.redirect('/clientes/' + clienteId);
  }

  await pool.query('INSERT INTO abonos_cliente (cliente_id, monto, nota, fecha) VALUES (?, ?, ?, ?)', [
    clienteId,
    monto.toFixed(2),
    req.body.nota || null,
    formatoFecha(new Date())
  ]);
  await pool.query('UPDATE clientes SET saldo_favor = saldo_favor + ? WHERE id = ?', [monto.toFixed(2), clienteId]);

  const aplicado = await aplicarSaldoFavor(clienteId);
  setFlash(
    req,
    'ok',
    aplicado > 0
      ? `Abono de $${monto.toFixed(2)} registrado. Se aplicaron $${aplicado.toFixed(2)} a recibos pendientes.`
      : `Abono de $${monto.toFixed(2)} registrado como saldo a favor.`
  );
  res.redirect('/clientes/' + clienteId);
}));

// ---------------------------------------------------------------------
// Servicios / Planes
// ---------------------------------------------------------------------
app.post('/clientes/:id/servicios', requireAuth, ruta(async (req, res) => {
  const clienteId = req.params.id;
  const { nombre_servicio, tipo, monto, total_parcialidades, dia_cobro_mensual, frecuencia, fecha_inicio } = req.body;
  const volver = () => res.redirect('/clientes/' + clienteId);

  if (!nombre_servicio || !['unico', 'recurrente', 'parcialidad'].includes(tipo) || !(Number(monto) > 0)) {
    setFlash(req, 'error', 'Completa nombre, tipo y monto del servicio.');
    return volver();
  }

  const esParcialidad = tipo === 'parcialidad';
  const freq = esParcialidad && FRECUENCIAS.includes(frecuencia) ? frecuencia : 'mensual';
  const usaDiaMensual = tipo !== 'unico' && freq === 'mensual';
  const usaFechaInicio = esParcialidad && freq !== 'mensual';

  if (esParcialidad && !(Number(total_parcialidades) >= 1)) {
    setFlash(req, 'error', 'Indica el número total de parcialidades.');
    return volver();
  }
  if (usaDiaMensual && !(Number(dia_cobro_mensual) >= 1 && Number(dia_cobro_mensual) <= 31)) {
    setFlash(req, 'error', 'Indica el día del mes para cobrar (1 a 31).');
    return volver();
  }
  if (usaFechaInicio && !fecha_inicio) {
    setFlash(req, 'error', 'Indica la fecha de la primera cuota.');
    return volver();
  }

  const [result] = await pool.query(
    `INSERT INTO servicios_contratados
       (cliente_id, nombre_servicio, tipo, frecuencia, monto, total_parcialidades, parcialidades_pagadas,
        dia_cobro_mensual, fecha_inicio, activo)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1)`,
    [
      clienteId,
      nombre_servicio,
      tipo,
      freq,
      monto,
      esParcialidad ? Number(total_parcialidades) : null,
      usaDiaMensual ? Number(dia_cobro_mensual) : null,
      usaFechaInicio ? fecha_inicio : null
    ]
  );

  if (tipo === 'unico') {
    const fechaHoy = formatoFecha(new Date());
    await insertarRecibo({ id: result.insertId, cliente_id: clienteId, monto }, null, fechaHoy, fechaHoy);
    await pool.query('UPDATE servicios_contratados SET activo = 0 WHERE id = ?', [result.insertId]);
    await aplicarSaldoFavor(clienteId);
  } else {
    // Genera de una vez los recibos que ya estén dentro de su ventana de cobro
    await verificarCobrosDelDia();
  }

  setFlash(req, 'ok', 'Servicio agregado correctamente.');
  volver();
}));

app.post('/servicios/:id/eliminar', requireAuth, ruta(async (req, res) => {
  const [rows] = await pool.query('SELECT cliente_id FROM servicios_contratados WHERE id = ?', [req.params.id]);
  await pool.query('DELETE FROM servicios_contratados WHERE id = ?', [req.params.id]);
  setFlash(req, 'ok', 'Servicio eliminado.');
  res.redirect(rows[0] ? '/clientes/' + rows[0].cliente_id : '/clientes');
}));

app.post('/servicios/:id/toggle', requireAuth, ruta(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM servicios_contratados WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.redirect('/clientes');
  const servicio = rows[0];
  await pool.query('UPDATE servicios_contratados SET activo = ? WHERE id = ?', [servicio.activo ? 0 : 1, servicio.id]);
  res.redirect('/clientes/' + servicio.cliente_id);
}));

// ---------------------------------------------------------------------
// Recibos
// ---------------------------------------------------------------------
app.get('/recibos', requireAuth, ruta(async (req, res) => {
  const [recibos] = await pool.query(`
    SELECT r.*, c.nombre AS cliente_nombre, c.whatsapp AS cliente_whatsapp,
           s.nombre_servicio, s.tipo, s.frecuencia, s.total_parcialidades
    FROM recibos_emitidos r
    JOIN clientes c ON c.id = r.cliente_id
    JOIN servicios_contratados s ON s.id = r.servicio_id
    ORDER BY r.fecha_vencimiento DESC, r.id DESC
  `);
  res.render('recibos', { recibos });
}));

app.post('/recibos/:id/pagar', requireAuth, ruta(async (req, res) => {
  await pool.query(`UPDATE recibos_emitidos SET estado = 'pagado' WHERE id = ?`, [req.params.id]);
  setFlash(req, 'ok', 'Recibo marcado como pagado.');
  res.redirect('/recibos');
}));

// Reabrir: vuelve a pendiente y devuelve al cliente el saldo a favor que se había usado
app.post('/recibos/:id/reabrir', requireAuth, ruta(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[recibo]] = await conn.query('SELECT * FROM recibos_emitidos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (recibo) {
      if (aCentavos(recibo.saldo_aplicado) > 0) {
        await conn.query('UPDATE clientes SET saldo_favor = saldo_favor + ? WHERE id = ?', [
          recibo.saldo_aplicado,
          recibo.cliente_id
        ]);
      }
      await conn.query(`UPDATE recibos_emitidos SET estado = 'pendiente', saldo_aplicado = 0 WHERE id = ?`, [recibo.id]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  setFlash(req, 'ok', 'Recibo reabierto.');
  res.redirect('/recibos');
}));

app.post('/recibos/verificar-cobros', requireAuth, ruta(async (req, res) => {
  const resumen = await verificarCobrosDelDia();
  let mensaje = `Verificación completa: ${resumen.generados} recibo(s) generado(s), ${resumen.finalizados} servicio(s) finalizado(s).`;
  if (resumen.saldoAplicado > 0) mensaje += ` Se aplicaron $${resumen.saldoAplicado.toFixed(2)} de saldo a favor.`;
  setFlash(req, 'ok', mensaje);
  res.redirect('/recibos');
}));

// Manejo de errores general
app.use((err, req, res, next) => {
  console.error(err);
  if (req.session) setFlash(req, 'error', 'Ocurrió un error: ' + err.message);
  res.redirect(req.headers.referer || '/clientes');
});

// ---------------------------------------------------------------------
// Verificación automática: al arrancar y luego cada hora
// ---------------------------------------------------------------------
async function verificacionAutomatica() {
  try {
    const r = await verificarCobrosDelDia();
    if (r.generados || r.finalizados) {
      console.log(`[auto] ${r.generados} recibo(s) generado(s), ${r.finalizados} servicio(s) finalizado(s).`);
    }
  } catch (err) {
    console.error('[auto] Error verificando cobros:', err.message);
  }
}
setTimeout(verificacionAutomatica, 10 * 1000);
setInterval(verificacionAutomatica, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de gestión de recibos escuchando en el puerto ${PORT}`);
});
