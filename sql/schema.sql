-- =====================================================================
-- Gestor de Clientes y Recibos - Script de creación (instalación NUEVA)
-- Si ya tienes el sistema funcionando, NO uses este archivo: usa los
-- scripts de migración.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS gestor_recibos
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE gestor_recibos;

CREATE TABLE IF NOT EXISTS usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS clientes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  whatsapp VARCHAR(20) NOT NULL,
  direccion TEXT,
  notas TEXT,
  saldo_favor DECIMAL(10,2) NOT NULL DEFAULT 0,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS servicios_contratados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cliente_id INT NOT NULL,
  nombre_servicio VARCHAR(150) NOT NULL,
  tipo ENUM('unico', 'recurrente', 'parcialidad') NOT NULL,
  frecuencia ENUM('diaria', 'semanal', 'quincenal', 'mensual') NOT NULL DEFAULT 'mensual',
  monto DECIMAL(10,2) NOT NULL,
  total_parcialidades INT NULL,
  parcialidades_pagadas INT DEFAULT 0,
  dia_cobro_mensual INT NULL,
  fecha_inicio DATE NULL,
  activo TINYINT(1) DEFAULT 1,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_servicios_cliente
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recibos_emitidos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  servicio_id INT NOT NULL,
  cliente_id INT NOT NULL,
  monto DECIMAL(10,2) NOT NULL,
  saldo_aplicado DECIMAL(10,2) NOT NULL DEFAULT 0,
  numero_cuota INT NULL,
  fecha_emision DATE NOT NULL,
  fecha_vencimiento DATE NULL,
  estado ENUM('pendiente', 'pagado') DEFAULT 'pendiente',
  CONSTRAINT fk_recibos_servicio
    FOREIGN KEY (servicio_id) REFERENCES servicios_contratados(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_recibos_cliente
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE UNIQUE INDEX ux_recibo_servicio_vencimiento
  ON recibos_emitidos (servicio_id, fecha_vencimiento);

CREATE TABLE IF NOT EXISTS abonos_cliente (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cliente_id INT NOT NULL,
  monto DECIMAL(10,2) NOT NULL,
  nota VARCHAR(255) NULL,
  fecha DATE NOT NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_abonos_cliente
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Usuario administrador: créalo con
--   node scripts/crear-admin.js admin TU_PASSWORD
