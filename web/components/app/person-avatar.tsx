"use client"

import type { ComponentProps } from "react"
import { avatarUrl } from "@duet/shared"
import { initials } from "@/components/app/login-tiles"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

/**
 * A person's avatar (QT-5zd-photo-ui): their shared profile photo from /media/<id>/avatar-sm|lg, or
 * their initials. Base UI shows the image only once it has loaded, so a missing or failed photo
 * keeps the initials. `size` picks the crop (sm 192 px, lg 640 px), not the rendered size.
 */
export function PersonAvatar({
  name,
  photoId,
  size = "sm",
  className,
  fallbackClassName,
  ...rest
}: {
  name: string
  photoId: string | null | undefined
  size?: "sm" | "lg"
  className?: string
  fallbackClassName?: string
} & Omit<ComponentProps<typeof Avatar>, "size" | "className" | "children">) {
  return (
    <Avatar className={className} {...rest}>
      {photoId ? <AvatarImage key={photoId} src={avatarUrl(photoId, size)} alt="" /> : null}
      <AvatarFallback className={fallbackClassName}>{initials(name)}</AvatarFallback>
    </Avatar>
  )
}
