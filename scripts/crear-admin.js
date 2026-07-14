/**
 * Crea o actualiza un usuario administrador con un hash bcrypt real.
 *
 * Uso:
 *   node scripts/crear-admin.js <usuario> <password>
 *
 * Ejemplo:
 *   node scripts/crear-admin.js admin MiPasswordSegura123
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db');

async function main() {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error('Uso: node scripts/crear-admin.js <usuario> <password>');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO usuarios (username, password_hash)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [username, hash]
  );

  console.log(`Usuario "${username}" creado/actualizado correctamente.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error creando el usuario administrador:', err.message);
  process.exit(1);
});
