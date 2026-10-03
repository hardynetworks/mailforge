import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function newApiKey() {
  const secret = crypto.randomBytes(24).toString('base64url');
  const key = `mf_${secret}`;
  return { key, prefix: key.slice(0, 10), hash: sha256(key) };
}

export function signSession(userId: string) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: '14d' });
}
export function verifySession(token: string): string | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as any;
    return p.sub as string;
  } catch {
    return null;
  }
}

// HMAC signature for tracking / unsubscribe links
export function sign(data: string) {
  return crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url').slice(0, 22);
}
export function checkSig(data: string, sig: string) {
  const a = Buffer.from(sign(data));
  const b = Buffer.from(sig || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function generateDkimKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pub = publicKey.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  return { privateKey, publicKey: pub };
}

export const hmacHex = (secret: string, body: string) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');
