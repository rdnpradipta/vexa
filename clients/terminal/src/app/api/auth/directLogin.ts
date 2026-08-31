import { scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
const FORMAT = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/;
const KEY_LENGTH = 64;

type DirectLoginConfig = {
  emails: Set<string>;
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
};

function parseConfig(): DirectLoginConfig | null {
  const emails = new Set(
    (process.env.VEXA_DIRECT_LOGIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  const match = FORMAT.exec((process.env.VEXA_DIRECT_LOGIN_PASSWORD_SCRYPT || "").trim());
  if (!emails.size || !match) return null;

  const n = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const salt = Buffer.from(match[4], "base64url");
  const expected = Buffer.from(match[5], "base64url");
  if (!Number.isSafeInteger(n) || n < 16384 || (n & (n - 1)) !== 0) return null;
  if (!Number.isSafeInteger(r) || r < 8 || !Number.isSafeInteger(p) || p < 1) return null;
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return null;
  return { emails, n, r, p, salt, expected };
}

export function directLoginConfigured(): boolean {
  return parseConfig() !== null;
}

function derive(password: string, config: DirectLoginConfig): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, config.salt, KEY_LENGTH, {
      N: config.n,
      r: config.r,
      p: config.p,
      maxmem: Math.max(128 * config.n * config.r + 1024 * 1024, 64 * 1024 * 1024),
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function verifyDirectLogin(email: string, password: string): Promise<boolean> {
  const config = parseConfig();
  if (!config) return false;
  const actual = await derive(password, config);
  const passwordMatches = timingSafeEqual(actual, config.expected);
  const emailMatches = config.emails.has(email.trim().toLowerCase());
  return passwordMatches && emailMatches;
}
