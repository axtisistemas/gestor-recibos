# Gestor de Clientes y Recibos (Self-Hosted)

Sistema Node.js + Express + EJS + MariaDB para administrar clientes y generar
recibos de pago único, recurrentes o a parcialidades, con envío del recibo
por WhatsApp.

## 1. Requisitos

- Node.js 18 o superior
- Una base de datos MariaDB accesible (la que ya tienes en Portainer)
- Acceso a phpMyAdmin para importar el script SQL

## 2. Crear la base de datos

1. Entra a phpMyAdmin.
2. Ve a la pestaña **SQL** (o "Importar") y pega/carga el contenido de
   `sql/schema.sql`.
3. Esto crea la base `gestor_recibos` y las 4 tablas: `usuarios`,
   `clientes`, `servicios_contratados`, `recibos_emitidos`.

## 3. Configurar el proyecto

```bash
# 1. Instala las dependencias
npm install

# 2. Copia el archivo de variables de entorno y edítalo
cp .env.example .env
```

Edita `.env` con los datos de conexión a tu contenedor de MariaDB:

```
DB_HOST=localhost      # o el nombre/IP del contenedor de MariaDB
DB_PORT=3306
DB_USER=root
DB_PASSWORD=tu_password
DB_NAME=gestor_recibos
SESSION_SECRET=una_cadena_larga_y_aleatoria
PORT=3000
```

## 4. Crear tu usuario administrador

El script SQL **no** crea el usuario con una contraseña lista para usar
(un hash bcrypt copiado a mano nunca es seguro ni confiable). En vez de eso,
genera el hash real ejecutando:

```bash
node scripts/crear-admin.js admin TU_PASSWORD_SEGURA
```

Esto inserta (o actualiza) el usuario `admin` directamente en la tabla
`usuarios` usando la conexión definida en tu `.env`. Puedes ejecutarlo de
nuevo en cualquier momento para cambiar la contraseña o crear más usuarios.

## 5. Levantar el servidor

```bash
npm start
```

Abre `http://TU_SERVIDOR:3000` (o el puerto que hayas definido) e inicia
sesión con el usuario que creaste.

Para desarrollo con recarga automática:

```bash
npm run dev
```

## 6. Uso

- **Clientes**: crea, edita y elimina clientes (nombre, WhatsApp con código
  de país, dirección, notas).
- **Detalle de cliente**: agrega servicios/planes:
  - *Pago único*: genera el recibo de inmediato.
  - *Recurrente*: se cobra cada mes en el día que definas, de forma indefinida.
  - *A parcialidades*: define cuántas cuotas en total; el sistema lleva el
    control de "Cuota X de Y" y desactiva el servicio automáticamente al
    completarse.
- **Recibos**: lista todos los recibos generados, con filtro por
  pendientes/pagados. Cada recibo pendiente tiene un botón de WhatsApp cuyo
  texto cambia automáticamente según qué tan cerca esté del vencimiento:
  - Más de 0 días antes del vencimiento → recordatorio 1 ("antes del [fecha]").
  - El mismo día del vencimiento → recordatorio 2 ("hoy mismo").
  - Después del vencimiento → aviso de vencido ("evita recargos").
- **Verificar cobros del día**: botón en la pantalla de Recibos que revisa
  todos los servicios recurrentes/a parcialidades activos y genera el
  recibo correspondiente **10 días antes** de su fecha de vencimiento (día
  de cobro mensual). Es seguro presionarlo varias veces: no duplica
  recibos ya generados para el mismo ciclo.

### Si vienes de una versión anterior (ya tenías el sistema instalado)

Antes de esta actualización los recibos se generaban el mismo día del
cobro. Ahora se generan 10 días antes, y cada recibo guarda también su
`fecha_vencimiento`. Para actualizar una base de datos que ya está en uso,
ejecuta una sola vez en phpMyAdmin el script `sql/migracion_recordatorios.sql`
(no vuelvas a correr `sql/schema.sql`, ese es solo para instalaciones nuevas).

### Automatizarlo con un cron real (opcional)

Si prefieres que la verificación diaria ocurra sola sin tener que entrar al
panel, puedes programar una tarea en el sistema operativo del servidor que
llame a la ruta protegida, por ejemplo con `curl` autenticado, o agregar un
`setInterval`/librería tipo `node-cron` dentro de `server.js` que ejecute
`verificarCobrosDelDia()` una vez al día. Se dejó como acción manual por
simplicidad y para que tengas control total sobre cuándo se generan los
recibos.

## 7. Estructura del proyecto

```
gestor-recibos/
├── server.js              # Rutas, autenticación y lógica de negocio
├── db.js                  # Pool de conexión a MariaDB (mysql2)
├── scripts/
│   └── crear-admin.js     # Genera el usuario administrador con bcrypt
├── sql/
│   └── schema.sql          # Script para phpMyAdmin
├── views/
│   ├── login.ejs
│   ├── clientes.ejs
│   ├── cliente_detalle.ejs
│   ├── recibos.ejs
│   └── partials/
│       ├── head.ejs
│       └── nav.ejs
├── .env.example
└── package.json
```

## 8. Notas de seguridad

- Cambia `SESSION_SECRET` por una cadena única y aleatoria en producción.
- Sirve la aplicación detrás de HTTPS (por ejemplo con un reverse proxy
  como Nginx o Traefik/Portainer) ya que las credenciales viajan por la
  sesión.
- El middleware `requireAuth` protege todas las rutas de clientes,
  servicios y recibos; solo `/login` es pública.

## Integración con AxtiPay (links de pago)

El gestor crea en [AxtiPay](https://pay.axti.mx) un link de pago para cada recibo pendiente, y AxtiPay le avisa al gestor cuando se paga.

### Cómo funciona

- **Link por recibo:** cada recibo pendiente tiene su link por el saldo que le falta (si ya tiene abonos, cobra solo el resto).
- **Link de saldo total:** si un cliente debe 2 o más recibos, también tiene un link para pagar todo junto. Aparece en el detalle del cliente y en los mensajes de WhatsApp.
- **Mensajes de WhatsApp:** los recordatorios que ya envías incluyen el link de pago (y el de saldo total, si aplica). En la lista de recibos hay un botón para copiar el link.
- **Cuando se paga** (con tarjeta, o porque lo marcas pagado en AxtiPay), el gestor lo registra como **abono** con la nota "AxtiPay · forma de pago". Si se pagó el link de un recibo, se aplica a ese recibo; si se pagó el saldo total, a los recibos más antiguos primero. Si sobra, queda como saldo a favor.
- **Si el monto cambia** (por un abono en efectivo, por ejemplo), el link se actualiza al nuevo saldo.
- **Si un recibo deja de deberse** (lo marcas pagado aquí, o se cubre con saldo a favor), su link se cancela en AxtiPay, para que nadie pague dos veces. Si lo reabres, se crea un link nuevo.
- La sincronización corre después de cada cambio y cada hora junto con la verificación de cobros.

### Configuración

1. En la base de datos ejecuta `sql/migracion_axtipay.sql` (phpMyAdmin → SQL). Se puede repetir sin problema.
2. En AxtiPay → **Integraciones** → **Agregar integración**:
   - Nombre: `Gestor de recibos`. Identificador: `gestor`.
   - URL de aviso de pago: `https://pagos.axti.mx/api/axtipay/webhook`
   - Marca **Permitir pago con tarjeta** y **Activa**, guarda y dale **Copiar clave**.
3. En Portainer, agrega las variables de entorno del stack:
   ```
   AXTIPAY_URL=https://pay.axti.mx
   AXTIPAY_INTEGRATION=gestor
   AXTIPAY_SECRET=la_clave_que_copiaste
   ```
4. Vuelve a desplegar el stack. En AxtiPay → Integraciones → **Probar conexión** debe decir "Conexión correcta".
5. En el gestor, ve a **Recibos** → **Verificar cobros del día**. Los recibos pendientes ya traen su link.

Sin `AXTIPAY_SECRET` la integración queda apagada y el gestor funciona igual que antes.

La ruta `/api/axtipay/webhook` debe ser accesible desde internet (por `pagos.axti.mx`). Solo acepta avisos con la firma de AxtiPay; cualquier otro se rechaza.
