-- =====================================================================
-- Migración: agrega fecha de vencimiento y recordatorios escalonados
-- Ejecuta este script UNA SOLA VEZ en phpMyAdmin, en la base que ya
-- tienes en uso (gestor_recibos), si tu sistema fue instalado antes
-- de esta actualización.
-- =====================================================================

USE gestor_recibos;

-- 1) Agrega la columna de fecha de vencimiento (si no existe ya)
ALTER TABLE recibos_emitidos
  ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE NULL AFTER fecha_emision;

-- 2) Para los recibos que ya existan y no tengan vencimiento registrado,
--    se usa su fecha de emisión como referencia (no afecta recibos nuevos).
UPDATE recibos_emitidos
SET fecha_vencimiento = fecha_emision
WHERE fecha_vencimiento IS NULL;

-- 3) Crea primero el índice nuevo, basado en el ciclo de cobro
--    (fecha de vencimiento). Se crea ANTES de borrar el anterior porque
--    la tabla siempre necesita un índice que cubra servicio_id, ya que
--    esa columna tiene una relación (foreign key) con servicios_contratados.
CREATE UNIQUE INDEX IF NOT EXISTS ux_recibo_servicio_vencimiento
  ON recibos_emitidos (servicio_id, fecha_vencimiento);

-- 4) Ahora sí, borra el índice único anterior (por fecha de emisión)
DROP INDEX IF EXISTS ux_recibo_servicio_fecha ON recibos_emitidos;
