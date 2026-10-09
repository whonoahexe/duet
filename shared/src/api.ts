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
