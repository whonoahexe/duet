"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { toast } from "sonner"
import { ArrowLeftIcon, PhoneCallIcon, PlayIcon, StopIcon } from "@phosphor-icons/react"
import { RoomId, WS_CLOSE_LOGGED_OUT, type MeResponse, type ServerFrame } from "@duet/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Toaster } from "@/components/ui/sonner"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ApiError } from "@/lib/api"
import { fetchIceServers } from "@/lib/rtc/ice"
import { createPeer, type Peer } from "@/lib/rtc/peer"
import { sampleCall, type CallSample } from "@/lib/rtc/stats"
import { SignalingClient, signalingUrl } from "@/lib/ws"

type Verdict = "pass" | "waiting" | "not_relayed" | "failed"
type Phase = "idle" | "starting" | "waiting-peer" | "in-call"

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "PASS",
  waiting: "Waiting",
  not_relayed: "Not relayed",
  failed: "Failed",
}

/** Everything one Start..Stop run owns. Lives in a ref so socket and timer callbacks see it. */
interface Run {
  room: string
  forceRelay: boolean
  stopped: boolean
  stream: MediaStream | null
  iceServers: RTCIceServer[]
  sig: SignalingClient | null
  myConnId: string | null
  peer: Peer | null
  peerConnId: string | null
  /** rtc.signal frames that arrived before the peer connection existed (replayed, not dropped). */
  pending: Extract<ServerFrame, { t: "rtc.signal" }>[]
  timer: ReturnType<typeof setInterval> | null
  sampling: boolean
  prevBytes: number
}

function inlineVerdict(sample: CallSample, prevBytes: number, forceRelay: boolean): Verdict {
  if (sample.state === "failed") return "failed"
  if (forceRelay && sample.localType !== undefined && sample.localType !== "relay") return "not_relayed"
  if (
    sample.state === "connected" &&
    sample.inboundBytes > 0 &&
    sample.inboundBytes > prevBytes &&
    (!forceRelay || sample.localType === "relay")
  ) {
    return "pass"
  }
  return "waiting"
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Logged out. Log in again first."
    if (err.status === 503) return "TURN is not configured on the server."
    if (err.status === 502) return "Cloudflare TURN is not answering. Try again."
    if (err.status === 429) return "Too many attempts. Wait a minute."
    return "Couldn't get TURN credentials."
  }
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "Camera and microphone access was denied."
    if (err.name === "NotFoundError") return "No camera or microphone found."
    return `Camera or microphone failed: ${err.name}`
  }
  if (err instanceof Error && err.message === "no_media") return "This browser can't capture camera and microphone here."
  return "Couldn't start the call test."
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function CallTest({ me }: { me: MeResponse }) {
  const [room, setRoom] = useState("debug")
  const [forceRelay, setForceRelay] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [sample, setSample] = useState<CallSample | null>(null)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [needsTap, setNeedsTap] = useState(false)
  const localVideo = useRef<HTMLVideoElement>(null)
  const remoteVideo = useRef<HTMLVideoElement>(null)
  const runRef = useRef<Run | null>(null)

  const running = phase !== "idle"
  const roomValid = RoomId.safeParse(room).success

  // Query string at load (?room=, ?relay=1) so smoke and UAT links are one tap. No Next search-params
  // hook: it needs a Suspense bailout in a static export.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const r = params.get("room")
    if (r && RoomId.safeParse(r).success) setRoom(r)
    if (params.get("relay") === "1") setForceRelay(true)
  }, [])

  function attach(ref: RefObject<HTMLVideoElement | null>, stream: MediaStream | null, isRemote: boolean) {
    const video = ref.current
    if (!video) return
    video.srcObject = stream
    if (!stream) return
    video.play().catch((err: unknown) => {
      if (isRemote && err instanceof DOMException && err.name === "NotAllowedError") setNeedsTap(true)
    })
  }

  function stopRun(run: Run) {
    if (run.stopped) return
    run.stopped = true
    if (run.timer) clearInterval(run.timer)
    run.timer = null
    run.peer?.close()
    run.peer = null
    if (run.sig) {
      run.sig.send({ t: "room.leave", room: run.room })
      run.sig.close()
    }
    for (const track of run.stream?.getTracks() ?? []) track.stop()
    run.stream = null
    attach(localVideo, null, false)
    attach(remoteVideo, null, true)
    if (runRef.current === run) runRef.current = null
    setPhase("idle")
    setNeedsTap(false)
  }

  function stop() {
    if (runRef.current) stopRun(runRef.current)
  }

  // Leaving the page (route change, app close) stops every captured track.
  useEffect(() => {
    const onHide = () => stop()
    window.addEventListener("pagehide", onHide)
    return () => {
      window.removeEventListener("pagehide", onHide)
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function dropPeer(run: Run) {
    run.peer?.close()
    run.peer = null
    run.peerConnId = null
    run.prevBytes = 0
    attach(remoteVideo, null, true)
    setSample(null)
    setVerdict("waiting")
    setPhase("waiting-peer")
  }

  function startPeer(run: Run, peerConnId: string) {
    if (run.peer) dropPeer(run)
    const stream = run.stream
    if (!stream || !run.myConnId) return
    run.peerConnId = peerConnId
    run.peer = createPeer({
      iceServers: run.iceServers,
      forceRelay: run.forceRelay,
      polite: run.myConnId > peerConnId,
      stream,
      send: (data) => {
        run.sig?.send({ t: "rtc.signal", room: run.room, data })
      },
      onRemoteStream: (remote) => {
        if (remoteVideo.current?.srcObject !== remote) attach(remoteVideo, remote, true)
      },
    })
    setPhase("in-call")
    const queued = run.pending.filter((f) => f.from === peerConnId)
    run.pending = []
    for (const frame of queued) applySignal(run, frame)
  }

  function applySignal(run: Run, frame: Extract<ServerFrame, { t: "rtc.signal" }>) {
    const peer = run.peer
    if (!peer) return
    peer.handleSignal(frame.data).catch((err: unknown) => console.error("signal failed", err))
  }

  function handleFrame(run: Run, frame: ServerFrame) {
    if (run.stopped) return
    if ("room" in frame && frame.room !== run.room) return
    switch (frame.t) {
      case "room.joined": {
        const other = frame.peers[0]
        if (other) startPeer(run, other.connId)
        else setPhase("waiting-peer")
        break
      }
      case "room.peer-joined":
        startPeer(run, frame.peer.connId)
        break
      case "rtc.signal":
        if (run.peer && frame.from === run.peerConnId) applySignal(run, frame)
        else run.pending.push(frame)
        break
      case "room.peer-left":
        if (frame.connId === run.peerConnId) dropPeer(run)
        run.pending = run.pending.filter((f) => f.from !== frame.connId)
        break
      case "room.full":
        toast.error("This test room already has two devices")
        stopRun(run)
        break
      case "error":
        console.warn("signaling error", frame.code)
        break
    }
  }

  async function tick(run: Run) {
    const peer = run.peer
    if (run.stopped || !peer || run.sampling) return
    run.sampling = true
    try {
      const s = await sampleCall(peer.pc)
      if (run.stopped || run.peer !== peer) return
      const v = inlineVerdict(s, run.prevBytes, run.forceRelay)
      run.prevBytes = s.inboundBytes
      setSample(s)
      setVerdict(v)
      if (v === "failed") {
        toast.error("The connection failed")
        stopRun(run)
      }
    } catch (err) {
      console.error("getStats failed", err)
    } finally {
      run.sampling = false
    }
  }

  async function start() {
    if (runRef.current) return
    const parsedRoom = RoomId.safeParse(room)
    if (!parsedRoom.success) {
      toast.error("Room: lowercase letters, digits and dashes only")
      return
    }
    const run: Run = {
      room: parsedRoom.data,
      forceRelay,
      stopped: false,
      stream: null,
      iceServers: [],
      sig: null,
      myConnId: null,
      peer: null,
      peerConnId: null,
      pending: [],
      timer: null,
      sampling: false,
      prevBytes: 0,
    }
    runRef.current = run
    setPhase("starting")
    setSample(null)
    setVerdict("waiting")
    setNeedsTap(false)

    try {
      // 1. Camera and microphone first, inside the tap (iOS needs the user gesture, Pitfall M7).
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("no_media")
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: "user" } })
      if (run.stopped) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      run.stream = stream
      attach(localVideo, stream, false)

      // 2. TURN credentials before joining, so the peer can be created the moment the other device shows up.
      const { iceServers } = await fetchIceServers()
      if (run.stopped) return
      run.iceServers = iceServers

      // 3. Signaling socket.
      const sig = new SignalingClient(signalingUrl())
      run.sig = sig
      sig.onFrame((frame) => handleFrame(run, frame))
      sig.onClose((code) => {
        if (run.stopped) return
        toast.error(code === WS_CLOSE_LOGGED_OUT ? "Logged out" : "Lost the signaling connection")
        stopRun(run)
      })
      const hello = await sig.connect()
      if (run.stopped) return
      run.myConnId = hello.connId

      // 4. Join the room.
      sig.send({ t: "room.join", room: run.room })
      run.timer = setInterval(() => void tick(run), 1000)
    } catch (err) {
      if (run.stopped) return
      toast.error(describeError(err))
      stopRun(run)
    }
  }

  const status =
    phase === "idle"
      ? "Not running"
      : phase === "starting"
        ? "Starting camera and connection"
        : phase === "waiting-peer"
          ? "Waiting for the other device"
          : "Connected to the other device's room"

  const rows: { label: string; value: string; testId?: string }[] = [
    { label: "Connection", value: sample?.state ?? "—", testId: "call-state" },
    { label: "Inbound bytes", value: sample ? String(sample.inboundBytes) : "—", testId: "call-bytes" },
    { label: "Local candidate", value: sample?.localType ?? "—", testId: "call-local-type" },
    { label: "Remote candidate", value: sample?.remoteType ?? "—", testId: "call-remote-type" },
    { label: "Relay protocol", value: sample?.relayProtocol ?? "—", testId: "call-relay-protocol" },
    { label: "RTT ms", value: sample?.rttMs !== undefined ? String(sample.rttMs) : "—", testId: "call-rtt" },
  ]

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background pt-[env(safe-area-inset-top)]">
        <div className="flex h-14 items-center gap-3 px-4">
          <Button variant="ghost" size="icon" aria-label="Back" nativeButton={false} render={<a href="/" />}>
            <ArrowLeftIcon />
          </Button>
          <span className="min-w-0 flex-1 truncate font-heading font-medium">Call test</span>
          <Badge
            data-testid="call-verdict"
            variant={verdict === "pass" ? "default" : verdict === "failed" || verdict === "not_relayed" ? "destructive" : "secondary"}
          >
            {verdict ? VERDICT_LABEL[verdict] : "Idle"}
          </Badge>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <Card>
          <CardHeader>
            <CardTitle>Peer-to-peer call path</CardTitle>
            <CardDescription>
              Open this page on both devices with the same room, then tap Start on both. Logged in as{" "}
              {me.user.displayName}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="call-room">Room</FieldLabel>
                <Input
                  id="call-room"
                  value={room}
                  disabled={running}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={!roomValid}
                  onChange={(e) => setRoom(e.target.value.trim().toLowerCase())}
                />
                <FieldDescription>Lowercase letters, digits and dashes.</FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <Switch
                  id="force-relay"
                  data-testid="force-relay"
                  checked={forceRelay}
                  disabled={running}
                  onCheckedChange={(checked) => setForceRelay(checked)}
                />
                <FieldLabel htmlFor="force-relay">Force relay (TURN only)</FieldLabel>
              </Field>
              <div className="flex items-center gap-2">
                <Button data-testid="call-start" disabled={running || !roomValid} onClick={() => void start()}>
                  <PhoneCallIcon />
                  Start
                </Button>
                <Button data-testid="call-stop" variant="outline" disabled={!running} onClick={stop}>
                  <StopIcon />
                  Stop
                </Button>
                {running && verdict !== "pass" && <Spinner className="size-5" />}
              </div>
              <p className="text-sm text-muted-foreground" data-testid="call-status">
                {status}
              </p>
            </FieldGroup>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">You</span>
            <video
              ref={localVideo}
              data-testid="local-video"
              autoPlay
              playsInline
              muted
              className="aspect-[3/4] w-full rounded-2xl bg-muted object-cover"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Other device</span>
            <video
              ref={remoteVideo}
              data-testid="remote-video"
              autoPlay
              playsInline
              className="aspect-[3/4] w-full rounded-2xl bg-muted object-cover"
            />
          </div>
        </div>
        {needsTap && (
          <Button
            variant="secondary"
            onClick={() => {
              void remoteVideo.current?.play().then(() => setNeedsTap(false))
            }}
          >
            <PlayIcon />
            Tap to play
          </Button>
        )}

        <ItemGroup>
          {rows.map((row) => (
            <Item key={row.label} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>{row.label}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="font-mono text-sm tabular-nums" data-testid={row.testId}>
                  {row.label === "Inbound bytes" && sample ? (
                    <span title={formatBytes(sample.inboundBytes)}>{row.value}</span>
                  ) : (
                    row.value
                  )}
                </span>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </main>
      {/* Always dark (D-10). */}
      <Toaster theme="dark" position="top-center" />
    </div>
  )
}
