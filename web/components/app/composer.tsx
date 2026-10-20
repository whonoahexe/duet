"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { CameraIcon, PaperPlaneRightIcon, PlusIcon, TrashIcon, VideoCameraIcon, XIcon } from "@phosphor-icons/react"
import { MAX_ALBUM_ITEMS, UPLOAD_LIMITS, VIDEO_PICK_MAX_SECONDS, isBlankBody } from "@duet/shared"
import { PreviewDrawer, kindOf, videoDurationMs, type PickedItem } from "@/components/app/preview-drawer"
import { QuoteBlock, localReplyPreview } from "@/components/app/quote-block"
import { MicButton, RecordingStatus, useVoiceRecorder } from "@/components/app/recorder"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { useBackClose } from "@/lib/back-close"
import { requestScrollToLatest } from "@/lib/chat/events"
import { sendTyping } from "@/lib/chat/realtime"
import { chatStore, useChat } from "@/lib/chat/store"
import { cn } from "@/lib/utils"

/** At most one typing frame per this interval while typing (CHAT-06, UI-SPEC). */
const TYPING_FRAME_INTERVAL_MS = 3000

/** Six 24px lines: the textarea grows to this, then scrolls inside. */
const MAX_TEXTAREA_PX = 144

/** Desktop-style input (mouse/trackpad): Enter sends. Phones: Enter is a newline, Send sends. */
function finePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches
}

/** Text composer pinned under the list. Send appears only once there is something to send. */
export function Composer({ peerName }: { peerName: string }) {
  const [text, setText] = useState("")
  const [picked, setPicked] = useState<PickedItem[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraPhotoRef = useRef<HTMLInputElement>(null)
  const cameraVideoRef = useRef<HTMLInputElement>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  useBackClose(cameraOpen, () => setCameraOpen(false))
  const lastTypingRef = useRef(0)
  const canSend = !isBlankBody(text)
  const chat = useChat()
  const meId = chat.me?.id ?? null
  const replyTarget = chat.replyTarget
  const replyMessage = replyTarget !== null ? chat.messages.find((m) => m.seq === replyTarget) : undefined
  const replySeq = replyMessage ? replyMessage.seq : null

  // Voice notes (D-10): the mic takes the Send button's place while the text field is empty.
  const recorder = useVoiceRecorder({
    onSend: (blob, durationMs) => {
      chatStore.sendVoice(blob, durationMs, replySeq)
      requestScrollToLatest()
      chatStore.setReplyTarget(null)
    },
  })
  const recording = recorder.phase === "holding" || recorder.phase === "locked"

  // Starting a reply (swipe or menu) focuses the field so the keyboard comes up (D-01).
  useEffect(() => {
    if (replyTarget !== null) ref.current?.focus()
  }, [replyTarget])

  // Grow from one line to six, then scroll (field-sizing is not available on every phone).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? "auto" : "hidden"
  }, [text])

  function send() {
    if (!canSend) return
    chatStore.sendText(text, replyMessage ? replyMessage.seq : null)
    requestScrollToLatest()
    chatStore.setReplyTarget(null)
    setText("")
    // The next message starts a fresh typing burst.
    lastTypingRef.current = 0
    // Keep the keyboard up for the next message.
    ref.current?.focus()
  }

  /**
   * The native picker returned files (camera, library or Files: D-05), or the camera button's photo
   * or video capture input returned a fresh capture. Limits are checked before the
   * drawer opens (UI-SPEC): photos over 100 MB, videos over 200 MB or 3 minutes (D-08) are left out
   * with a toast, at most 10 items are kept, and if nothing is left the drawer does not open.
   */
  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    let files = Array.from(e.target.files ?? [])
    // Picking the same file again must fire change again.
    e.target.value = ""
    const tooBigPhotos = files.filter((f) => kindOf(f) === "image" && f.size > UPLOAD_LIMITS.image)
    if (tooBigPhotos.length > 0) {
      files = files.filter((f) => !tooBigPhotos.includes(f))
      toast.error(
        tooBigPhotos.length === 1
          ? "That photo is over 100 MB, so it was left out."
          : `${tooBigPhotos.length} photos are over 100 MB, so they were left out.`,
      )
    }
    const tooBigVideos = files.filter((f) => kindOf(f) === "video" && f.size > UPLOAD_LIMITS.video)
    if (tooBigVideos.length > 0) {
      files = files.filter((f) => !tooBigVideos.includes(f))
      toast.error("That video is over 200 MB. Trim it and try again.")
    }
    if (files.length > MAX_ALBUM_ITEMS) {
      files = files.slice(0, MAX_ALBUM_ITEMS)
      toast("You can send up to 10 at a time. The first 10 are selected.")
    }
    let items: PickedItem[] = await Promise.all(
      files.map(async (file) => ({ file, durationMs: kindOf(file) === "video" ? await videoDurationMs(file) : null })),
    )
    const tooLong = items.filter((it) => it.durationMs !== null && it.durationMs > VIDEO_PICK_MAX_SECONDS * 1000)
    if (tooLong.length > 0) {
      items = items.filter((it) => !tooLong.includes(it))
      toast.error("Videos can be up to 3 minutes. Trim it and try again.")
    }
    if (items.length > 0) setPicked(items)
  }

  function sendPicked(files: File[], caption: string) {
    chatStore.sendMedia(files, caption, replyMessage ? replyMessage.seq : null)
    requestScrollToLatest()
    chatStore.setReplyTarget(null)
    setPicked([])
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return
    if (!finePointer()) return
    e.preventDefault()
    send()
  }

  return (
    <div className="border-t bg-background px-4 py-2 pb-[max(8px,env(safe-area-inset-bottom))]">
      {replyMessage && (
        <div className="mb-2 flex items-start gap-2" data-testid="reply-chip">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Replying to {replyMessage.senderId === meId ? "You" : peerName}
            </span>
            <QuoteBlock preview={localReplyPreview(replyMessage)} meId={meId} peerName={peerName} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel reply"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => chatStore.setReplyTarget(null)}
          >
            <XIcon />
          </Button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        data-testid="attach-input"
        onChange={(e) => void onPick(e)}
      />
      {/*
        Separate photo and video capture inputs: Android Chrome does not reliably offer both camera
        modes for one combined accept with capture, while one input per mode opens the right one.
      */}
      <input
        ref={cameraPhotoRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        data-testid="camera-photo-input"
        onChange={(e) => void onPick(e)}
      />
      <input
        ref={cameraVideoRef}
        type="file"
        accept="video/*"
        capture="environment"
        hidden
        data-testid="camera-video-input"
        onChange={(e) => void onPick(e)}
      />
      <InputGroup className={cn(recording && "h-auto")}>
        {!recording && (
          <InputGroupAddon align="inline-start">
            <InputGroupButton
              variant="ghost"
              size="icon-sm"
              className="size-11 rounded-full"
              aria-label="Attach photo or video"
              onClick={() => fileRef.current?.click()}
            >
              <PlusIcon weight="bold" />
            </InputGroupButton>
            <DropdownMenu open={cameraOpen} onOpenChange={(next) => setCameraOpen(next)}>
              <DropdownMenuTrigger
                render={
                  <InputGroupButton
                    variant="ghost"
                    size="icon-sm"
                    className="size-11 rounded-full"
                    aria-label="Take photo or video"
                  />
                }
              >
                <CameraIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-auto">
                {/* The click stays inside the item's tap, so the browser lets it open the camera. */}
                <DropdownMenuItem onClick={() => cameraPhotoRef.current?.click()}>
                  <CameraIcon />
                  Photo
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => cameraVideoRef.current?.click()}>
                  <VideoCameraIcon />
                  Video
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </InputGroupAddon>
        )}
        {recorder.phase === "locked" && (
          <InputGroupAddon align="inline-start">
            <InputGroupButton
              variant="destructive"
              size="icon-sm"
              className="size-11 rounded-full"
              aria-label="Discard recording"
              onClick={recorder.discard}
            >
              <TrashIcon />
            </InputGroupButton>
          </InputGroupAddon>
        )}
        {recording ? (
          <RecordingStatus recorder={recorder} />
        ) : (
          <InputGroupTextarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => {
              const value = e.target.value
              setText(value)
              const now = Date.now()
              if (!isBlankBody(value) && now - lastTypingRef.current >= TYPING_FRAME_INTERVAL_MS) {
                lastTypingRef.current = now
                sendTyping()
              }
            }}
            onKeyDown={onKeyDown}
            placeholder={`Message ${peerName}`}
            aria-label={`Message ${peerName}`}
            className="max-h-36 min-h-11 text-base md:text-base"
          />
        )}
        {recorder.phase === "locked" ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              variant="default"
              size="icon-sm"
              className="size-11 rounded-full"
              aria-label="Send voice note"
              onClick={recorder.send}
            >
              <PaperPlaneRightIcon weight="fill" />
            </InputGroupButton>
          </InputGroupAddon>
        ) : !canSend || recorder.phase !== "idle" ? (
          <InputGroupAddon align="inline-end">
            <MicButton recorder={recorder} />
          </InputGroupAddon>
        ) : (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              variant="default"
              size="icon-sm"
              className="size-11 rounded-full"
              aria-label="Send message"
              // Keep focus in the textarea so the iOS keyboard does not drop between messages.
              onMouseDown={(e) => e.preventDefault()}
              onClick={send}
            >
              <PaperPlaneRightIcon weight="fill" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <PreviewDrawer
        items={picked}
        onSend={sendPicked}
        onRemove={(i) => setPicked((prev) => prev.filter((_, j) => j !== i))}
        onDiscard={() => setPicked([])}
      />
    </div>
  )
}
