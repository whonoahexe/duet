import { z } from "zod"

/** Public view of an account: what the login screen may show. Never carries a password hash. */
export const UserSummary = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
})
export type UserSummary = z.infer<typeof UserSummary>

export const UsersResponse = z.object({
  users: z.array(UserSummary),
})
export type UsersResponse = z.infer<typeof UsersResponse>

/** POST /api/login body. The tile identifies the person (D-04), so there is no username field. */
export const LoginBody = z.object({
  userId: z.uuid(),
  password: z.string().min(1).max(1024),
})
export type LoginBody = z.infer<typeof LoginBody>

/** GET /api/me: the logged-in person and the other one (null until the second account exists). */
export const MeResponse = z.object({
  user: UserSummary,
  peer: UserSummary.nullable(),
})
export type MeResponse = z.infer<typeof MeResponse>

export const OkResponse = z.object({
  ok: z.literal(true),
})
export type OkResponse = z.infer<typeof OkResponse>

export const ErrorResponse = z.object({
  error: z.string(),
})
export type ErrorResponse = z.infer<typeof ErrorResponse>
