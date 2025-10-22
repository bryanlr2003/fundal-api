// api-fundal/src/sesiones.ts
import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth } from './mw/auth.js';

const router = Router();

// Candidatos de nombres en tu BD (ajusta si usaste otro)
const TABLE_CANDIDATES = ['sesiones', 'bitacora', 'notas_terapia', 'notas', 'sesion'];
const SYNONYMS = {
  id:            ['id', 'sesion_id', 'id_sesion', 'nota_id', 'id_nota'],
  paciente_id:   ['paciente_id', 'id_paciente', 'cliente_paciente_id'],
  terapeuta_id:  ['terapeuta_id', 'id_terapeuta', 'usuario_id', 'id_usuario'],
  fecha:         ['fecha', 'fecha_inicio', 'created_at', 'creado', 'ts', 'timestamp'],
  nota:          ['nota', 'observacion', 'observaciones', 'detalle', 'descripcion', 'texto'],
  titulo:        ['titulo', 'asunto', 'subject'], // opcional
};

function pick(colset: Set<string>, candidates: string[]) {
  for (const c of candidates) if (colset.has(c)) return c;
  return null;
}

async function discoverShape() {
  // 1) hallar la tabla
  let table: string | null = null;
  let cols: { column_name: string, data_type: string }[] = [];
  for (const t of TABLE_CANDIDATES) {
    const { rows } = await pool.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
      [t]
    );
    if (rows.length) { table = t; cols = rows; break; }
  }
  if (!table) throw new Error('No se encontró la tabla de notas/bitácora (ajusta TABLE_CANDIDATES).');

  const colset = new Set(cols.map(r => r.column_name));
  const map = {
    id:           pick(colset, SYNONYMS.id),
    paciente_id:  pick(colset, SYNONYMS.paciente_id),
    terapeuta_id: pick(colset, SYNONYMS.terapeuta_id),
    fecha:        pick(colset, SYNONYMS.fecha),
    nota:         pick(colset, SYNONYMS.nota),
    titulo:       pick(colset, SYNONYMS.titulo),
  };

  return { table, map, colset };
}

// ===== GET /sesiones?pacienteId=... → listar notas por paciente
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const pacienteId = req.query.pacienteId ? Number(req.query.pacienteId) : undefined;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const { table, map } = await discoverShape();

    const select = [
      map.id ? `${map.id} as id` : 'NULL as id',
      map.paciente_id ? `${map.paciente_id} as paciente_id` : 'NULL as paciente_id',
      map.terapeuta_id ? `${map.terapeuta_id} as terapeuta_id` : 'NULL as terapeuta_id',
      map.fecha ? `${map.fecha} as fecha` : `NOW() as fecha`,
      map.titulo ? `${map.titulo} as titulo` : `NULL as titulo`,
      map.nota ? `${map.nota} as nota` : `NULL as nota`,
    ].join(', ');

    let where = '';
    const params: any[] = [];
    if (pacienteId && map.paciente_id) {
      where = `WHERE ${map.paciente_id} = $1`;
      params.push(pacienteId);
    }

    const orderBy = map.fecha ?? map.id ?? '1';
    const sql = `
      SELECT ${select}
        FROM ${table}
        ${where}
    ORDER BY ${orderBy} DESC
       LIMIT ${limit}
    `;

    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (e:any) {
    console.error('GET /sesiones error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ===== POST /sesiones → crear nota/bitácora (fecha auto NOW())
router.post('/', requireAuth, async (req: any, res) => {
  try {
    const { pacienteId, nota, titulo } = req.body || {};
    if (!pacienteId) return res.status(400).json({ error: 'pacienteId es requerido' });
    if (!nota || !String(nota).trim()) return res.status(400).json({ error: 'nota es obligatoria' });

    const { table, map } = await discoverShape();
    const terapeutaId = req.user?.id ?? null; // si no tienes col terapeuta_id, igual insertamos sin eso

    const cols: string[] = [];
    const ph: string[] = [];
    const vals: any[] = [];

    if (map.paciente_id) { cols.push(map.paciente_id); vals.push(pacienteId); ph.push(`$${vals.length}`); }
    if (map.terapeuta_id && terapeutaId != null) { cols.push(map.terapeuta_id); vals.push(terapeutaId); ph.push(`$${vals.length}`); }
    if (map.titulo && titulo != null) { cols.push(map.titulo); vals.push(String(titulo).trim()); ph.push(`$${vals.length}`); }
    if (map.nota) { cols.push(map.nota); vals.push(String(nota).trim()); ph.push(`$${vals.length}`); }
    if (map.fecha) { cols.push(map.fecha); ph.push('NOW()'); } // función NOW()

    if (!cols.length) return res.status(500).json({ error: 'No hay columnas coincidentes para insertar la nota' });

    const returning = [
      map.id ? `${map.id} as id` : 'NULL as id',
      map.paciente_id ? `${map.paciente_id} as paciente_id` : 'NULL as paciente_id',
      map.terapeuta_id ? `${map.terapeuta_id} as terapeuta_id` : 'NULL as terapeuta_id',
      map.fecha ? `${map.fecha} as fecha` : `NOW() as fecha`,
      map.titulo ? `${map.titulo} as titulo` : `NULL as titulo`,
      map.nota ? `${map.nota} as nota` : `NULL as nota`,
    ].join(', ');

    const sql = `
      INSERT INTO ${table} (${cols.join(', ')})
      VALUES (${ph.join(', ')})
      RETURNING ${returning}
    `;

    // filtra placeholders función NOW() (no tiene valor)
    const valsOnly = vals.filter((_, i) => ph[i] !== 'NOW()');

    const { rows } = await pool.query(sql, valsOnly);
    return res.status(201).json(rows[0]);
  } catch (e:any) {
    console.error('POST /sesiones error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
