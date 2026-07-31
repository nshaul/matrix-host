/**
 * GPU-stream client. Two transports, one surface:
 *  - ws://…               dev streamer (MJPEG frames over WebSocket) — video only by design
 *  - http(s)://…/offer    production WebRTC (aiortc on the GPU box) — video + TTS voice
 * Commands ({cmd:"speak", text}) ride the same connection either way.
 *
 * Resilience: any unexpected drop (ws close/error, peer failed/disconnected/closed)
 * auto-reconnects with backoff 1s→2s→4s→8s→15s→15s (max 6 attempts, live countdown).
 * Stop cancels retries; a successful reconnect resets the backoff. Commands sent
 * while the link is down are queued (bounded) and flushed when it returns.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const stage = $('stage')
const statusEl = $('status')
const stats = $('stats')
const serverInput = $<HTMLInputElement>('server')
const connectButton = $<HTMLButtonElement>('connect')
const disconnectButton = $<HTMLButtonElement>('disconnect')
const sayInput = $<HTMLInputElement>('say')
const sendButton = $<HTMLButtonElement>('send')
const soundGate = $<HTMLButtonElement>('soundGate')
const volumeRow = $('volumeRow')
const volumeInput = $<HTMLInputElement>('volume')

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 15000] as const
const MAX_ATTEMPTS = BACKOFF_MS.length
const OUTBOX_LIMIT = 8

type Transport = {
  /** true if the message was handed to an open channel; false = not connected right now */
  send(message: object): boolean
  /** Full teardown: clears timers, revokes handlers, closes peer/socket. Idempotent. */
  stop(): void
}

type Session = {
  url: string
  transport: Transport | null
  /** 0 = connected/fresh; N = the upcoming (or in-flight) reconnect attempt number */
  attempt: number
  retryTimer: number
  countdownTimer: number
  stopped: boolean
  lastError: string
  outbox: object[]
}

let session: Session | null = null
let currentVideo: HTMLVideoElement | null = null

function formatBitrate(bytesPerSecond: number): string {
  const bits = bytesPerSecond * 8
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbps`
  return `${Math.max(0, Math.round(bits / 1_000))} kbps`
}

function formatByteRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1_000_000) return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`
  return `${Math.max(0, Math.round(bytesPerSecond / 1_000))} KB/s`
}

/**
 * Autoplay policy: Connect is a user gesture, so play() with sound normally
 * succeeds. If the browser still refuses, keep the picture running muted and
 * surface a one-click unmute (a click IS a fresh gesture, so it succeeds).
 */
async function tryPlay(video: HTMLVideoElement): Promise<void> {
  if (!video.srcObject) return
  video.muted = false
  try {
    await video.play()
    soundGate.hidden = true
  } catch {
    video.muted = true
    video.play().catch(() => {
      // Even muted playback refused; the sound-gate click will start both.
    })
    soundGate.hidden = false
  }
}

soundGate.onclick = () => {
  const video = currentVideo
  if (!video) {
    soundGate.hidden = true
    return
  }
  video.muted = false
  video
    .play()
    .then(() => {
      soundGate.hidden = true
    })
    .catch(() => {
      // Keep the gate visible; the next click retries.
    })
}

volumeInput.oninput = () => {
  if (currentVideo) currentVideo.volume = Number(volumeInput.value) / 100
}

/** Dev MJPEG-over-WebSocket transport. Video only by design (the dev streamer has no audio). */
async function connectWebSocket(url: string, onDeath: () => void): Promise<Transport> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')

  const socket = new WebSocket(url)
  socket.binaryType = 'blob'
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error(`cannot reach ${url}`))
    socket.onclose = () => reject(new Error(`cannot reach ${url}`))
  })

  // Claim the stage only once the socket is open, so a failing retry leaves
  // the last good frame visible instead of blanking the viewport.
  stage.replaceChildren(canvas)
  currentVideo = null
  volumeRow.hidden = true
  soundGate.hidden = true

  let dead = false
  let frameCount = 0
  let byteCount = 0
  const statsTimer = window.setInterval(() => {
    stats.textContent = `${frameCount} fps · ${formatByteRate(byteCount)}`
    frameCount = 0
    byteCount = 0
  }, 1000)

  function teardown(): void {
    if (dead) return
    dead = true
    clearInterval(statsTimer)
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    socket.close()
  }

  socket.onmessage = async (event) => {
    if (dead) return
    if (typeof event.data === 'string') {
      statusEl.textContent = `server: ${event.data}`
      return
    }
    const blob = event.data as Blob
    byteCount += blob.size
    const bitmap = await createImageBitmap(blob)
    if (dead) {
      bitmap.close()
      return
    }
    if (canvas.width !== bitmap.width) {
      canvas.width = bitmap.width
      canvas.height = bitmap.height
    }
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    frameCount += 1
  }
  const die = () => {
    if (dead) return
    teardown()
    onDeath()
  }
  socket.onclose = die
  socket.onerror = die

  return {
    send: (message) => {
      if (dead || socket.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify(message))
      return true
    },
    stop: teardown,
  }
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => {
      if (peer.iceGatheringState === 'complete') finish()
    }
    // Cap the wait: host candidates arrive immediately, and aiortc answers
    // fine with whatever has gathered by then — never stall the connect.
    const timer = window.setTimeout(finish, 3000)
    peer.addEventListener('icegatheringstatechange', check)
  })
}

/** Production WebRTC transport (aiortc): video + TTS audio + data-channel commands. */
async function connectWebRtc(
  offerUrl: string,
  onDeath: () => void,
  onReady: () => void,
): Promise<Transport> {
  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.volume = Number(volumeInput.value) / 100

  const peer = new RTCPeerConnection()
  const channel = peer.createDataChannel('commands')
  let dead = false

  // Audio and video tracks can arrive in separate ontrack events; aiortc
  // usually groups them into event.streams[0], but accumulate defensively.
  const remoteStream = new MediaStream()
  peer.ontrack = (event) => {
    if (dead) return
    const stream = event.streams[0]
    if (stream) {
      if (video.srcObject !== stream) video.srcObject = stream
    } else {
      remoteStream.addTrack(event.track)
      if (video.srcObject !== remoteStream) video.srcObject = remoteStream
    }
    void tryPlay(video)
  }
  peer.addTransceiver('video', { direction: 'recvonly' })
  peer.addTransceiver('audio', { direction: 'recvonly' })

  try {
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await waitForIceGathering(peer)
    const response = await fetch(offerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: peer.localDescription?.sdp, type: peer.localDescription?.type }),
    })
    if (!response.ok) throw new Error(`offer rejected (${response.status})`)
    await peer.setRemoteDescription(await response.json())
  } catch (error) {
    peer.close()
    // fetch network failures throw TypeError with an unhelpful message
    throw error instanceof TypeError ? new Error(`cannot reach ${offerUrl}`) : error
  }

  stage.replaceChildren(video)
  currentVideo = video
  volumeRow.hidden = false

  let lastBytes = 0
  let lastTime = performance.now()
  const statsTimer = window.setInterval(() => {
    void sampleStats()
  }, 1000)

  async function sampleStats(): Promise<void> {
    if (dead) return
    let report: RTCStatsReport
    try {
      report = await peer.getStats()
    } catch {
      return // peer mid-teardown; the connection-state watcher owns reporting that
    }
    let selectedPairId: string | undefined
    report.forEach((entry) => {
      if (entry.type === 'transport') {
        const transportStats = entry as RTCTransportStats
        if (transportStats.selectedCandidatePairId) selectedPairId = transportStats.selectedCandidatePairId
      }
    })
    let fps: number | undefined
    let bytesReceived = 0
    let rttMs: number | undefined
    report.forEach((entry) => {
      if (entry.type === 'inbound-rtp') {
        const rtp = entry as RTCInboundRtpStreamStats
        if (rtp.kind === 'video') {
          fps = rtp.framesPerSecond
          bytesReceived = rtp.bytesReceived ?? 0
        }
      } else if (entry.type === 'candidate-pair') {
        const pair = entry as RTCIceCandidatePairStats
        const selected = selectedPairId
          ? pair.id === selectedPairId
          : pair.state === 'succeeded' && pair.nominated === true
        if (selected && pair.currentRoundTripTime !== undefined) {
          rttMs = Math.round(pair.currentRoundTripTime * 1000)
        }
      }
    })
    const now = performance.now()
    const seconds = Math.max((now - lastTime) / 1000, 0.001)
    const rate = Math.max(bytesReceived - lastBytes, 0) / seconds
    lastBytes = bytesReceived
    lastTime = now
    const parts = [`${fps !== undefined ? Math.round(fps) : '–'} fps`]
    if (rttMs !== undefined) parts.push(`${rttMs} ms`)
    parts.push(formatBitrate(rate))
    stats.textContent = parts.join(' · ')
  }

  function teardown(): void {
    if (dead) return
    dead = true
    clearInterval(statsTimer)
    peer.ontrack = null
    peer.onconnectionstatechange = null
    channel.onopen = null
    channel.onmessage = null
    video.srcObject = null
    peer.close()
  }

  channel.onopen = () => {
    if (!dead) onReady()
  }
  channel.onmessage = (event) => {
    if (!dead) statusEl.textContent = `server: ${event.data}`
  }
  peer.onconnectionstatechange = () => {
    if (dead) return
    const state = peer.connectionState
    if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      teardown()
      onDeath()
    }
  }

  return {
    send: (message) => {
      if (dead || channel.readyState !== 'open') return false
      channel.send(JSON.stringify(message))
      return true
    },
    stop: teardown,
  }
}

function setConnectedUi(active: boolean): void {
  connectButton.disabled = active
  disconnectButton.disabled = !active
}

async function attemptConnect(sess: Session): Promise<void> {
  if (sess !== session || sess.stopped) return
  statusEl.textContent =
    sess.attempt === 0
      ? `connecting to ${sess.url}…`
      : `reconnecting… attempt ${sess.attempt}/${MAX_ATTEMPTS}`
  try {
    const onDeath = () => handleDrop(sess)
    const onReady = () => {
      if (sess === session && !sess.stopped) flushOutbox(sess)
    }
    const transport = sess.url.startsWith('ws')
      ? await connectWebSocket(sess.url, onDeath)
      : await connectWebRtc(sess.url, onDeath, onReady)
    if (sess !== session || sess.stopped) {
      // Stop was pressed while this attempt was in flight — no zombies.
      transport.stop()
      return
    }
    sess.transport = transport
    sess.attempt = 0
    sess.lastError = ''
    statusEl.textContent = sess.url.startsWith('ws') ? 'live · dev MJPEG (video only)' : 'live'
    flushOutbox(sess)
  } catch (error) {
    if (sess !== session || sess.stopped) return
    sess.lastError = error instanceof Error ? error.message : String(error)
    scheduleRetry(sess)
  }
}

function handleDrop(sess: Session): void {
  if (sess !== session || sess.stopped) return
  sess.transport = null
  stats.textContent = ''
  scheduleRetry(sess)
}

function scheduleRetry(sess: Session): void {
  sess.attempt += 1
  if (sess.attempt > MAX_ATTEMPTS) {
    const reason = sess.lastError ? ` (${sess.lastError})` : ''
    stopSession(`connection lost · gave up after ${MAX_ATTEMPTS} attempts${reason}`)
    return
  }
  const waitMs = BACKOFF_MS[sess.attempt - 1]
  const deadline = performance.now() + waitMs
  const renderCountdown = () => {
    const secondsLeft = Math.max(0, Math.ceil((deadline - performance.now()) / 1000))
    const queued = sess.outbox.length > 0 ? ` · ${sess.outbox.length} queued` : ''
    statusEl.textContent = `reconnecting in ${secondsLeft}s · attempt ${sess.attempt}/${MAX_ATTEMPTS}${queued}`
  }
  renderCountdown()
  sess.countdownTimer = window.setInterval(renderCountdown, 200)
  sess.retryTimer = window.setTimeout(() => {
    clearInterval(sess.countdownTimer)
    void attemptConnect(sess)
  }, waitMs)
}

function stopSession(finalStatus: string): void {
  const sess = session
  if (!sess) return
  sess.stopped = true
  session = null
  clearTimeout(sess.retryTimer)
  clearInterval(sess.countdownTimer)
  sess.transport?.stop()
  sess.transport = null
  sess.outbox.length = 0
  currentVideo = null
  volumeRow.hidden = true
  soundGate.hidden = true
  stats.textContent = ''
  statusEl.textContent = finalStatus
  setConnectedUi(false)
}

function sendCommand(message: object): void {
  const sess = session
  if (!sess) {
    statusEl.textContent = 'not connected · press Connect first'
    return
  }
  if (sess.transport && sess.transport.send(message)) return
  if (sess.outbox.length >= OUTBOX_LIMIT) sess.outbox.shift()
  sess.outbox.push(message)
  statusEl.textContent = `queued (${sess.outbox.length}) · sends when the link returns`
}

function flushOutbox(sess: Session): void {
  while (sess.outbox.length > 0) {
    const message = sess.outbox[0]
    if (!sess.transport || !sess.transport.send(message)) break
    sess.outbox.shift()
  }
}

connectButton.onclick = () => {
  if (session) return
  const url = serverInput.value.trim()
  if (!url) {
    statusEl.textContent = 'enter a server URL first'
    return
  }
  session = {
    url,
    transport: null,
    attempt: 0,
    retryTimer: 0,
    countdownTimer: 0,
    stopped: false,
    lastError: '',
    outbox: [],
  }
  setConnectedUi(true)
  void attemptConnect(session)
}

disconnectButton.onclick = () => stopSession('stopped')

sendButton.onclick = () => {
  const text = sayInput.value.trim()
  if (!text) return
  sendCommand({ cmd: 'speak', text })
}
sayInput.onkeydown = (event) => {
  if (event.key === 'Enter') sendButton.click()
}

export {}
