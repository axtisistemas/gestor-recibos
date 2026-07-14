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
  pendientes/pagados. Cada recibo pendiente tiene un botón verde
  **"Enviar por WhatsApp"** que abre `wa.me` con el mensaje ya redactado.
- **Verificar cobros del día**: botón en la pantalla de Recibos que revisa
  todos los servicios recurrentes/a parcialidades activos y genera el
  recibo correspondiente si hoy coincide con su día de cobro. Es seguro
  presionarlo varias veces: no duplica recibos ya generados el mismo día.

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
