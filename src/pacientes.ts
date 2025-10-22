// api-fundal/src/pacientes.ts
import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth } from './mw/auth.js';

const router = Router();

// === Descubrimiento de tabla/columnas ===
const TABLE_CANDIDATES = ['pacientes', 'cliente_paciente', 'tbl_pacientes'];

const SYNONYMS = {
  id: ['id', 'paciente_id', 'id_paciente'],
  nombres: ['nombres', 'nombre', 'primer_nombre'],
  apellidos: ['apellidos', 'apellido', 'apellido_paterno', 'apellido_materno'],
  fecha_nacimiento: ['fecha_nacimiento', 'fecha', 'fnac', 'fec_nac'],
  sexo: ['sexo', 'sexo_enum', 'genero'],
  edad: ['edad', 'age', 'anios', 'años', 'anos'],
  activo: ['activo', 'estado', 'is_active'],
  terapeuta_id: ['terapeuta_id', 'usuario_id', 'id_terapeuta', 'id_usuario'],
  creado: ['fecha_ingreso', 'creado', 'created_at'],
  actualizado: ['fecha_modifica', 'actualizado', 'updated_at']
};

function pick(colset: Set<string>, candidates: string[]) {
  for (const c of candidates) if (colset.has(c)) return c;
  return null;
}

async function discoverShape() {
  let table: string | null = null;
  let cols: { column_name: string; data_type: string }[] = [];

  for (const t of TABLE_CANDIDATES) {
    const { rows } = await pool.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
      [t]
    );
    if (rows.length) { table = t; cols = rows; break; }
  }
  if (!table) throw new Error('No se encontró la tabla de pacientes');

  const colset = new Set(cols.map(r => r.column_name));
  const map = {
    id: pick(colset, SYNONYMS.id),
    nombres: pick(colset, SYNONYMS.nombres),
    apellidos: pick(colset, SYNONYMS.apellidos),
    fecha_nacimiento: pick(colset, SYNONYMS.fecha_nacimiento),
    sexo: pick(colset, SYNONYMS.sexo),
    edad: pick(colset, SYNONYMS.edad),
    activo: pick(colset, SYNONYMS.activo),
    terapeuta_id: pick(colset, SYNONYMS.terapeuta_id),
    creado: pick(colset, SYNONYMS.creado),
    actualizado: pick(colset, SYNONYMS.actualizado),
  };

  return { table, map };
}

function normalizeRole(raw: any): 'ADMINISTRADOR' | 'TERAPEUTA' | '' {
  const r = String(raw ?? '').trim().toUpperCase();
  if (['ADMIN', 'SUPERADMIN', 'ADMINISTRADOR', 'SUPER ADMIN', 'SUPER_ADMIN', 'ROOT'].includes(r)) return 'ADMINISTRADOR';
  if (['TERAPEUTA', 'THERAPIST'].includes(r)) return 'TERAPEUTA';
  return '';
}

// === GET /pacientes ===
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const { table, map } = await discoverShape();

    // --- Query params saneados ---
    let q = '';
    if (typeof req.query.q === 'string') q = req.query.q.trim().toLowerCase();

    const sexo = (typeof req.query.sexo === 'string' ? req.query.sexo.toUpperCase() : '');
    const order = String(req.query.order ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 200)));

    const all = String(req.query.all ?? '') === '1';
    const mineParam = String(req.query.mine ?? '').trim();

    // --- Rol y defaults ---
    const role = normalizeRole(req.user?.rol ?? req.user?.role);
    const isAdmin = role === 'ADMINISTRADOR';
    const userId = Number(req.user?.id) || 0;

    // Prioridad: all=1 desactiva 'mine' SIEMPRE
    const mine =
      all ? false :
      mineParam === '1' ? true :
      mineParam === '0' ? false :
      !isAdmin; // por defecto: admin ve todos, terapeuta ve los suyos

    const where: string[] = [];
    const params: any[] = [];

    if (mine && map.terapeuta_id) {
      where.push(`${map.terapeuta_id} = $${params.length + 1}`);
      params.push(userId);
    }

    if ((sexo === 'M' || sexo === 'F') && map.sexo) {
      where.push(`${map.sexo} = $${params.length + 1}`);
      params.push(sexo);
    }

    if (q && (map.nombres || map.apellidos)) {
      if (map.nombres && map.apellidos) {
        where.push(`LOWER(COALESCE(${map.apellidos}, '') || ' ' || COALESCE(${map.nombres}, '')) LIKE $${params.length + 1}`);
        params.push(`%${q}%`);
      } else if (map.nombres) {
        where.push(`LOWER(${map.nombres}) LIKE $${params.length + 1}`);
        params.push(`%${q}%`);
      } else {
        where.push(`LOWER(${map.apellidos}) LIKE $${params.length + 1}`);
        params.push(`%${q}%`);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const selCreado = map.creado ? map.creado : 'NULL';
    const selActual = map.actualizado ? map.actualizado : selCreado;
    const orderBy = `${selActual !== 'NULL' ? selActual : (map.id ?? '1')} ${order}`;

    const select = [
      map.id ? `${map.id} AS id` : 'NULL AS id',
      map.nombres ? `${map.nombres} AS nombres` : 'NULL AS nombres',
      map.apellidos ? `${map.apellidos} AS apellidos` : 'NULL AS apellidos',
      map.sexo ? `${map.sexo} AS sexo` : 'NULL AS sexo',
      map.edad ? `${map.edad} AS edad` : 'NULL AS edad',
      map.terapeuta_id ? `${map.terapeuta_id} AS terapeuta_id` : 'NULL AS terapeuta_id',
      selCreado !== 'NULL' ? `${selCreado} AS creado` : `NOW() AS creado`,
      selActual !== 'NULL' ? `${selActual} AS actualizado` : `NOW() AS actualizado`,
    ].join(', ');

    const sql = `
      SELECT ${select}
        FROM ${table}
        ${whereSql}
     ORDER BY ${orderBy}
        LIMIT ${limit}
    `;
    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error('GET /pacientes', e);
    return res.status(500).json({ error: 'Error al listar pacientes' });
  }
});

// === POST /pacientes ===
// Admin: usa terapeuta_id del body (obligatorio).
// Terapeuta: se asigna a sí mismo.
router.post('/', requireAuth, async (req: any, res) => {
  try {
    const { table, map } = await discoverShape();
    const body = req.body ?? {};

    // Saneos básicos
    if (!body.nombres || !body.apellidos) {
      return res.status(400).json({ error: 'nombres y apellidos son obligatorios' });
    }
    const sx = String(body.sexo ?? '').toUpperCase();
    if (sx !== 'M' && sx !== 'F') {
      return res.status(400).json({ error: 'sexo debe ser M o F' });
    }

    let edadVal: number | null = null;
    if (body.edad !== undefined && body.edad !== null && String(body.edad).trim() !== '') {
      const n = Number(body.edad);
      if (!Number.isFinite(n) || n < 0 || n > 120) {
        return res.status(400).json({ error: 'edad inválida (0-120)' });
      }
      edadVal = n;
    }

    // Rol y quién será el terapeuta asignado
    const role = normalizeRole(req.user?.rol ?? req.user?.role);
    const isAdmin = role === 'ADMINISTRADOR';
    const currentUserId = Number(req.user?.id) || 0;

    // Determinar terapeuta_id final
    let terId: number | null = null;
    if (map.terapeuta_id) {
      if (isAdmin) {
        // Admin DEBE mandar terapeuta_id en el body
        if (body.terapeuta_id == null) {
          return res.status(400).json({ error: 'Debes asignar un terapeuta (terapeuta_id).' });
        }
        terId = Number(body.terapeuta_id);
        if (!Number.isFinite(terId)) {
          return res.status(400).json({ error: 'terapeuta_id inválido' });
        }
      } else {
        // Terapeuta: se asigna a sí mismo (ignorar body.terapeuta_id)
        terId = currentUserId;
      }
    }

    // Construcción dinámica del INSERT
    const cols: string[] = [];
    const vals: any[] = [];
    const ph: string[] = [];

    if (map.nombres) { cols.push(map.nombres); vals.push(String(body.nombres).trim()); ph.push(`$${vals.length}`); }
    if (map.apellidos) { cols.push(map.apellidos); vals.push(String(body.apellidos).trim()); ph.push(`$${vals.length}`); }
    if (map.sexo) { cols.push(map.sexo); vals.push(sx); ph.push(`$${vals.length}`); }
    if (map.edad) { cols.push(map.edad); vals.push(edadVal); ph.push(`$${vals.length}`); }
    if (map.fecha_nacimiento) { cols.push(map.fecha_nacimiento); vals.push(body.fecha_nacimiento ?? null); ph.push(`$${vals.length}`); }

    if (map.terapeuta_id) { cols.push(map.terapeuta_id); vals.push(terId); ph.push(`$${vals.length}`); }
    if (map.activo) { cols.push(map.activo); vals.push(true); ph.push(`$${vals.length}`); }

    if (!cols.length) return res.status(400).json({ error: 'No hay columnas coincidentes para insertar' });

    const selCreado = map.creado ? map.creado : 'NULL';
    const selActual = map.actualizado ? map.actualizado : selCreado;

    const returning = [
      map.id ? `${map.id} AS id` : 'NULL AS id',
      map.nombres ? `${map.nombres} AS nombres` : 'NULL AS nombres',
      map.apellidos ? `${map.apellidos} AS apellidos` : 'NULL AS apellidos',
      map.sexo ? `${map.sexo} AS sexo` : 'NULL AS sexo',
      map.edad ? `${map.edad} AS edad` : 'NULL AS edad',
      map.terapeuta_id ? `${map.terapeuta_id} AS terapeuta_id` : 'NULL AS terapeuta_id',
      selCreado !== 'NULL' ? `${selCreado} AS creado` : `NOW() AS creado`,
      selActual !== 'NULL' ? `${selActual} AS actualizado` : `NOW() AS actualizado`,
    ].join(', ');

    const sql = `
      INSERT INTO ${table} (${cols.join(', ')})
      VALUES (${ph.join(', ')})
      RETURNING ${returning}
    `;
    const { rows } = await pool.query(sql, vals);
    return res.status(201).json(rows[0]);
  } catch (e) {
    // Mensaje claro si salta el trigger del DB
    const msg = (e as any)?.message ?? '';
    if (msg.includes('El usuario asignado no es TERAPEUTA')) {
      return res.status(400).json({ error: 'El usuario asignado no es TERAPEUTA. Elige un terapeuta válido.' });
    }
    console.error('POST /pacientes', e);
    return res.status(500).json({ error: 'Error al crear paciente' });
  }
});

// === PUT /pacientes/:id ===
// Admin puede editar cualquiera (incl. cambiar terapeuta_id).
// Terapeuta solo puede editar los suyos (no cambia sexo y no cambia terapeuta_id).
router.put('/:id', requireAuth, async (req: any, res) => {
  try {
    const { table, map } = await discoverShape();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const body = req.body ?? {};
    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;

    const isAdmin = normalizeRole(req.user?.rol) === 'ADMINISTRADOR';

    // Campos editables
    if (map.nombres && typeof body.nombres === 'string') {
      sets.push(`${map.nombres} = $${idx++}`); vals.push(body.nombres.trim());
    }
    if (map.apellidos && typeof body.apellidos === 'string') {
      sets.push(`${map.apellidos} = $${idx++}`); vals.push(body.apellidos.trim());
    }
    if (map.edad && (body.edad === null || Number.isFinite(Number(body.edad)))) {
      sets.push(`${map.edad} = $${idx++}`); vals.push(body.edad == null ? null : Number(body.edad));
    }
    if (map.fecha_nacimiento && (body.fecha_nacimiento === null || typeof body.fecha_nacimiento === 'string')) {
      sets.push(`${map.fecha_nacimiento} = $${idx++}`); vals.push(body.fecha_nacimiento ?? null);
    }
    // sexo NO se actualiza (bloqueado por requerimiento de UI)

    // Solo ADMIN puede reasignar terapeuta
    if (isAdmin && map.terapeuta_id && (body.terapeuta_id === null || Number.isFinite(Number(body.terapeuta_id)))) {
      sets.push(`${map.terapeuta_id} = $${idx++}`); vals.push(body.terapeuta_id == null ? null : Number(body.terapeuta_id));
    }

    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });

    // Restricción de propiedad para TERAPEUTA
    let where = `${map.id} = $${idx++}`;
    vals.push(id);
    if (!isAdmin && map.terapeuta_id && req.user?.id) {
      where += ` AND ${map.terapeuta_id} = $${idx++}`;
      vals.push(Number(req.user.id));
    }

    const sql = `
      UPDATE ${table}
         SET ${sets.join(', ')}${map.actualizado ? `, ${map.actualizado} = NOW()` : ''}
       WHERE ${where}
       RETURNING ${map.id} AS id,
                 ${map.nombres} AS nombres,
                 ${map.apellidos} AS apellidos,
                 ${map.sexo ?? `'M'`} AS sexo,
                 ${map.edad ?? 'NULL'} AS edad,
                 ${map.fecha_nacimiento ?? 'NULL'} AS fecha_nacimiento,
                 ${map.terapeuta_id ?? 'NULL'} AS terapeuta_id,
                 ${map.creado ?? 'NULL'} AS creado,
                 ${map.actualizado ?? 'NULL'} AS actualizado
    `;
    const { rows } = await pool.query(sql, vals);
    if (!rows.length) return res.status(404).json({ error: 'Paciente no encontrado' });
    return res.json(rows[0]);
  } catch (e) {
    console.error('PUT /pacientes/:id', e);
    return res.status(500).json({ error: 'Error al actualizar paciente' });
  }
});

// === DELETE /pacientes/:id ===
// Si existe columna "activo" → borrado lógico; si no, borrado físico.
router.delete('/:id', requireAuth, async (req: any, res) => {
  try {
    const { table, map } = await discoverShape();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const isAdmin = normalizeRole(req.user?.rol) === 'ADMINISTRADOR';

    let where = `${map.id} = $1`;
    const vals: any[] = [id];
    if (!isAdmin && map.terapeuta_id && req.user?.id) {
      where += ` AND ${map.terapeuta_id} = $2`;
      vals.push(Number(req.user.id));
    }

    let sql: string;
    if (map.activo) {
      sql = `UPDATE ${table} SET ${map.activo} = FALSE${map.actualizado ? `, ${map.actualizado} = NOW()` : ''} WHERE ${where}`;
    } else {
      sql = `DELETE FROM ${table} WHERE ${where}`;
    }

    const r = await pool.query(sql, vals);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Paciente no encontrado' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /pacientes/:id', e);
    return res.status(500).json({ error: 'Error al eliminar paciente' });
  }
});

export default router;
