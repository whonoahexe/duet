"use client"

import type { UserSummary } from "@duet/shared"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"

/** First letters of the first two words of the display name, uppercased. */
export function initials(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase()
}

export function LoginTiles({
  users,
  onSelect,
}: {
  users: UserSummary[]
  onSelect: (user: UserSummary) => void
}) {
  return (
    <ItemGroup>
      {users.map((user) => (
        <Item
          key={user.id}
          variant="outline"
          render={<button type="button" className="cursor-pointer text-left" onClick={() => onSelect(user)} />}
        >
          <ItemMedia>
            <Avatar size="lg">
              <AvatarFallback>{initials(user.displayName)}</AvatarFallback>
            </Avatar>
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{user.displayName}</ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}
