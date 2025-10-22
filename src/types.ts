export type Rol = 'ADMINISTRADOR' | 'TERAPEUTA';
export type UsuarioDb = {
  id: number; nombre: string; correo: string;
  password_hash: string; rol: Rol; activo: boolean;
};
