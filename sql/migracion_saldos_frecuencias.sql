-- =====================================================================
-- Migración: saldo a favor de clientes + frecuencias de parcialidades
-- Ejecuta este script UNA SOLA VEZ en phpMyAdmin (pestaña SQL), en tu
-- base gestor_recibos. Requiere haber corrido antes
-- migracion_recordatorios.sql. Es seguro repetirlo si falla a la mitad.
-- =====================================================================

USE gestor_recibos;

-- Saldo a favor del cliente
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS saldo_favor DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Frecuencia de cobro (para parcialidades) y fecha de la primera cuota
ALTER TABLE servicios_contratados
  ADD COLUMN IF NOT EXISTS frecuencia ENUM('diaria', 'semanal', 'quincenal', 'mensual') NOT NULL DEFAULT 'mensual' AFTER tipo,
  ADD COLUMN IF NOT EXISTS fecha_inicio DATE NULL AFTER dia_cobro_mensual;

-- Cuánto del saldo a favor se ha aplicado a cada recibo
ALTER TABLE recibos_emitidos
  ADD COLUMN IF NOT EXISTS saldo_aplicado DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER monto;

-- Historial de abonos / adelantos de cada cliente
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
