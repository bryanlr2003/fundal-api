import { Router } from "express";
import { pool } from "./db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

// importa SOLO el valor en runtime
import { requireAuth } from "./mw/auth.js";
// importa el TIPO como type-only (no aparece en runtime)
import type { AuthedRequest } from "./mw/auth.js";

const router = Router();
const sign = (p: object) =>
  jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: process.env.JWT_EXPIRES || "2h" });

// helper: compara hash si lo es, si no, compara texto plano
async function checkPassword(input: string, stored: string) {
  if (stored.startsWith("$2")) return bcrypt.compare(input, stored); // bcrypt
  return input === stored; // texto plano (temporal)
}

router.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const user = (req as AuthedRequest).user as any;
    res.json({
      id: user.id,
      rol: user.rol,
      nombre: user.nombre,
      apellido: user.apellido,
      email: user.email,
    });
  } catch (e:any) {
    res.status(500).json({ error: "Error interno" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Faltan credenciales" });

    const q = `
      SELECT id, rol, nombre, apellido, email, password_hash, activo
      FROM public.usuarios
      WHERE email=$1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [email]);
    const u = rows[0];
    if (!u || !u.activo) return res.status(401).json({ error: "Usuario/clave inválidos" });

    const ok = await checkPassword(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: "Usuario/clave inválidos" });

    const token = sign({ id: u.id, rol: u.rol, nombre: u.nombre, apellido: u.apellido, email: u.email });
    res.json({
      token,
      usuario: { id: u.id, rol: u.rol, nombre: u.nombre, apellido: u.apellido, email: u.email }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
