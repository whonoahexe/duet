import type { z } from "zod"

/** Non-2xx response from the duet API. `code` is the JSON body's `error` field when present. */
export class ApiError extends Error {
  override name = "ApiError"
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API ${status}: ${code}`)
  }
}

async function request<S extends z.ZodType>(path: string, init: RequestInit, schema: S): Promise<z.output<S>> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  })

  let body: unknown = undefined
  const text = await res.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
  }

  if (!res.ok) {
    const code =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : "http_error"
    throw new ApiError(res.status, code)
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new ApiError(res.status, "invalid_response")
  return parsed.data
}

export function apiGet<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  return request(path, { method: "GET" }, schema)
}

export function apiPost<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.output<S>> {
  return request(path, { method: "POST", body: JSON.stringify(body ?? {}) }, schema)
}

export function apiPut<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.output<S>> {
  return request(path, { method: "PUT", body: JSON.stringify(body ?? {}) }, schema)
}

export function apiPatch<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.output<S>> {
  return request(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }, schema)
}

/** DELETE sends no body, so no Content-Type header. */
export function apiDelete<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  return request(path, { method: "DELETE" }, schema)
}
