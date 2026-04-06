import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'skanea_secret';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  // El token debe venir como: Bearer <token>
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Token no proporcionado.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ message: 'Token inválido o expirado.' });
    }
    req.user = user; // user contiene el payload del token
    next();
  });
} 

export default authenticateToken;