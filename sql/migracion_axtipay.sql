-- =====================================================================
-- Migración: integración con AxtiPay (links de pago)
-- Ejecuta este script UNA SOLA VEZ en phpMyAdmin (pestaña SQL), en tu
-- base gestor_recibos. Es seguro repetirlo si falla a la mitad.
-- =====================================================================

USE gestor_recibos;

-- Link de pago de cada recibo pendiente
ALTER TABLE recibos_emitidos
  ADD COLUMN IF NOT EXISTS axtipay_url VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS axtipay_monto DECIMAL(10,2) NULL,
  ADD COLUMN IF NOT EXISTS axtipay_seq INT NOT NULL DEFAULT 1;

-- Link para pagar todo el saldo pendiente del cliente
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS axtipay_cuenta_url VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS axtipay_cuenta_monto DECIMAL(10,2) NULL,
  ADD COLUMN IF NOT EXISTS axtipay_seq INT NOT NULL DEFAULT 1;

-- Referencia del pago, para no registrar dos veces el mismo
ALTER TABLE abonos_cliente
  ADD COLUMN IF NOT EXISTS referencia VARCHAR(100) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_abonos_referencia ON abonos_cliente (referencia);
