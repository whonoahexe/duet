import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

/**
 * Media at rest (QT-4qu-format, T-4qu-01 / T-4qu-03): every file under data/media is stored in the
 * DUETENC v1 chunked AES-256-GCM format. This module imports nothing from the other media modules,
 * so it can never be part of an import cycle.
 *
 * Layout:
 * - header (ENC_HEADER_LEN = 36 bytes): "DUETENC" | version 0x01 | chunk size u32 BE | plaintext
 *   size u64 BE | 16 random bytes of file id.
 * - chunk i (count = ceil(plainSize / ENC_CHUNK), none for an empty file) at
 *   ENC_HEADER_LEN + i * (ENC_CHUNK + 28): 12-byte random nonce | ciphertext | 16-byte GCM tag.
 * - AAD of chunk i = the full header followed by i as u32 BE, so a chunk cannot be reordered,
 *   swapped between files or truncated without the tag check failing.
 */
export const ENC_MAGIC = Buffer.from("DUETENC", "ascii")
export const ENC_VERSION = 1
export const ENC_HEADER_LEN = 36
export const ENC_CHUNK = 65536
const NONCE_LEN = 12
const TAG_LEN = 16
const CHUNK_OVERHEAD = NONCE_LEN + TAG_LEN
const KEY_LEN = 32

/** The parsed header of a DUETENC file. */
export interface EncHeader {
  plainSize: number
  /** The 32-hex file id (a strong ETag: it changes whenever the file is rewritten). */
  etag: string
  /** The 36 header bytes (part of every chunk's AAD). */
  raw: Buffer
}

/** Size on disk of a plaintext of plainSize bytes. */
export function encryptedSize(plainSize: number): number {
  return ENC_HEADER_LEN + plainSize + Math.ceil(plainSize / ENC_CHUNK) * CHUNK_OVERHEAD
}

function makeHeader(plainSize: number): Buffer {
  const h = Buffer.alloc(ENC_HEADER_LEN)
  ENC_MAGIC.copy(h, 0)
  h.writeUInt8(ENC_VERSION, 7)
  h.writeUInt32BE(ENC_CHUNK, 8)
  h.writeBigUInt64BE(BigInt(plainSize), 12)
  randomBytes(16).copy(h, 20)
  return h
}

function aad(header: Buffer, index: number): Buffer {
  const i = Buffer.alloc(4)
  i.writeUInt32BE(index, 0)
  return Buffer.concat([header, i])
}

function sealChunk(key: Buffer, header: Buffer, index: number, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad(header, index))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

function openChunk(key: Buffer, header: Buffer, index: number, sealed: Buffer): Buffer {
  const nonce = sealed.subarray(0, NONCE_LEN)
  const tag = sealed.subarray(sealed.length - TAG_LEN)
  const body = sealed.subarray(NONCE_LEN, sealed.length - TAG_LEN)
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAAD(aad(header, index))
  decipher.setAuthTag(tag)
  // final() throws on a bad tag (tampered chunk, wrong key, wrong index).
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/** Encrypt a whole buffer (upload chunk parts, tests). */
export function encryptBuffer(key: Buffer, plain: Buffer): Buffer {
  const header = makeHeader(plain.length)
  const out: Buffer[] = [header]
  for (let i = 0, off = 0; off < plain.length; i++, off += ENC_CHUNK) {
    out.push(sealChunk(key, header, i, plain.subarray(off, off + ENC_CHUNK)))
  }
  return Buffer.concat(out)
}

/**
 * Encrypt srcPath into dstPath, ENC_CHUNK at a time (never the whole file in memory). Written to a
 * unique temp name in dst's dir and renamed over dst, so a half-written file is never visible; the
 * temp is removed on any error.
 */
export async function encryptFile(key: Buffer, srcPath: string, dstPath: string): Promise<void> {
  const tmp = path.join(path.dirname(dstPath), `${path.basename(dstPath)}.${randomBytes(4).toString("hex")}.tmp`)
  const src = await open(srcPath, "r")
  try {
    const { size } = await src.stat()
    const header = makeHeader(size)
    const dst = await open(tmp, "wx", 0o600)
    try {
      await dst.write(header)
      const buf = Buffer.alloc(ENC_CHUNK)
      for (let i = 0, off = 0; off < size; i++) {
        const want = Math.min(ENC_CHUNK, size - off)
        let got = 0
        while (got < want) {
          const { bytesRead } = await src.read(buf, got, want - got, off + got)
          if (bytesRead === 0) throw new Error(`${srcPath} shrank while it was being encrypted`)
          got += bytesRead
        }
        await dst.write(sealChunk(key, header, i, buf.subarray(0, want)))
        off += want
      }
      await dst.sync()
    } finally {
      await dst.close()
    }
    await rename(tmp, dstPath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  } finally {
    await src.close()
  }
}

/**
 * The header of a DUETENC file, or null when the file is not one (wrong magic, version or chunk
 * size, a size beyond MAX_SAFE_INTEGER, or a file length that does not match the header: truncated
 * or padded). ENOENT propagates.
 */
export async function readEncHeader(filePath: string): Promise<EncHeader | null> {
  const fh = await open(filePath, "r")
  try {
    const { size } = await fh.stat()
    if (size < ENC_HEADER_LEN) return null
    const raw = Buffer.alloc(ENC_HEADER_LEN)
    const { bytesRead } = await fh.read(raw, 0, ENC_HEADER_LEN, 0)
    if (bytesRead !== ENC_HEADER_LEN) return null
    if (!raw.subarray(0, 7).equals(ENC_MAGIC)) return null
    if (raw.readUInt8(7) !== ENC_VERSION) return null
    if (raw.readUInt32BE(8) !== ENC_CHUNK) return null
    const big = raw.readBigUInt64BE(12)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
    const plainSize = Number(big)
    if (size !== encryptedSize(plainSize)) return null
    return { plainSize, etag: raw.subarray(20, 36).toString("hex"), raw }
  } finally {
    await fh.close()
  }
}

/**
 * Plaintext bytes start..endInclusive of an encrypted file (T-4qu-05). Only the chunks the range
 * covers are read and decrypted; every chunk's tag is checked before its bytes are yielded.
 */
export async function* decryptChunks(
  key: Buffer,
  filePath: string,
  header: EncHeader,
  start: number,
  endInclusive: number,
): AsyncGenerator<Buffer> {
  const end = Math.min(endInclusive, header.plainSize - 1)
  if (header.plainSize === 0 || start > end || start < 0) return
  const first = Math.floor(start / ENC_CHUNK)
  const last = Math.floor(end / ENC_CHUNK)
  const fh = await open(filePath, "r")
  try {
    for (let i = first; i <= last; i++) {
      const plainLen = Math.min(ENC_CHUNK, header.plainSize - i * ENC_CHUNK)
      const sealed = Buffer.alloc(plainLen + CHUNK_OVERHEAD)
      const pos = ENC_HEADER_LEN + i * (ENC_CHUNK + CHUNK_OVERHEAD)
      let got = 0
      while (got < sealed.length) {
        const { bytesRead } = await fh.read(sealed, got, sealed.length - got, pos + got)
        if (bytesRead === 0) throw new Error(`${filePath} is truncated`)
        got += bytesRead
      }
      const plain = openChunk(key, header.raw, i, sealed)
      const from = i === first ? start - i * ENC_CHUNK : 0
      const to = i === last ? end - i * ENC_CHUNK + 1 : plain.length
      yield plain.subarray(from, to)
    }
  } finally {
    await fh.close()
  }
}

async function headerOrThrow(file: string): Promise<EncHeader> {
  const header = await readEncHeader(file)
  if (!header) throw new Error(`${file} is not a DUETENC file`)
  return header
}

/** Decrypt a whole file into dst (an empty plaintext gives an empty file). */
export async function decryptToFile(key: Buffer, src: string, dst: string): Promise<void> {
  const header = await headerOrThrow(src)
  await pipeline(
    Readable.from(decryptChunks(key, src, header, 0, header.plainSize - 1), { objectMode: false }),
    createWriteStream(dst, { mode: 0o600 }),
  )
}

/** The whole plaintext of an encrypted file as a Buffer (tests, upload parts of at most 8 MiB). */
export async function readDecrypted(key: Buffer, file: string): Promise<Buffer> {
  const header = await headerOrThrow(file)
  const parts: Buffer[] = []
  for await (const chunk of decryptChunks(key, file, header, 0, header.plainSize - 1)) parts.push(chunk)
  return Buffer.concat(parts)
}

/** sha256 (hex) of the plaintext; throws when any chunk fails its tag check. */
export async function sha256Decrypted(key: Buffer, file: string): Promise<string> {
  const header = await headerOrThrow(file)
  const hash = createHash("sha256")
  for await (const chunk of decryptChunks(key, file, header, 0, header.plainSize - 1)) hash.update(chunk)
  return hash.digest("hex")
}

/** A media key problem that must stop the boot (QT-4qu-key, T-4qu-04). Never carries the key. */
export class MediaKeyError extends Error {
  override name = "MediaKeyError"
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined
}

function decodeKey(keyFile: string, text: string): Buffer {
  const trimmed = text.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new MediaKeyError(`${keyFile} is malformed: expected base64 of 32 bytes`)
  }
  const key = Buffer.from(trimmed, "base64")
  if (key.length !== KEY_LEN || key.toString("base64") !== trimmed) {
    throw new MediaKeyError(`${keyFile} is malformed: expected base64 of 32 bytes`)
  }
  return key
}

/** Read the key file (strict base64 of exactly 32 bytes). Never writes; missing or bad throws. */
export async function readMediaKey(keyFile: string): Promise<Buffer> {
  let text: string
  try {
    text = await readFile(keyFile, "utf8")
  } catch (err) {
    const code = errCode(err)
    throw new MediaKeyError(
      code === "ENOENT" ? `${keyFile} is missing` : `${keyFile} cannot be read (${code ?? "error"})`,
    )
  }
  return decodeKey(keyFile, text)
}

/** True when any regular file under mediaRoot carries a valid DUETENC header. */
async function holdsEncryptedMedia(mediaRoot: string): Promise<boolean> {
  let entries
  try {
    entries = await readdir(mediaRoot, { recursive: true, withFileTypes: true })
  } catch (err) {
    if (errCode(err) === "ENOENT") return false
    throw err
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    try {
      if (await readEncHeader(path.join(e.parentPath, e.name))) return true
    } catch {
      /* vanished meanwhile */
    }
  }
  return false
}

export interface LoadedMediaKey {
  key: Buffer
  /** True when this call created the key file. */
  created: boolean
  /** Group or other can access the key file (mode & 0o077 non-zero). */
  loosePermissions: boolean
}

/**
 * Load the media key, creating it only when it is missing and no encrypted media exists yet
 * (T-4qu-04). The file is written with flag wx (never overwritten) as base64 of 32 random bytes
 * plus a newline, mode 0o600, in a 0o700 dir. Every failure is a MediaKeyError naming the path.
 */
export async function loadMediaKey(opts: { keyFile: string; mediaRoot: string }): Promise<LoadedMediaKey> {
  const { keyFile, mediaRoot } = opts
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string | null = null
    try {
      text = await readFile(keyFile, "utf8")
    } catch (err) {
      const code = errCode(err)
      if (code !== "ENOENT") throw new MediaKeyError(`${keyFile} cannot be read (${code ?? "error"})`)
    }
    if (text !== null) {
      const key = decodeKey(keyFile, text)
      const { mode } = await stat(keyFile)
      return { key, created: false, loosePermissions: (mode & 0o077) !== 0 }
    }

    if (await holdsEncryptedMedia(mediaRoot)) {
      throw new MediaKeyError(
        `${keyFile} is missing but ${mediaRoot} already holds encrypted media; restore the key from your backup, a new key cannot read it`,
      )
    }
    const key = randomBytes(KEY_LEN)
    let opened = false
    try {
      await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 })
      const fh = await open(keyFile, "wx", 0o600)
      opened = true
      try {
        await fh.chmod(0o600)
        await fh.writeFile(`${key.toString("base64")}\n`)
        await fh.sync()
      } finally {
        await fh.close()
      }
    } catch (err) {
      // A key file this call created but could not finish writing is useless: remove it.
      if (opened) await rm(keyFile, { force: true })
      const code = errCode(err)
      // Someone else created it meanwhile: never overwrite, read theirs.
      if (code === "EEXIST") continue
      throw new MediaKeyError(`${keyFile} cannot be created (${code ?? "error"})`)
    }
    return { key, created: true, loosePermissions: false }
  }
  throw new MediaKeyError(`${keyFile} cannot be read`)
}
