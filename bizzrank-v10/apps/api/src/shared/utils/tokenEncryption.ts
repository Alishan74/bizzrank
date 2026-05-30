/**
 * Token encryption at rest — AES-256-GCM
 *
 * GBP access/refresh tokens are encrypted before DB storage.
 * An AES_ENCRYPTION_KEY (32-byte hex) env var is required.
 * If not set, a warning is logged and tokens are stored plain
 * (allows dev to run without setting up encryption).
 *
 * To generate a key:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
import crypto from 'crypto';
 
const KEY_HEX = process.env.AES_ENCRYPTION_KEY ?? '';
const ALGORITHM = 'aes-256-gcm';
 
function getKey(): Buffer | null {
  if (!KEY_HEX || KEY_HEX.length !== 64) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[TokenEncryption] AES_ENCRYPTION_KEY not set or invalid — tokens stored unencrypted!');
    }
    return null;
  }
  return Buffer.from(KEY_HEX, 'hex');
}
 
export function encryptToken(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext; // dev fallback — no encryption
 
  const iv         = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher     = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();
 
  // Store as: iv:authTag:ciphertext (all base64)
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}
 
export function decryptToken(stored: string): string {
  const key = getKey();
  if (!key || !stored.includes(':')) return stored; // not encrypted or no key
 
  try {
    const [ivB64, tagB64, dataB64] = stored.split(':');
    const iv       = Buffer.from(ivB64,  'base64');
    const authTag  = Buffer.from(tagB64, 'base64');
    const data     = Buffer.from(dataB64,'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return stored; // decryption failed — return as-is (handles migration from plain text)
  }
}
