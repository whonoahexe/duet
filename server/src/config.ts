import { fileURLToPath } from "node:url"
import path from "node:path"
import { z } from "zod"

/** Repo root, resolved from this file (server/src/config.ts -> ../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const boolFromEnv = z.enum(["true", "false"]).transform((v) => v === "true")

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    DATA_DIR: z.string().min(1).default(path.join(REPO_ROOT, "data")),
    WEB_OUT: z.string().min(1).default(path.join(REPO_ROOT, "web", "out")),
    // D-03: the public origin only ever comes from env; no domain is hard-coded.
    APP_ORIGIN: z.url().optional(),
    COOKIE_SECURE: boolFromEnv.optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.APP_ORIGIN) {
      ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "APP_ORIGIN is required when NODE_ENV=production" })
    }
  })
  .transform((env) => ({
    ...env,
    DATA_DIR: path.resolve(env.DATA_DIR),
    WEB_OUT: path.resolve(env.WEB_OUT),
    APP_ORIGIN: env.APP_ORIGIN ?? "http://localhost:3000",
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === "production",
  }))

export type Config = z.output<typeof EnvSchema>

export class ConfigError extends Error {
  override name = "ConfigError"
}

/** Validate env and fail fast with a readable error. Empty strings are treated as unset. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const keys = ["NODE_ENV", "HOST", "PORT", "DATA_DIR", "WEB_OUT", "APP_ORIGIN", "COOKIE_SECURE", "LOG_LEVEL"] as const
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
