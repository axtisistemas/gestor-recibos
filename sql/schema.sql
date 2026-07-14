-- =====================================================================
-- Gestor de Clientes y Recibos - Script de creación de base de datos
-- Motor: MariaDB
-- Importar este archivo desde phpMyAdmin (pestaña "Importar" o "SQL")
-- =====================================================================

CREATE DATABASE IF NOT EXISTS gestor_recibos
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE gestor_recibos;

-- ---------------------------------------------------------------------
-- Tabla: usuarios (administradores del panel)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Tabla: clientes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  whatsapp VARCHAR(20) NOT NULL,      -- Incluir código de país, ej. 5219871234567
  direccion TEXT,
  notas TEXT,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Tabla: servicios_contratados
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servicios_contratados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cliente_id INT NOT NULL,
  nombre_servicio VARCHAR(150) NOT NULL,
  tipo ENUM('unico', 'recurrente', 'parcialidad') NOT NULL,
  monto DECIMAL(10,2) NOT NULL,
  total_parcialidades INT NULL,
  parcialidades_pagadas INT DEFAULT 0,
  dia_cobro_mensual INT NULL,          -- 1-31, día del mes en que se genera el cobro
  activo TINYINT(1) DEFAULT 1,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_servicios_cliente
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Tabla: recibos_emitidos
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recibos_emitidos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  servicio_id INT NOT NULL,
  cliente_id INT NOT NULL,
  monto DECIMAL(10,2) NOT NULL,
  numero_cuota INT NULL,
  fecha_emision DATE NOT NULL,
  estado ENUM('pendiente', 'pagado') DEFAULT 'pendiente',
  CONSTRAINT fk_recibos_servicio
    FOREIGN KEY (servicio_id) REFERENCES servicios_contratados(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_recibos_cliente
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Evita generar dos recibos del mismo servicio el mismo día
CREATE UNIQUE INDEX ux_recibo_servicio_fecha
  ON recibos_emitidos (servicio_id, fecha_emision);

-- ---------------------------------------------------------------------
-- Usuario administrador inicial
-- NO insertes el usuario aquí con un hash "a mano": un hash bcrypt mal
-- copiado simplemente nunca hará match y no podrás entrar.
-- En su lugar, después de instalar el proyecto, ejecuta desde la carpeta
-- del proyecto:
--
--     node scripts/crear-admin.js admin admin123
--
-- Ese script genera el hash real con bcryptjs y lo inserta (o actualiza)
-- directamente en esta tabla usando tus credenciales del archivo .env.
-- ---------------------------------------------------------------------
