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
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'cambia_esto',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8 // 8 horas
    }
  })
);

// Hace disponible el usuario logueado y mensajes flash simples en todas las vistas
app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.usuario) {
    return res.redirect('/login');
  }
  next();
}

function setFlash(req, tipo, mensaje) {
  req.session.flash = { tipo, mensaje };
}

// ---------------------------------------------------------------------
// Lógica de facturación (generación de recibos recurrentes / parcialidades)
// Los recibos se generan DIAS_ANTICIPACION días antes de la fecha de
// vencimiento (día de cobro mensual del servicio), no el mismo día.
// ---------------------------------------------------------------------
const DIAS_ANTICIPACION = 10;

function inicioDelDia(fecha) {
  const f = new Date(fecha);
  f.setHours(0, 0, 0, 0);
  return f;
}

function formatoFecha(fecha) {
  return fecha.toISOString().slice(0, 10); // YYYY-MM-DD
}

function ultimoDiaDelMes(anio, mesIndex0) {
  return new Date(anio, mesIndex0 + 1, 0).getDate();
}

// Calcula la fecha de vencimiento de un mes/año dado, ajustando el día
// si el mes no tiene suficientes días (ej. día 31 en febrero -> día 28/29).
function fechaVencimientoEnMes(diaCobro, anio, mesIndex0) {
  const dia = Math.min(diaCobro, ultimoDiaDelMes(anio, mesIndex0));
  return new Date(anio, mesIndex0, dia);
}

function sumarDias(fecha, dias) {
  const f = new Date(fecha);
  f.setDate(f.getDate() + dias);
  return f;
}

// Busca el próximo ciclo de cobro (fecha de vencimiento) de un servicio que
// todavía no tenga un recibo generado. Revisa hasta 3 meses hacia adelante
// como margen de seguridad por si el sistema estuvo un tiempo sin revisarse.
async function proximoCicloPendiente(servicio, hoy) {
  let cursor = new Date(hoy.getFullYear(), hoy.getMonth(), 1);

  for (let i = 0; i < 3; i++) {
    const vencimiento = fechaVencimientoEnMes(servicio.dia_cobro_mensual, cursor.getFullYear(), cursor.getMonth());
    const [existentes] = await pool.query(
      `SELECT id FROM recibos_emitidos WHERE servicio_id = ? AND fecha_vencimiento = ?`,
      [servicio.id, formatoFecha(vencimiento)]
    );
    if (existentes.length === 0) {
      return vencimiento;
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return null;
}

async function verificarCobrosDelDia() {
  const hoy = inicioDelDia(new Date());
  const fechaHoy = formatoFecha(hoy);

  const resumen = { generados: 0, finalizados: 0, omitidos: 0 };

  const [servicios] = await pool.query(
    `SELECT * FROM servicios_contratados
     WHERE activo = 1
       AND tipo IN ('recurrente', 'parcialidad')
       AND dia_cobro_mensual IS NOT NULL`
  );

  for (const servicio of servicios) {
    if (servicio.tipo === 'parcialidad' && servicio.parcialidades_pagadas >= servicio.total_parcialidades) {
      await pool.query(`UPDATE servicios_contratados SET activo = 0 WHERE id = ?`, [servicio.id]);
      resumen.finalizados++;
      continue;
    }

    const vencimiento = await proximoCicloPendiente(servicio, hoy);
    if (!vencimiento) {
      resumen.omitidos++;
      continue;
    }

    const fechaGeneracion = inicioDelDia(sumarDias(vencimiento, -DIAS_ANTICIPACION));

    if (hoy < fechaGeneracion) {
      // Aún no es momento de generar el recibo de este ciclo
      resumen.omitidos++;
      continue;
    }

    const fechaVencimientoStr = formatoFecha(vencimiento);

    if (servicio.tipo === 'parcialidad') {
      const nuevaCuota = servicio.parcialidades_pagadas + 1;

      await pool.query(
        `INSERT INTO recibos_emitidos (servicio_id, cliente_id, monto, numero_cuota, fecha_emision, fecha_vencimiento, estado)
         VALUES (?, ?, ?, ?, ?, ?, 'pendiente')`,
        [servicio.id, servicio.cliente_id, servicio.monto, nuevaCuota, fechaHoy, fechaVencimientoStr]
      );

      const sigueActivo = nuevaCuota < servicio.total_parcialidades ? 1 : 0;
      await pool.query(
        `UPDATE servicios_contratados SET parcialidades_pagadas = ?, activo = ? WHERE id = ?`,
        [nuevaCuota, sigueActivo, servicio.id]
      );

      resumen.generados++;
      if (!sigueActivo) resumen.finalizados++;
    } else {
      await pool.query(
        `INSERT INTO recibos_emitidos (servicio_id, cliente_id, monto, numero_cuota, fecha_emision, fecha_vencimiento, estado)
         VALUES (?, ?, ?, NULL, ?, ?, 'pendiente')`,
        [servicio.id, servicio.cliente_id, servicio.monto, fechaHoy, fechaVencimientoStr]
      );
      resumen.generados++;
    }
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

    if (!usuario) {
      return res.render('login', { error: 'Usuario o contraseña incorrectos.' });
    }

    const coincide = await bcrypt.compare(password, usuario.password_hash);
    if (!coincide) {
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
app.get('/clientes', requireAuth, async (req, res) => {
  const [clientes] = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM servicios_contratados s WHERE s.cliente_id = c.id AND s.activo = 1) AS servicios_activos
     FROM clientes c
     ORDER BY c.nombre ASC`
  );
  res.render('clientes', { clientes });
});

app.post('/clientes', requireAuth, async (req, res) => {
  const { nombre, whatsapp, direccion, notas } = req.body;
  if (!nombre || !whatsapp) {
    setFlash(req, 'error', 'Nombre y WhatsApp son obligatorios.');
    return res.redirect('/clientes');
  }
  await pool.query(
    `INSERT INTO clientes (nombre, whatsapp, direccion, notas) VALUES (?, ?, ?, ?)`,
    [nombre, whatsapp, direccion || null, notas || null]
  );
  setFlash(req, 'ok', 'Cliente creado correctamente.');
  res.redirect('/clientes');
});

app.post('/clientes/:id/actualizar', requireAuth, async (req, res) => {
  const { nombre, whatsapp, direccion, notas } = req.body;
  await pool.query(
    `UPDATE clientes SET nombre = ?, whatsapp = ?, direccion = ?, notas = ? WHERE id = ?`,
    [nombre, whatsapp, direccion || null, notas || null, req.params.id]
  );
  setFlash(req, 'ok', 'Cliente actualizado.');
  res.redirect('/clientes/' + req.params.id);
});

app.post('/clientes/:id/eliminar', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM clientes WHERE id = ?', [req.params.id]);
  setFlash(req, 'ok', 'Cliente eliminado.');
  res.redirect('/clientes');
});

// Detalle de cliente: datos + servicios contratados
app.get('/clientes/:id', requireAuth, async (req, res) => {
  const [clienteRows] = await pool.query('SELECT * FROM clientes WHERE id = ?', [req.params.id]);
  if (clienteRows.length === 0) return res.redirect('/clientes');

  const [servicios] = await pool.query(
    `SELECT * FROM servicios_contratados WHERE cliente_id = ? ORDER BY activo DESC, creado_en DESC`,
    [req.params.id]
  );

  res.render('cliente_detalle', { cliente: clienteRows[0], servicios });
});

// ---------------------------------------------------------------------
// Servicios / Planes
// ---------------------------------------------------------------------
app.post('/clientes/:id/servicios', requireAuth, async (req, res) => {
  const clienteId = req.params.id;
  const { nombre_servicio, tipo, monto, total_parcialidades, dia_cobro_mensual } = req.body;

  if (!nombre_servicio || !tipo || !monto) {
    setFlash(req, 'error', 'Completa nombre, tipo y monto del servicio.');
    return res.redirect('/clientes/' + clienteId);
  }

  const esParcialidad = tipo === 'parcialidad';
  const esRecurrenteOParcialidad = tipo === 'recurrente' || tipo === 'parcialidad';

  const [result] = await pool.query(
    `INSERT INTO servicios_contratados
       (cliente_id, nombre_servicio, tipo, monto, total_parcialidades, parcialidades_pagadas, dia_cobro_mensual, activo)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1)`,
    [
      clienteId,
      nombre_servicio,
      tipo,
      monto,
      esParcialidad ? total_parcialidades || null : null,
      esRecurrenteOParcialidad ? dia_cobro_mensual || null : null
    ]
  );

  const servicioId = result.insertId;

  if (tipo === 'unico') {
    // Se genera el recibo inmediatamente, con vencimiento el mismo día
    const fechaHoy = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO recibos_emitidos (servicio_id, cliente_id, monto, numero_cuota, fecha_emision, fecha_vencimiento, estado)
       VALUES (?, ?, ?, NULL, ?, ?, 'pendiente')`,
      [servicioId, clienteId, monto, fechaHoy, fechaHoy]
    );
    // Un servicio único queda inactivo porque ya se cobró
    await pool.query(`UPDATE servicios_contratados SET activo = 0 WHERE id = ?`, [servicioId]);
  }

  setFlash(req, 'ok', 'Servicio agregado correctamente.');
  res.redirect('/clientes/' + clienteId);
});

app.post('/servicios/:id/eliminar', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT cliente_id FROM servicios_contratados WHERE id = ?', [req.params.id]);
  await pool.query('DELETE FROM servicios_contratados WHERE id = ?', [req.params.id]);
  setFlash(req, 'ok', 'Servicio eliminado.');
  res.redirect('/clientes/' + (rows[0] ? rows[0].cliente_id : ''));
});

app.post('/servicios/:id/toggle', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM servicios_contratados WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.redirect('/clientes');
  const servicio = rows[0];
  await pool.query('UPDATE servicios_contratados SET activo = ? WHERE id = ?', [servicio.activo ? 0 : 1, servicio.id]);
  res.redirect('/clientes/' + servicio.cliente_id);
});

// ---------------------------------------------------------------------
// Recibos
// ---------------------------------------------------------------------
app.get('/recibos', requireAuth, async (req, res) => {
  const filtro = req.query.estado === 'pagado' ? 'pagado' : req.query.estado === 'pendiente' ? 'pendiente' : null;

  let sql = `
    SELECT r.*, c.nombre AS cliente_nombre, c.whatsapp AS cliente_whatsapp,
           s.nombre_servicio, s.tipo, s.total_parcialidades
    FROM recibos_emitidos r
    JOIN clientes c ON c.id = r.cliente_id
    JOIN servicios_contratados s ON s.id = r.servicio_id
  `;
  const params = [];
  if (filtro) {
    sql += ' WHERE r.estado = ?';
    params.push(filtro);
  }
  sql += ' ORDER BY r.fecha_vencimiento ASC, r.id DESC';

  const [recibos] = await pool.query(sql, params);

  res.render('recibos', { recibos, filtro });
});

app.post('/recibos/:id/marcar-pagado', requireAuth, async (req, res) => {
  await pool.query(`UPDATE recibos_emitidos SET estado = 'pagado' WHERE id = ?`, [req.params.id]);
  setFlash(req, 'ok', 'Recibo marcado como pagado.');
  res.redirect(req.headers.referer || '/recibos');
});

app.post('/recibos/:id/marcar-pendiente', requireAuth, async (req, res) => {
  await pool.query(`UPDATE recibos_emitidos SET estado = 'pendiente' WHERE id = ?`, [req.params.id]);
  res.redirect(req.headers.referer || '/recibos');
});

app.post('/recibos/verificar-cobros', requireAuth, async (req, res) => {
  try {
    const resumen = await verificarCobrosDelDia();
    setFlash(
      req,
      'ok',
      `Verificación completa: ${resumen.generados} recibo(s) generado(s), ${resumen.finalizados} servicio(s) finalizado(s), ${resumen.omitidos} ya estaban al día.`
    );
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Ocurrió un error al verificar los cobros.');
  }
  res.redirect('/recibos');
});

// ---------------------------------------------------------------------
// Arranque del servidor
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de gestión de recibos escuchando en el puerto ${PORT}`);
});
