import { Router } from 'express';
import { pool } from './db';
import { requireAuth } from './mw/auth';
import bcrypt from 'bcrypt';

const router = Router();

/** 1) Autenticación */
router.use(requireAuth as any);

/** 2) Autorización (solo ADMIN) */
function ensureAdmin(req: any, res: any, next: any) {
  if (req.user?.rol !== 'ADMINISTRADOR') {
    return res.status(403).json({ error: 'Acceso solo para ADMINISTRADOR' });
  }
  next();
}
router.use(ensureAdmin);

/** Helper: columnas que espera el front (alias) */
const SELECT_COLUMNS = `
  id, rol, nombre, apellido, email, activo,
  fecha_crea     AS fecha_ingreso,
  fecha_modifica AS fecha_modifica
`;

/** GET /usuarios?q=&rol=ADMINISTRADOR|TERAPEUTA */
router.get('/', async (req, res, next) => {
  try {
    const { q, rol } = req.query as { q?: string; rol?: 'ADMINISTRADOR' | 'TERAPEUTA' };
    const params: any[] = [];
    const wh: string[] = [];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      wh.push(
        `(LOWER(nombre) LIKE $${params.length} OR LOWER(apellido) LIKE $${params.length} OR LOWER(email) LIKE $${params.length})`
      );
    }
    if (rol) {
      params.push(rol);
      wh.push(`rol = $${params.length}`);
    }

    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const sql = `
      SELECT ${SELECT_COLUMNS}
      FROM usuarios
      ${where}
      ORDER BY id DESC
      LIMIT 200
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** GET /usuarios/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM usuarios WHERE id=$1 LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /usuarios  { nombre, apellido, email, rol, password } */
router.post('/', async (req, res, next) => {
  try {
    const { nombre, apellido, email, rol, password } = req.body || {};
    if (!nombre || !apellido || !email || !rol || !password) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    if (!['ADMINISTRADOR', 'TERAPEUTA'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // email único
    const dupe = await pool.query(
      'SELECT 1 FROM usuarios WHERE LOWER(email)=LOWER($1) LIMIT 1',
      [email]
    );
    if (dupe.rowCount) {
      return res.status(409).json({ error: 'El correo ya está registrado' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO usuarios (rol, nombre, apellido, email, password_hash, activo)
       VALUES ($1,$2,$3,$4,$5,true)
       RETURNING ${SELECT_COLUMNS}`,
      [rol, nombre, apellido, email, hash]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /usuarios/:id/activo  { activo: boolean } */
router.post('/:id/activo', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { activo } = req.body || {};
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
    if (typeof activo !== 'boolean') return res.status(400).json({ error: 'activo debe ser boolean' });

    const { rows } = await pool.query(
      `UPDATE usuarios
         SET activo = $1,
             fecha_modifica = NOW()
       WHERE id = $2
       RETURNING ${SELECT_COLUMNS}`,
      [activo, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /usuarios/:id
 *  - No permite cambiar rol (se ignora si viene)
 *  - No cambia 'activo' (para eso está POST /:id/activo)
 *  - Permite cambio de contraseña si llega 'password' (>=6); si no llega/viene vacío, no se toca
 *  - Valida email único contra otros usuarios
 */
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    // campos del body
    let { nombre, apellido, email, /* rol, activo, */ password } = req.body || {};

    // Validación de email único (excluye el propio id)
    if (email) {
      const dupe = await pool.query(
        'SELECT 1 FROM usuarios WHERE LOWER(email)=LOWER($1) AND id<>$2 LIMIT 1',
        [email, id]
      );
      if (dupe.rowCount) {
        return res.status(409).json({ error: 'El correo ya está registrado' });
      }
    }

    // Construcción dinámica del UPDATE
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;

    if (nombre !== undefined)   { sets.push(`nombre = $${i++}`);   vals.push(nombre); }
    if (apellido !== undefined) { sets.push(`apellido = $${i++}`); vals.push(apellido); }
    if (email !== undefined)    { sets.push(`email = $${i++}`);    vals.push(email); }
    // NO tocamos rol ni activo aquí (reglas de negocio)

    // Cambio de contraseña opcional
    if (password !== undefined && String(password).length > 0) {
      if (String(password).length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      }
      const hash = await bcrypt.hash(String(password), 10);
      sets.push(`password_hash = $${i++}`);
      vals.push(hash);
    }

    // Siempre actualizar fecha_modifica
    sets.push(`fecha_modifica = NOW()`);

    // Si no hay nada que actualizar, devolver estado actual
    if (sets.length === 1) { // solo fecha_modifica
      const { rows } = await pool.query(
        `SELECT ${SELECT_COLUMNS} FROM usuarios WHERE id=$1 LIMIT 1`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
      return res.json(rows[0]);
    }

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE usuarios
          SET ${sets.join(', ')}
        WHERE id = $${i}
        RETURNING ${SELECT_COLUMNS}`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** DELETE /usuarios/:id  (Admin no puede eliminar su propia cuenta) */
router.delete('/:id', async (req: any, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const requesterId = Number(req.user?.id);
    if (requesterId === id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    }

    const { rows } = await pool.query(
      `DELETE FROM usuarios
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json(rows[0]); // devolvemos el eliminado
  } catch (err) {
    next(err);
  }
});

export default router;
