import { fileURLToPath } from "node:url"
import path from "node:path"
import { z } from "zod"

/** Repo root, resolved from this file (server/src/config.ts -> ../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const boolFromEnv = z.enum(["true", "false"]).transform((v) => v === "true")

/** http(s) scheme, a host, and nothing else (a lone trailing slash is allowed and normalized away). */
function isBareOrigin(value: string): boolean {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false
  }
  return (
    (u.protocol === "https:" || u.protocol === "http:") &&
    u.username === "" &&
    u.password === "" &&
    u.pathname === "/" &&
    u.search === "" &&
    u.hash === "" &&
    !value.endsWith("?") &&
    !value.endsWith("#")
  )
}

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    DATA_DIR: z.string().min(1).default(path.join(REPO_ROOT, "data")),
    WEB_OUT: z.string().min(1).default(path.join(REPO_ROOT, "web", "out")),
    // D-03: the public origin only ever comes from env; no domain is hard-coded. It is compared
    // verbatim with the browser's Origin header, so it must be a bare origin (checked below) and is
    // normalized to the browser's serialization: lowercase host, no trailing slash (WR-03).
    APP_ORIGIN: z.url().optional(),
    COOKIE_SECURE: boolFromEnv.optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    // D-16 / INFR-03: Cloudflare TURN key (written by deploy/cloudflare/turn-key.sh). Optional so the
    // app still boots without TURN; POST /api/rtc/ice-servers then answers 503 turn_unconfigured.
    CF_TURN_KEY_ID: z.string().min(1).optional(),
    CF_TURN_KEY_API_TOKEN: z.string().min(1).optional(),
    // Lifetime of each minted TURN credential. Cloudflare allows at most 48 h.
    TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(172800).default(86400),
    CF_TURN_API_BASE: z.url().default("https://rtc.live.cloudflare.com"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.APP_ORIGIN) {
      ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "APP_ORIGIN is required when NODE_ENV=production" })
    }
    if (env.APP_ORIGIN && !isBareOrigin(env.APP_ORIGIN)) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_ORIGIN"],
        message: "APP_ORIGIN must be a bare http(s) origin like https://duet.example.com (no path, query or credentials)",
      })
    }
    if (Boolean(env.CF_TURN_KEY_ID) !== Boolean(env.CF_TURN_KEY_API_TOKEN)) {
      ctx.addIssue({
        code: "custom",
        path: ["CF_TURN_KEY_ID"],
        message: "CF_TURN_KEY_ID and CF_TURN_KEY_API_TOKEN must be set together",
      })
    }
  })
  .transform((env) => ({
    ...env,
    DATA_DIR: path.resolve(env.DATA_DIR),
    WEB_OUT: path.resolve(env.WEB_OUT),
    APP_ORIGIN: new URL(env.APP_ORIGIN ?? "http://localhost:3000").origin,
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === "production",
  }))

export type Config = z.output<typeof EnvSchema>

export class ConfigError extends Error {
  override name = "ConfigError"
}

/** Validate env and fail fast with a readable error. Empty strings are treated as unset. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const keys = [
    "NODE_ENV",
    "HOST",
    "PORT",
    "DATA_DIR",
    "WEB_OUT",
    "APP_ORIGIN",
    "COOKIE_SECURE",
    "LOG_LEVEL",
    "CF_TURN_KEY_ID",
    "CF_TURN_KEY_API_TOKEN",
    "TURN_CREDENTIAL_TTL_SECONDS",
    "CF_TURN_API_BASE",
  ] as const
  const picked: Record<string, string | undefined> = {}
  for (const k of keys) {
    const v = env[k]
    picked[k] = v === undefined || v.trim() === "" ? undefined : v.trim()
  }
  const parsed = EnvSchema.safeParse(picked)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`)
    throw new ConfigError(`Invalid duet server configuration:\n${lines.join("\n")}`)
  }
  return parsed.data
}
