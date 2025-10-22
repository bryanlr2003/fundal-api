// api-fundal/src/index.ts
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';

// Routers existentes
import authRouter from './auth.js';
import usuariosRouter from './usuarios.js';
import pacientesRouter from './pacientes.js';
import sesionesRouter from './sesiones.js';
import statsRouter from './stats.js';

// Router nuevo de comentarios de sesión
import comentariosSesionRouter from './routes/comentarios_sesion.js';

const app = express();

// Middlewares base
app.use(cors());
app.use(express.json());

// DB pool
const DATABASE_URL = process.env.DATABASE_URL as string;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL en variables de entorno');
  process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL });
app.set('db', pool);

// Rutas
app.use('/auth', authRouter);
app.use('/usuarios', usuariosRouter);
app.use('/pacientes', pacientesRouter);
app.use('/sesiones', sesionesRouter);
app.use('/stats', statsRouter);

// Montamos los endpoints de comentarios bajo /sesiones
app.use('/sesiones', comentariosSesionRouter);

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

// Arranque
const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`API FUNDAL escuchando en puerto ${PORT}`);
});
