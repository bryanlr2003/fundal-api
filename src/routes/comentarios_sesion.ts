// api-fundal/src/routes/comentarios_sesion.ts
import express from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../mw/auth';

const router = express.Router();

/**
 * A) Modo 1 (sesión existente):
 * POST /sesiones/:id/comentarios  Body: { comentario }
 */
router.post('/:id/comentarios', requireAuth, async (req: Request & { user?: any }, res: Response) => {
  const pool = req.app.get('db');
  const sesionId = Number(req.params.id);
  const autorId = Number(req.user?.id);
  const { comentario } = (req.body ?? {}) as { comentario?: string };

  if (!Number.isFinite(sesionId)) return res.status(400).json({ error: 'ID de sesión inválido' });
  if (!comentario || typeof comentario !== 'string' || !comentario.trim()) {
    return res.status(400).json({ error: 'comentario requerido' });
  }

  try {
    const ses = await pool.query(`SELECT id FROM sesiones WHERE id = $1`, [sesionId]);
    if (ses.rowCount === 0) return res.status(404).json({ error: 'Sesión no encontrada' });

    const q = `
      INSERT INTO comentarios_sesion (sesion_id, autor_id, texto)
      VALUES ($1, $2, $3)
      RETURNING id, sesion_id, autor_id, texto, timestamp, fecha_crea, fecha_modifica
    `;
    const r = await pool.query(q, [sesionId, autorId, comentario.trim()]);

    try {
      await pool.query(
        `INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [autorId, 'CREAR_COMENTARIO_SESION', 'comentarios_sesion', r.rows[0].id,
         JSON.stringify({ sesion_id: sesionId, longitud: comentario.length })]
      );
    } catch {}

    return res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('POST /sesiones/:id/comentarios', err);
    return res.status(500).json({ error: 'Error al guardar comentario' });
  }
});

/**
 * B) Modo 2 (sin sesionId en UI, bitácora simple):
 * POST /sesiones/comentarios  Body: { pacienteId, comentario }
 * Crea una sesión mínima (CERRADA) y guarda el comentario.
 */
router.post('/comentarios', requireAuth, async (req: Request & { user?: any }, res: Response) => {
  const pool = req.app.get('db');
  const autorId = Number(req.user?.id);
  const { pacienteId, comentario } = (req.body ?? {}) as { pacienteId?: number; comentario?: string };

  if (!Number.isFinite(Number(pacienteId))) return res.status(400).json({ error: 'pacienteId requerido' });
  if (!comentario || typeof comentario !== 'string' || !comentario.trim()) {
    return res.status(400).json({ error: 'comentario requerido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sesQ = `
      INSERT INTO sesiones (paciente_id, terapeuta_id, fecha_inicio, fecha_fin, estado)
      VALUES ($1, $2, NOW(), NOW(), 'CERRADA')
      RETURNING id
    `;
    const sesR = await client.query(sesQ, [Number(pacienteId), autorId]);
    const sesionId = sesR.rows[0].id as number;

    const cmtQ = `
      INSERT INTO comentarios_sesion (sesion_id, autor_id, texto)
      VALUES ($1, $2, $3)
      RETURNING id, sesion_id, autor_id, texto, timestamp, fecha_crea, fecha_modifica
    `;
    const cmtR = await client.query(cmtQ, [sesionId, autorId, comentario.trim()]);

    try {
      await client.query(
        `INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [autorId, 'CREAR_BITACORA_COMENTARIO', 'comentarios_sesion', cmtR.rows[0].id,
         JSON.stringify({ sesion_id: sesionId, paciente_id: pacienteId, longitud: comentario.length })]
      );
    } catch {}

    await client.query('COMMIT');
    return res.json({ data: { sesion_id: sesionId, comentario: cmtR.rows[0] } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /sesiones/comentarios', err);
    return res.status(500).json({ error: 'Error al guardar el comentario' });
  } finally {
    client.release();
  }
});

/**
 * C) Historial por sesión
 * GET /sesiones/:id/comentarios
 */
router.get('/:id/comentarios', requireAuth, async (req: Request, res: Response) => {
  const pool = req.app.get('db');
  const sesionId = Number(req.params.id);
  if (!Number.isFinite(sesionId)) return res.status(400).json({ error: 'ID de sesión inválido' });

  try {
    const r = await pool.query(
      `SELECT id, sesion_id, autor_id, texto, timestamp, fecha_crea, fecha_modifica
         FROM comentarios_sesion
        WHERE sesion_id = $1
        ORDER BY fecha_crea DESC`,
      [sesionId]
    );
    return res.json({ data: r.rows });
  } catch (err) {
    console.error('GET /sesiones/:id/comentarios', err);
    return res.status(500).json({ error: 'Error al obtener comentarios' });
  }
});

/**
 * D) Listado global con filtros:
 * GET /sesiones/comentarios?pacienteId=&sexo=&q=&limit=&order=desc|asc
 * (sin refactor BD: se hace JOIN a sesiones y pacientes)
 */
router.get('/comentarios', requireAuth, async (req: Request, res: Response) => {
  const pool = req.app.get('db');
  const pacienteId = req.query.pacienteId ? Number(req.query.pacienteId) : undefined;
  const sexo = (req.query.sexo as string | undefined)?.toUpperCase() as 'M' | 'F' | undefined;
  const q = (req.query.q as string | undefined)?.trim();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const order = (String(req.query.order || 'desc').toLowerCase() === 'asc') ? 'ASC' : 'DESC';

  const conds: string[] = [];
  const params: any[] = [];
  let i = 0;

  if (pacienteId) { conds.push(`s.paciente_id = $${++i}`); params.push(pacienteId); }
  if (sexo === 'M' || sexo === 'F') { conds.push(`p.sexo = $${++i}`); params.push(sexo); }
  if (q) {
    conds.push(`(c.texto ILIKE $${++i} OR p.nombres ILIKE $${i} OR p.apellidos ILIKE $${i})`);
    params.push(`%${q}%`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const sql = `
    SELECT
      c.id,
      c.texto,
      c.fecha_crea AS fecha,
      c.autor_id,
      s.id           AS sesion_id,
      s.paciente_id  AS paciente_id,
      s.terapeuta_id AS terapeuta_id,
      p.nombres      AS paciente_nombres,
      p.apellidos    AS paciente_apellidos,
      p.sexo         AS paciente_sexo
    FROM comentarios_sesion c
    JOIN sesiones  s ON s.id = c.sesion_id
    LEFT JOIN pacientes p ON p.id = s.paciente_id
    ${where}
    ORDER BY c.fecha_crea ${order}
    LIMIT ${limit}
  `;

  try {
    const r = await pool.query(sql, params);
    return res.json({ data: r.rows });
  } catch (err) {
    console.error('GET /sesiones/comentarios', err);
    return res.status(500).json({ error: 'Error al listar comentarios' });
  }
});

export default router;
