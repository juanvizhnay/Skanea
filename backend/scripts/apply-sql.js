import fs from 'fs';
import path from 'path';
import url from 'url';
import dotenv from 'dotenv';
import pkg from 'pg';

dotenv.config({ path: path.resolve(process.cwd(), 'backend', '.env') });

const { Client } = pkg;

async function run() {
  const sqlPath = path.resolve(process.cwd(), 'backend', 'scripts', 'connectors.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  console.log(`Connecting to postgres ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} as ${process.env.DB_USER}`);
  await client.connect();
  try {
    await client.query(sql);
    console.log('✅ SQL aplicado correctamente');
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('❌ Error aplicando SQL:', err);
  process.exit(1);
});


