import { spawn } from "node:child_process"

/** A media job failure with a stable snake_case code (stored in attachments.error, never a path). */
export class MediaError extends Error {
  override name = "MediaError"
  constructor(
    readonly code: string,
    /** Bounded diagnostic text (stderr tail). Logged at debug level only, never sent to clients. */
    readonly detail = "",
  ) {
    super(code)
  }
}

/** Most stderr kept from a child process. */
const STDERR_MAX = 8 * 1024

export interface RunToolOptions {
  /** Kill the child (SIGKILL) after this long and reject with MediaError("timeout"). */
  timeoutMs: number
  /** Error code used for a non-zero exit. Default "tool_failed". */
  failCode?: string
}

/**
 * Run a media tool (ffmpeg, heif-convert, ...) safely (T-02-29, Pitfall 7): `nice -n 10 cmd ...args`
 * with an argument array (never a shell), stdin ignored, stdout discarded, at most 8 KB of stderr
 * kept, and a kill timeout. Every path in args is built by the server, never taken from a client.
 */
export function runTool(cmd: string, args: readonly string[], opts: RunToolOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("nice", ["-n", "10", cmd, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
      windowsHide: true,
    })
    let stderr = ""
    let settled = false
    const finish = (err: MediaError | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(new MediaError("timeout", `${cmd} exceeded ${opts.timeoutMs} ms`))
    }, opts.timeoutMs)

    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < STDERR_MAX) stderr = (stderr + chunk).slice(0, STDERR_MAX)
    })
    child.on("error", (err) => finish(new MediaError("tool_missing", `${cmd}: ${err.message}`)))
    child.on("close", (code, signal) => {
      if (code === 0) finish(null)
      else finish(new MediaError(opts.failCode ?? "tool_failed", `${cmd} exit ${code ?? signal}: ${stderr.trim()}`))
    })
  })
}

/** True when `cmd` can be found on PATH (used by tests and the self-test to skip optional tools). */
export function hasTool(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", cmd], { stdio: "ignore" })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
}
