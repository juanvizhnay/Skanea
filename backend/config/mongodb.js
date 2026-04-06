import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Permitir definir credenciales por partes para asegurar encode correcto del password
const PARTS_USER = process.env.MONGODB_USER;
const PARTS_PASS = process.env.MONGODB_PASS;
const PARTS_HOST = process.env.MONGODB_HOST; // ej: cluster0.xxxxx.mongodb.net
const PARTS_DB = process.env.MONGODB_DB || 'skanea';
const PARTS_OPTIONS = process.env.MONGODB_OPTIONS || 'retryWrites=true&w=majority&appName=Cluster0';

let MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/skanea';
if (!process.env.MONGODB_URI && PARTS_USER && PARTS_PASS && PARTS_HOST) {
  const user = encodeURIComponent(PARTS_USER);
  const pass = encodeURIComponent(PARTS_PASS);
  MONGODB_URI = `mongodb+srv://${user}:${pass}@${PARTS_HOST}/${PARTS_DB}?${PARTS_OPTIONS}`;
}

// Mostrar el URI (sin password) para debug sólo si está habilitado
const safeUri = MONGODB_URI.replace(/:\S+@/, ':***@');

let isConnecting = false;

const connectMongoDB = async () => {
  if (isConnecting || mongoose.connection.readyState === 1) return;
  isConnecting = true;
  try {
    if (process.env.REQUEST_LOGS === '1') {
      console.log(`Conectando a MongoDB en: ${safeUri}`);
    }
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 20000
    });
    if (process.env.REQUEST_LOGS === '1') {
      console.log('MongoDB conectado exitosamente');
    }
  } catch (error) {
    // No matar el proceso; que el server siga y reintente desde server.js
    if (process.env.REQUEST_LOGS === '1') {
      console.warn('Error conectando a MongoDB (no se detiene el server):', error?.message);
    }
    throw error;
  } finally {
    isConnecting = false;
  }
};

// Eventos de conexión (silenciosos por defecto)
mongoose.connection.on('connected', () => {
  if (process.env.REQUEST_LOGS === '1') console.log('Conexión a MongoDB establecida');
});

mongoose.connection.on('error', (err) => {
  if (process.env.REQUEST_LOGS === '1') console.error('Error de MongoDB:', err?.message || err);
});

mongoose.connection.on('disconnected', () => {
  if (process.env.REQUEST_LOGS === '1') console.log('MongoDB desconectado');
});

process.on('SIGINT', async () => {
  try {
    await mongoose.connection.close();
  } finally {
    if (process.env.REQUEST_LOGS === '1') console.log('Conexión a MongoDB cerrada por SIGINT');
    process.exit(0);
  }
});

export { connectMongoDB, mongoose }; 