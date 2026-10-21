import { z } from "zod"
import { AttachmentId } from "./chat"

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

/**
 * A person as the logged-in app sees them (QT-5zd-photo-store): the public summary plus the shared
 * profile photo attachment id (null without one). Never part of the public GET /api/users (T-5zd-04).
 */
export const Profile = UserSummary.extend({
  photoId: AttachmentId.nullable(),
})
export type Profile = z.infer<typeof Profile>

/** GET /api/me: the logged-in person and the other one (null until the second account exists). */
export const MeResponse = z.object({
  user: Profile,
  peer: Profile.nullable(),
})
export type MeResponse = z.infer<typeof MeResponse>

/**
 * PUT /api/users/:id/photo body (QT-5zd-photo-store): the requester's own unattached image upload
 * becomes that person's shared photo; null removes the photo.
 */
export const ProfilePhotoBody = z.strictObject({
  attachmentId: AttachmentId.nullable(),
})
export type ProfilePhotoBody = z.infer<typeof ProfilePhotoBody>

export const ProfilePhotoResponse = z.object({
  userId: z.uuid(),
  photoId: AttachmentId.nullable(),
})
export type ProfilePhotoResponse = z.infer<typeof ProfilePhotoResponse>

export const OkResponse = z.object({
  ok: z.literal(true),
})
export type OkResponse = z.infer<typeof OkResponse>

export const ErrorResponse = z.object({
  error: z.string(),
})
export type ErrorResponse = z.infer<typeof ErrorResponse>
