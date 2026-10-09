import { hash, verify } from "@node-rs/argon2"

// Library defaults are argon2id, m=19456, t=2, p=1 (OWASP minimum).
// Do NOT import the `Algorithm` const enum: const enums do not survive tsx/esbuild.

export function normalizePassword(pw: string): string {
  return pw.normalize("NFC")
}

/** Length in Unicode code points of the NFC form (not UTF-16 units). */
export function passwordLength(pw: string): number {
  return [...normalizePassword(pw)].length
}

export function hashPassword(pw: string): Promise<string> {
  return hash(normalizePassword(pw))
}

export async function verifyPassword(passwordHash: string, pw: string): Promise<boolean> {
  try {
    return await verify(passwordHash, normalizePassword(pw))
  } catch {
    return false
  }
}
