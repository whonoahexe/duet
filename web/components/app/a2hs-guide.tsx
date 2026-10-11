"use client"

import { DeviceMobileIcon, ExportIcon, PlusSquareIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"

/** sessionStorage flag: the guide was skipped in this Safari session (it returns in a new one). */
export const A2HS_SKIPPED_KEY = "duet.a2hs.skipped"

const STEPS = [
  {
    icon: ExportIcon,
    title: "Tap the Share button",
    description: "At the bottom of Safari (or top right on iPad).",
  },
  {
    icon: PlusSquareIcon,
    title: "Choose “Add to Home Screen”",
    description: "Scroll down the share sheet if you don't see it.",
  },
  {
    icon: DeviceMobileIcon,
    title: "Open duet from your Home Screen",
    description: "Then log in there.",
  },
] as const

/**
 * Full-screen "Add duet to your Home Screen" guide (SHEL-03, D-16), shown in iOS Safari before the
 * login tiles: an installed iOS app has storage separate from Safari, and only it can get push.
 * The ghost skip button at the bottom always lets the user through.
 */
export function A2hsGuide({ onContinue }: { onContinue: () => void }) {
  function handleContinue() {
    try {
      sessionStorage.setItem(A2HS_SKIPPED_KEY, "1")
    } catch {
      /* private mode: skipping still works for this page view */
    }
    onContinue()
  }

  return (
    <main className="flex min-h-dvh justify-center px-6 pt-[calc(4rem+env(safe-area-inset-top))] pb-[calc(4rem+env(safe-area-inset-bottom))]">
      <div className="flex w-full max-w-sm flex-col gap-12">
        <div className="flex flex-col gap-6">
          <h1 className="text-center font-heading text-2xl font-medium tracking-tight">duet</h1>
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-medium tracking-tight">Add duet to your Home Screen</h2>
            <p className="text-base leading-normal text-muted-foreground">
              On iPhone, notifications only work when duet is opened from your Home Screen.
            </p>
          </div>
        </div>

        <ItemGroup className="gap-6">
          {STEPS.map(({ icon: Icon, title, description }) => (
            <Item key={title}>
              <ItemMedia variant="icon">
                <Icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{title}</ItemTitle>
                <ItemDescription>{description}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>

        <Button variant="ghost" className="mt-auto" onClick={handleContinue}>
          Continue in Safari for now
        </Button>
      </div>
    </main>
  )
}
