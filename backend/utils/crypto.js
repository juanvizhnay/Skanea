import crypto from 'crypto';

const KEY_B64 = process.env.TOKEN_ENC_KEY || '';

function getKey() {
  const raw = Buffer.from(KEY_B64, 'base64');
  if (raw.length !== 32) {
    throw new Error('TOKEN_ENC_KEY inválida. Debe ser base64 de 32 bytes');
  }
  return raw;
}

export function encryptToBase64(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertextB64: Buffer.concat([ciphertext, tag]).toString('base64'),
    ivB64: iv.toString('base64')
  };
}

export function decryptFromBase64(ciphertextB64, ivB64) {
  const key = getKey();
  const buf = Buffer.from(ciphertextB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = buf.slice(buf.length - 16);
  const ciphertext = buf.slice(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return plaintext;
}


