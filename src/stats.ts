// api-fundal/src/stats.ts
import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth } from './mw/auth.js';

const router = Router();

// ======== Config de nombres posibles (sinónimos) ========
const PACIENTES_TABLES = ['pacientes', 'cliente_paciente', 'tbl_pacientes'];
const PACIENTES_COLS = {
  id:            ['id', 'paciente_id', 'id_paciente'],
  nombres:       ['nombres', 'nombre', 'primer_nombre'],
  apellidos:     ['apellidos', 'apellido', 'segundo_nombre', 'apellido_paterno', 'apellido_materno'],
  // priorizamos columnas reales de la tabla paciente
  creado:        ['fecha_ingreso', 'created_at', 'fecha_alta', 'fecha_creacion', 'creado'],
  actualizado:   ['fecha_modifica', 'updated_at', 'fecha_actualizacion', 'modificado', 'modificado_en'],
  owner_terapeuta_id: ['terapeuta_id', 'creado_por', 'usuario_id', 'registrado_por'],
  // extras que queremos exponer
  edad:          ['edad', 'age', 'anios', 'años', 'anos'],
  sexo:          ['sexo', 'sexo_enum', 'genero'],
};

const SESIONES_TABLES = ['sesiones', 'bitacora', 'notas_terapia', 'notas', 'sesion'];
const SESIONES_COLS = {
  id:            ['id', 'sesion_id', 'id_sesion', 'nota_id', 'id_nota'],
  paciente_id:   ['paciente_id', 'id_paciente', 'cliente_paciente_id'],
  terapeuta_id:  ['terapeuta_id', 'id_terapeuta', 'usuario_id', 'id_usuario'],
  fecha:         ['fecha', 'fecha_inicio', 'created_at', 'creado', 'ts', 'timestamp'],
  nota:          ['nota', 'observacion', 'observaciones', 'detalle', 'descripcion', 'texto'],
  titulo:        ['titulo', 'asunto', 'subject']
};

const RUNS_TABLES = ['runs', 'actividades', 'modulo_usos', 'ejecuciones'];
const RUNS_COLS = {
  id:            ['id', 'run_id', 'id_run', 'actividad_id'],
  sesion_id:     ['sesion_id', 'id_sesion', 'nota_id'],
  paciente_id:   ['paciente_id', 'id_paciente'],
  terapeuta_id:  ['terapeuta_id', 'id_terapeuta', 'usuario_id'],
  tipo:          ['tipo', 'modulo', 'modulo_tipo', 'nombre_modulo'],
  inicio:        ['inicio', 'started_at', 'fecha_inicio', 'ts_inicio'],
  fin:           ['fin', 'ended_at', 'fecha_fin', 'ts_fin']
};

// Comentarios (bitácora)
const COMENTARIOS_TABLES = ['comentarios_sesion', 'comentarios', 'comentario_sesion', 'bitacora_comentarios'];
const COMENTARIOS_COLS = {
  id:        ['id', 'comentario_id', 'id_comentario'],
  sesion_id: ['sesion_id', 'id_sesion', 'nota_id', 'id_nota'],
};

// ======== Helpers ========
type ColInfo = { column_name:string; data_type:string };

function pick(set:Set<string>, arr:string[]){ for(const c of arr) if(set.has(c)) return c; return null; }
function isDateLike(ci?: ColInfo){ if(!ci) return false; const t = ci.data_type?.toLowerCase?.() ?? ''; return t.includes('timestamp') || t === 'date'; }

async function discover(tableCandidates:string[], colsMap:Record<string,string[]>) {
  let table:string| null = null;
  let cols:ColInfo[] = [];
  for (const t of tableCandidates) {
    const { rows } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`, [t]
    );
    if (rows.length) { table = t; cols = rows; break; }
  }
  const set = new Set(cols.map(r=>r.column_name));
  const map:any = {};
  for (const key of Object.keys(colsMap)) map[key] = pick(set, colsMap[key]);
  const byName:Record<string,ColInfo> = Object.fromEntries(cols.map(c => [c.column_name, c]));
  return { table, map, set, byName };
}

function mapTipoModulo(raw: string) {
  const t = (raw || '').toUpperCase();
  if (t === 'A' || t.startsWith('ULTRA')) return 'ULTRASONICOS';
  if (t === 'B' || t.startsWith('PULS'))  return 'PULSADORES';
  return t;
}

// ========== OVERVIEW ==========
router.get('/overview', requireAuth, async (req:any, res) => {
  try {
    const terapeutaId = req.user?.id;
    if (!terapeutaId) return res.status(401).json({ error: 'No autorizado' });

    const pac = await discover(PACIENTES_TABLES, PACIENTES_COLS);
    const ses = await discover(SESIONES_TABLES, SESIONES_COLS);
    const run = await discover(RUNS_TABLES, RUNS_COLS);

    // Pacientes totales del terapeuta
    let pacientesTotal = 0;
    if (pac.table && pac.map.id) {
      if (pac.map.owner_terapeuta_id) {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS c FROM ${pac.table} WHERE ${pac.map.owner_terapeuta_id}=$1`,
          [terapeutaId]
        );
        pacientesTotal = rows[0]?.c ?? 0;
      } else if (ses.table && ses.map.paciente_id && ses.map.terapeuta_id) {
        const { rows } = await pool.query(
          `SELECT COUNT(DISTINCT p.${pac.map.id})::int AS c
             FROM ${pac.table} p
            WHERE EXISTS (
              SELECT 1 FROM ${ses.table} s
               WHERE s.${ses.map.paciente_id}=p.${pac.map.id}
                 AND s.${ses.map.terapeuta_id}=$1
            )`,
          [terapeutaId]
        );
        pacientesTotal = rows[0]?.c ?? 0;
      }
    }

    // Pacientes 7d/30d
    let pacientes7d = 0, pacientes30d = 0;
    const creadoColName = pac.map.creado;
    const creadoColInfo = creadoColName ? pac.byName[creadoColName] : undefined;

    if (pac.table && pac.map.id && pac.map.owner_terapeuta_id && creadoColName && isDateLike(creadoColInfo)) {
      const q = (days:number) => `
        SELECT COUNT(*)::int AS c
          FROM ${pac.table}
         WHERE ${pac.map.owner_terapeuta_id}=$1
           AND ${creadoColName} >= NOW() - INTERVAL '${days} days'`;
      pacientes7d  = (await pool.query(q(7),  [terapeutaId])).rows[0]?.c ?? 0;
      pacientes30d = (await pool.query(q(30), [terapeutaId])).rows[0]?.c ?? 0;
    } else if (ses.table && ses.map.terapeuta_id && ses.map.fecha && isDateLike(ses.byName[ses.map.fecha])) {
      const q = (days:number) => `
        SELECT COUNT(DISTINCT ${ses.map.paciente_id})::int AS c
          FROM ${ses.table}
         WHERE ${ses.map.terapeuta_id}=$1
           AND ${ses.map.fecha} >= NOW() - INTERVAL '${days} days'`;
      pacientes7d  = (await pool.query(q(7),  [terapeutaId])).rows[0]?.c ?? 0;
      pacientes30d = (await pool.query(q(30), [terapeutaId])).rows[0]?.c ?? 0;
    }

    // Notas 7d/30d
    let notas7d = 0, notas30d = 0;
    if (ses.table && ses.map.terapeuta_id && ses.map.fecha && isDateLike(ses.byName[ses.map.fecha])) {
      const q = (d:number) => `
        SELECT COUNT(*)::int AS c
          FROM ${ses.table}
         WHERE ${ses.map.terapeuta_id}=$1
           AND ${ses.map.fecha} >= NOW() - INTERVAL '${d} days'`;
      notas7d  = (await pool.query(q(7),  [terapeutaId])).rows[0]?.c ?? 0;
      notas30d = (await pool.query(q(30), [terapeutaId])).rows[0]?.c ?? 0;
    }

    // Módulos 30d
    let modulos:any[] = [];
    if (run.table && run.map.tipo && run.map.terapeuta_id && run.map.inicio && isDateLike(run.byName[run.map.inicio])) {
      const { rows } = await pool.query(
        `SELECT ${run.map.tipo} as tipo, COUNT(*)::int as total
           FROM ${run.table}
          WHERE ${run.map.terapeuta_id}=$1
            AND ${run.map.inicio} >= NOW() - INTERVAL '30 days'
       GROUP BY ${run.map.tipo}
       ORDER BY total DESC`,
        [terapeutaId]
      );
      modulos = rows;
    }

    res.json({
      pacientes: { total: pacientesTotal, ult7d: pacientes7d, ult30d: pacientes30d },
      notas:     { ult7d: notas7d, ult30d: notas30d },
      modulos_30d: modulos,
    });
  } catch (e:any) {
    console.error('GET /stats/overview error', e);
    res.status(500).json({ error:'Error interno' });
  }
});

// ========== AUDITORÍA DE PACIENTES (filtros + paginación + conteo comentarios) ==========
router.get('/pacientes', requireAuth, async (req:any, res) => {
  try {
    const terapeutaId = req.user?.id;
    if (!terapeutaId) return res.status(401).json({ error: 'No autorizado' });

    const qRaw   = String(req.query.q ?? '').trim().toLowerCase();
    const sexoQ  = String(req.query.sexo ?? '').toUpperCase(); // 'M'|'F'
    const order  = String(req.query.order ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit  = Math.max(1, Math.min(200, Number(req.query.limit ?? 10)));
    const page   = Math.max(1, Number(req.query.page ?? 1));
    const offset = (page - 1) * limit;

    const pac = await discover(PACIENTES_TABLES, PACIENTES_COLS);
    const ses = await discover(SESIONES_TABLES,  SESIONES_COLS);
    const cmt = await discover(COMENTARIOS_TABLES, COMENTARIOS_COLS);
    if (!pac.table || !pac.map.id) return res.json({ total:0, page, limit, data: [] });

    const creadoCol      = pac.map.creado;
    const actualizadoCol = pac.map.actualizado;
    const creadoIsDate      = creadoCol      ? isDateLike(pac.byName[creadoCol])      : false;
    const actualizadoIsDate = actualizadoCol ? isDateLike(pac.byName[actualizadoCol]) : false;

    // Base: pacientes propios del terapeuta
    const wh: string[] = [];
    const params: any[] = [];

    if (pac.map.owner_terapeuta_id) {
      wh.push(`p.${pac.map.owner_terapeuta_id} = $${params.length + 1}`);
      params.push(terapeutaId);
    } else if (ses.table && ses.map.paciente_id && ses.map.terapeuta_id) {
      wh.push(`EXISTS (SELECT 1 FROM ${ses.table} s WHERE s.${ses.map.paciente_id} = p.${pac.map.id} AND s.${ses.map.terapeuta_id} = $${params.length + 1})`);
      params.push(terapeutaId);
    }

    if ((sexoQ === 'M' || sexoQ === 'F') && pac.map.sexo) {
      wh.push(`p.${pac.map.sexo} = $${params.length + 1}`);
      params.push(sexoQ);
    }

    if (qRaw && (pac.map.nombres || pac.map.apellidos)) {
      if (pac.map.nombres && pac.map.apellidos) {
        wh.push(`LOWER(COALESCE(p.${pac.map.apellidos}, '') || ' ' || COALESCE(p.${pac.map.nombres}, '')) LIKE $${params.length + 1}`);
        params.push(`%${qRaw}%`);
      } else if (pac.map.nombres) {
        wh.push(`LOWER(p.${pac.map.nombres}) LIKE $${params.length + 1}`);
        params.push(`%${qRaw}%`);
      } else {
        wh.push(`LOWER(p.${pac.map.apellidos}) LIKE $${params.length + 1}`);
        params.push(`%${qRaw}%`);
      }
    }

    const whereSQL = wh.length ? `WHERE ${wh.join(' AND ')}` : '';

    // Fallbacks de fechas por actividad del terapeuta (si el paciente no tiene columnas de fecha reales)
    const creadoExpr = creadoIsDate
      ? `p.${creadoCol}`
      : (ses.table && ses.map.fecha && ses.map.paciente_id && ses.map.terapeuta_id && isDateLike(ses.byName[ses.map.fecha]))
        ? `(SELECT MIN(${ses.map.fecha}) FROM ${ses.table} s WHERE s.${ses.map.paciente_id}=p.${pac.map.id} AND s.${ses.map.terapeuta_id}=$1)`
        : `NULL`;

    const actualizadoExpr = actualizadoIsDate
      ? `p.${actualizadoCol}`
      : (ses.table && ses.map.fecha && ses.map.paciente_id && ses.map.terapeuta_id && isDateLike(ses.byName[ses.map.fecha]))
        ? `(SELECT MAX(${ses.map.fecha}) FROM ${ses.table} s WHERE s.${ses.map.paciente_id}=p.${pac.map.id} AND s.${ses.map.terapeuta_id}=$1)`
        : `NULL`;

    // Conteo de COMENTARIOS (join comentarios -> sesiones)
    const comentariosCountExpr =
      (cmt.table && cmt.map.sesion_id && ses.table && ses.map.id && ses.map.paciente_id && ses.map.terapeuta_id)
        ? `(
             SELECT COUNT(c.${cmt.map.id ?? 'id'})
               FROM ${cmt.table} c
               JOIN ${ses.table} s2 ON s2.${ses.map.id} = c.${cmt.map.sesion_id}
              WHERE s2.${ses.map.paciente_id} = p.${pac.map.id}
                AND s2.${ses.map.terapeuta_id} = $1
           )::int`
        : `0::int`;

    // total para paginar
    const totalSQL = `SELECT COUNT(*) AS c FROM ${pac.table} p ${whereSQL}`;
    const totalR = await pool.query(totalSQL, params);
    const total = Number(totalR.rows?.[0]?.c ?? 0);

    // page select
    const orderBy = `${actualizadoIsDate ? actualizadoExpr : (creadoIsDate ? creadoExpr : `p.${pac.map.id}`)} ${order}`;
    const select = `
      SELECT
        p.${pac.map.id} AS id,
        ${pac.map.apellidos ? `p.${pac.map.apellidos}` : `''`} AS apellidos,
        ${pac.map.nombres ? `p.${pac.map.nombres}` : `''`} AS nombres,
        ${pac.map.sexo ? `p.${pac.map.sexo}` : `NULL`} AS sexo,
        ${pac.map.edad ? `p.${pac.map.edad}` : `NULL`} AS edad,
        ${pac.map.owner_terapeuta_id ? `p.${pac.map.owner_terapeuta_id}` : `NULL`} AS terapeuta_id,
        ${creadoExpr} AS creado,
        ${actualizadoExpr} AS actualizado,
        ${comentariosCountExpr} AS comentarios_count
      FROM ${pac.table} p
      ${whereSQL}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;

    // Asegurar $1 = terapeutaId si fue usado en subconsultas
    const pageParams = params.length ? params : [terapeutaId];

    const { rows } = await pool.query(select, pageParams);
    return res.json({ total, page, limit, data: rows });
  } catch (e:any) {
    console.error('GET /stats/pacientes error', e);
    res.status(500).json({ error:'Error interno' });
  }
});

// ========== MÓDULOS ==========
router.get('/modulos', requireAuth, async (req:any, res) => {
  try {
    const terapeutaId = req.user?.id;
    if (!terapeutaId) return res.status(401).json({ error: 'No autorizado' });
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));

    const run = await discover(RUNS_TABLES, RUNS_COLS);
    if (!run.table || !run.map.tipo || !run.map.terapeuta_id || !run.map.inicio || !isDateLike(run.byName[run.map.inicio])) return res.json([]);

    const { rows } = await pool.query(
      `SELECT ${run.map.tipo} as tipo, COUNT(*)::int as total
         FROM ${run.table}
        WHERE ${run.map.terapeuta_id}=$1
          AND ${run.map.inicio} >= NOW() - INTERVAL '${days} days'
     GROUP BY ${run.map.tipo}
     ORDER BY total DESC`,
      [terapeutaId]
    );
    res.json(rows);
  } catch (e:any) {
    console.error('GET /stats/modulos error', e);
    res.status(500).json({ error:'Error interno' });
  }
});

// === GET /stats/modulo/:tipo/summary?days=30
router.get('/modulo/:tipo/summary', requireAuth, async (req: any, res) => {
  try {
    const terapeutaId = req.user?.id;
    if (!terapeutaId) return res.status(401).json({ error: 'No autorizado' });

    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const tipo = mapTipoModulo(req.params.tipo);

    const sql = `
      SELECT
        COUNT(*)::int                                                AS total,
        COUNT(*) FILTER (WHERE r.fin IS NOT NULL)::int               AS total_con_fin,
        ROUND(AVG(EXTRACT(EPOCH FROM (r.fin - r.inicio)))
              FILTER (WHERE r.fin IS NOT NULL)::numeric, 2)          AS avg_duracion_s,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP
              (ORDER BY EXTRACT(EPOCH FROM (r.fin - r.inicio)))
              FILTER (WHERE r.fin IS NOT NULL), 2)                   AS p95_duracion_s
      FROM runs_modulo r
      JOIN sesiones s ON s.id = r.sesion_id
      WHERE s.terapeuta_id = $1
        AND r.tipo = $2
        AND r.inicio >= NOW() - INTERVAL '${days} days'
    `;
    const { rows } = await pool.query(sql, [terapeutaId, tipo]);
    res.json(rows[0] ?? { total:0, total_con_fin:0, avg_duracion_s:null, p95_duracion_s:null });
  } catch (e:any) {
    console.error('GET /stats/modulo/:tipo/summary error', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// === GET /stats/modulo/:tipo/series?days=30
router.get('/modulo/:tipo/series', requireAuth, async (req:any, res) => {
  try {
    const terapeutaId = req.user?.id;
    if (!terapeutaId) return res.status(401).json({ error:'No autorizado' });

    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const tipo = mapTipoModulo(req.params.tipo);

    const sql = `
      SELECT date_trunc('day', r.inicio)::date AS dia, COUNT(*)::int AS total
      FROM runs_modulo r
      JOIN sesiones s ON s.id = r.sesion_id
      WHERE s.terapeuta_id = $1
        AND r.tipo = $2
        AND r.inicio >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY 1
    `;
    const { rows } = await pool.query(sql, [terapeutaId, tipo]);
    res.json(rows);
  } catch (e:any) {
    console.error('GET /stats/modulo/:tipo/series error', e);
    res.status(500).json({ error:'Error interno' });
  }
});

// === GET /stats/modulo/:tipo/top-pacientes?days=30&limit=10
router.get('/modulo/:tipo/top-pacientes', requireAuth, async (req:any, res) => {
  try {
    const terapeutaId = req.user?.id;
    if (!terapeutaId) return res.status(401).json({ error:'No autorizado' });

    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 10));
    const tipo = mapTipoModulo(req.params.tipo);

    const sql = `
      SELECT s.paciente_id, COUNT(*)::int AS total
      FROM runs_modulo r
      JOIN sesiones s ON s.id = r.sesion_id
      WHERE s.terapeuta_id = $1
        AND r.tipo = $2
        AND r.inicio >= NOW() - INTERVAL '${days} days'
      GROUP BY s.paciente_id
      ORDER BY total DESC
      LIMIT ${limit}
    `;
    const { rows } = await pool.query(sql, [terapeutaId, tipo]);
    res.json(rows);
  } catch (e:any) {
    console.error('GET /stats/modulo/:tipo/top-pacientes error', e);
    res.status(500).json({ error:'Error interno' });
  }
});

// ========== NOTAS RECIENTES ==========
router.get('/notas', requireAuth, async (req:any, res) => {
  try {
    const terapeutaId = req.user?.id;
    if (!terapeutaId) return res.status(401).json({ error: 'No autorizado' });
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));

    const ses = await discover(SESIONES_TABLES, SESIONES_COLS);
    if (!ses.table || !ses.map.terapeuta_id || !ses.map.fecha || !isDateLike(ses.byName[ses.map.fecha])) return res.json([]);

    const select = [
      ses.map.id ? `${ses.map.id} as id` : 'NULL as id',
      ses.map.paciente_id ? `${ses.map.paciente_id} as paciente_id` : 'NULL as paciente_id',
      ses.map.terapeuta_id ? `${ses.map.terapeuta_id} as terapeuta_id` : 'NULL as terapeuta_id',
      `${ses.map.fecha} as fecha`,
      ses.map.titulo ? `${ses.map.titulo} as titulo` : `NULL as titulo`,
      ses.map.nota ? `${ses.map.nota} as nota` : `NULL as nota`,
    ].join(', ');

    const sql = `
      SELECT ${select}
        FROM ${ses.table}
       WHERE ${ses.map.terapeuta_id}=$1
    ORDER BY ${ses.map.fecha} DESC
       LIMIT ${limit}
    `;
    const { rows } = await pool.query(sql, [terapeutaId]);
    res.json(rows);
  } catch (e:any) {
    console.error('GET /stats/notas error', e);
    res.status(500).json({ error:'Error interno' });
  }
});

export default router;
