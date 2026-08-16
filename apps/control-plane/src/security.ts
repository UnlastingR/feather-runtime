import type { Context, Next } from 'hono';
import type { Env } from './env.js';

type AppContext = Context<{
  Bindings: Env;
  Variables: { actorId: string; userId: string | null; scopes: string[] };
}>;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function digestHex(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function publicAuth(c: AppContext, next: Next): Promise<Response | void> {
  if (c.env.AUTH_DISABLED === '1') {
    c.set('actorId', 'local-dev');
    c.set('userId', null);
    c.set('scopes', ['admin', 'tasks:read', 'tasks:write', 'artifacts:read']);
    return next();
  }
  const authorization = c.req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = authorization.slice('Bearer '.length);
  const tokenHash = await digestHex(`${c.env.API_HASH_PEPPER}:${token}`);
  const row = await c.env.DB.prepare(
    'SELECT id,user_id,scopes FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL',
  )
    .bind(tokenHash)
    .first<{ id: string; user_id: string | null; scopes: string }>();
  if (!row) return c.json({ error: 'unauthorized' }, 401);
  const scopes = row.scopes.split(/[ ,]+/).filter(Boolean);
  if (row.user_id === null && !scopes.includes('admin')) {
    return c.json(
      { error: 'misconfigured_api_key', message: 'Non-admin API keys must belong to a user.' },
      403,
    );
  }
  c.set('actorId', row.id);
  c.set('userId', row.user_id);
  c.set('scopes', scopes);
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?')
      .bind(Date.now(), row.id)
      .run(),
  );
  return next();
}

export function requireScope(scope: string) {
  return async (c: AppContext, next: Next): Promise<Response | void> => {
    const scopes = c.get('scopes') ?? [];
    if (!scopes.includes('admin') && !scopes.includes(scope))
      return c.json({ error: 'forbidden', requiredScope: scope }, 403);
    return next();
  };
}

async function importEncryptionKey(encoded: string): Promise<CryptoKey> {
  const raw = base64ToBytes(encoded);
  if (raw.byteLength !== 32)
    throw new Error('NODE_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return crypto.subtle.importKey('raw', exactArrayBuffer(raw), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function sealNodeSecret(secret: string, encryptionKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(encryptionKey);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret)),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return bytesToBase64(combined);
}

async function openNodeSecret(sealed: string, encryptionKey: string): Promise<string> {
  const combined = base64ToBytes(sealed);
  if (combined.byteLength < 29) throw new Error('Invalid encrypted node secret');
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const key = await importEncryptionKey(encryptionKey);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function verifyHmac(
  secret: string,
  canonical: string,
  signatureHex: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signature = Uint8Array.from(signatureHex.match(/.{2}/g) ?? [], (hex) =>
    Number.parseInt(hex, 16),
  );
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(canonical));
}

export async function internalHmacAuth(c: AppContext, next: Next): Promise<Response | void> {
  const nodeId = c.req.header('x-feather-node-id');
  const timestamp = c.req.header('x-feather-timestamp');
  const nonce = c.req.header('x-feather-nonce');
  const signature = c.req.header('x-feather-signature');
  if (!nodeId || !timestamp || !nonce || !signature)
    return c.json({ error: 'missing_hmac_headers' }, 401);
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 300_000)
    return c.json({ error: 'stale_signature' }, 401);
  const node = await c.env.DB.prepare('SELECT hmac_key_enc,status FROM nodes WHERE id=?')
    .bind(nodeId)
    .first<{ hmac_key_enc: string; status: string }>();
  if (!node || node.status === 'disabled') return c.json({ error: 'unknown_node' }, 401);
  const body = await c.req.raw.clone().arrayBuffer();
  const bodyHash = await digestHex(body);
  const canonical = [
    c.req.method.toUpperCase(),
    new URL(c.req.url).pathname,
    bodyHash,
    timestamp,
    nonce,
  ].join('\n');
  const secret = await openNodeSecret(node.hmac_key_enc, c.env.NODE_KEY_ENCRYPTION_KEY);
  if (!(await verifyHmac(secret, canonical, signature)))
    return c.json({ error: 'bad_signature' }, 401);
  try {
    await c.env.DB.prepare('INSERT INTO hmac_nonces(node_id,nonce,expires_at) VALUES(?,?,?)')
      .bind(nodeId, nonce, timestampMs + 300_000)
      .run();
  } catch {
    return c.json({ error: 'replayed_nonce' }, 401);
  }
  c.set('actorId', nodeId);
  c.set('userId', null);
  c.set('scopes', ['internal']);
  c.executionCtx.waitUntil(
    c.env.DB.prepare('DELETE FROM hmac_nonces WHERE expires_at < ?').bind(Date.now()).run(),
  );
  return next();
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  if (typeof value === 'string') return digestHex(value);
  const arrayBuffer = value instanceof Uint8Array ? exactArrayBuffer(value) : value;
  return digestHex(arrayBuffer);
}
