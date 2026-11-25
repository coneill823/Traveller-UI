/**
 * Sign-in for a small trusted table: the GM has a passphrase, each player has an invite code.
 * Either is exchanged for a session token that the browser keeps. Secrets live in the key-value
 * store, never in entities, so they cannot leak through the sync channel.
 */
import crypto from 'node:crypto';
import type { Id } from '../shared/types';
import type { Persistence } from './db';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function prettyCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export class Auth {
  private kv: Map<string, string>;
  /** One-time code printed to the server console; whoever can read the console may claim the GM seat. */
  readonly setupCode = randomCode(8);
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private persistence: Persistence,
    private envGmPassword?: string,
  ) {
    this.kv = persistence.loadKv();
  }

  private set(key: string, value: string): void {
    this.kv.set(key, value);
    this.persistence.setKv(key, value);
  }

  private del(key: string): void {
    this.kv.delete(key);
    this.persistence.deleteKv(key);
  }

  // ── GM ──

  get gmPlayerId(): Id | undefined {
    return this.kv.get('gm:playerId');
  }

  hasGm(): boolean {
    return this.gmPlayerId !== undefined;
  }

  claimGm(playerId: Id, password: string | undefined): void {
    this.set('gm:playerId', playerId);
    if (password) this.set('gm:password', hashPassword(password));
  }

  setGmPassword(password: string): void {
    this.set('gm:password', hashPassword(password));
  }

  checkGmPassword(password: string): boolean {
    if (this.envGmPassword && safeEqual(password, this.envGmPassword)) return true;
    const stored = this.kv.get('gm:password');
    return stored ? verifyPassword(password, stored) : false;
  }

  // ── players ──

  inviteFor(playerId: Id): string {
    let code = this.kv.get(`invite:${playerId}`);
    if (!code) code = this.resetInvite(playerId);
    return code;
  }

  resetInvite(playerId: Id): string {
    const old = this.kv.get(`invite:${playerId}`);
    if (old) this.del(`code:${old}`);
    let code = randomCode(8);
    while (this.kv.has(`code:${code}`)) code = randomCode(8);
    this.set(`invite:${playerId}`, code);
    this.set(`code:${code}`, playerId);
    return code;
  }

  playerForCode(code: string): Id | undefined {
    return this.kv.get(`code:${normaliseCode(code)}`);
  }

  forgetPlayer(playerId: Id): void {
    const code = this.kv.get(`invite:${playerId}`);
    if (code) this.del(`code:${code}`);
    this.del(`invite:${playerId}`);
    this.revokeAll(playerId);
  }

  // ── sessions ──

  createSession(playerId: Id): string {
    const token = crypto.randomBytes(32).toString('base64url');
    this.set(`session:${sha256(token)}`, JSON.stringify({ playerId, createdAt: Date.now() }));
    return token;
  }

  resolve(token: string | undefined): Id | undefined {
    if (!token) return undefined;
    const raw = this.kv.get(`session:${sha256(token)}`);
    if (!raw) return undefined;
    try {
      return (JSON.parse(raw) as { playerId: Id }).playerId;
    } catch {
      return undefined;
    }
  }

  revoke(token: string): void {
    this.del(`session:${sha256(token)}`);
  }

  revokeAll(playerId: Id): void {
    for (const [key, raw] of [...this.kv]) {
      if (!key.startsWith('session:')) continue;
      try {
        if ((JSON.parse(raw) as { playerId: Id }).playerId === playerId) this.del(key);
      } catch {
        this.del(key);
      }
    }
  }

  // ── throttling ──

  /** Returns false when this address has failed too many sign-ins recently. */
  allowAttempt(address: string): boolean {
    const now = Date.now();
    const entry = this.failures.get(address);
    if (!entry || entry.resetAt < now) return true;
    return entry.count < 10;
  }

  recordFailure(address: string): void {
    const now = Date.now();
    const entry = this.failures.get(address);
    if (!entry || entry.resetAt < now) this.failures.set(address, { count: 1, resetAt: now + 60_000 });
    else entry.count++;
  }
}
