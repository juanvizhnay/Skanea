import pool from '../config/db.js';

const createUser = async (email, hashedPassword, nombre, telefono, email_verification_token = null, email_verification_expires = null) => {
  const result = await pool.query(
    `INSERT INTO usuarios (email, password, nombre, telefono, email_verification_token, email_verification_expires)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [email, hashedPassword, nombre, telefono, email_verification_token, email_verification_expires]
  );
  return result.rows[0];
};

const findUserByEmail = async (email) => {
  const result = await pool.query(
    'SELECT * FROM usuarios WHERE email = $1',
    [email]
  );
  return result.rows[0];
};

const updateTelefono = async (userId, telefono) => {
  const result = await pool.query(
    'UPDATE usuarios SET telefono = $1 WHERE id = $2 RETURNING *',
    [telefono, userId]
  );
  return result.rows[0];
};

const setEmailVerified = async (userId) => {
  const result = await pool.query(
    `UPDATE usuarios SET email_verificado = TRUE, email_verification_token = NULL, email_verification_expires = NULL WHERE id = $1 RETURNING *`,
    [userId]
  );
  return result.rows[0];
};

const setEmailVerificationToken = async (userId, token, expires) => {
  const result = await pool.query(
    `UPDATE usuarios SET email_verification_token = $1, email_verification_expires = $2 WHERE id = $3 RETURNING *`,
    [token, expires, userId]
  );
  return result.rows[0];
};

const findUserByVerificationToken = async (token) => {
  const result = await pool.query(
    'SELECT * FROM usuarios WHERE email_verification_token = $1',
    [token]
  );
  return result.rows[0];
};

const setPasswordResetToken = async (userId, token, expires) => {
  const result = await pool.query(
    `UPDATE usuarios SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3 RETURNING *`,
    [token, expires, userId]
  );
  return result.rows[0];
};

const findUserByPasswordResetToken = async (token) => {
  const result = await pool.query(
    'SELECT * FROM usuarios WHERE password_reset_token = $1 AND password_reset_expires > NOW()',
    [token]
  );
  return result.rows[0];
};

const updatePassword = async (email, hashedPassword) => {
  const result = await pool.query(
    'UPDATE usuarios SET password = $1 WHERE email = $2 RETURNING *',
    [hashedPassword, email]
  );
  return result.rows[0];
};

export default {
  createUser,
  findUserByEmail,
  updateTelefono,
  setEmailVerified,
  setEmailVerificationToken,
  findUserByVerificationToken,
  setPasswordResetToken,
  findUserByPasswordResetToken,
  updatePassword
};

export async function findUserById(id) {
  const result = await pool.query(
    'SELECT * FROM usuarios WHERE id = $1',
    [id]
  );
  return result.rows[0];
} 

export async function findUserByTelefono(telefono) {
  const result = await pool.query(
    'SELECT * FROM usuarios WHERE telefono = $1',
    [telefono]
  );
  return result.rows[0];
}