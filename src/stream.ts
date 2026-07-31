/**
 * GPU-stream client. Two transports, one surface:
 *  - ws://…    dev streamer (MJPEG frames over WebSocket) — runs anywhere
 *  - http(s)://…/offer   production WebRTC (aiortc on the GPU box)
 * Commands ({cmd:"speak", text}) ride the same connection either way.
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

type Connection = { stop(): void; send(message: object): void }
let connection: Connection | null = null
let frameCount = 0
let statsTimer = 0

function startStats() {
  frameCount = 0
  statsTimer = window.setInterval(() => {
    stats.textContent = `${frameCount} fps`
    frameCount = 0
  }, 1000)
}

function stopStats() {
  clearInterval(statsTimer)
  stats.textContent = ''
}

async function connectWebSocket(url: string): Promise<Connection> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  stage.replaceChildren(canvas)

  const socket = new WebSocket(url)
  socket.binaryType = 'blob'
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error(`cannot reach ${url}`))
  })

  socket.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      statusEl.textContent = `server: ${event.data}`
      return
    }
    const bitmap = await createImageBitmap(event.data as Blob)
    if (canvas.width !== bitmap.width) {
      canvas.width = bitmap.width
      canvas.height = bitmap.height
    }
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    frameCount += 1
  }
  socket.onclose = () => {
    statusEl.textContent = 'disconnected'
  }

  return {
    stop: () => socket.close(),
    send: (message) => socket.send(JSON.stringify(message)),
  }
}

async function connectWebRtc(offerUrl: string): Promise<Connection> {
  const video = document.createElement('video')
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  stage.replaceChildren(video)

  const peer = new RTCPeerConnection()
  const channel = peer.createDataChannel('commands')
  channel.onmessage = (event) => {
    statusEl.textContent = `server: ${event.data}`
  }
  peer.ontrack = (event) => {
    video.srcObject = event.streams[0] ?? new MediaStream([event.track])
  }
  peer.addTransceiver('video', { direction: 'recvonly' })

  const offer = await peer.createOffer()
  await peer.setLocalDescription(offer)
  await new Promise<void>((resolve) => {
    if (peer.iceGatheringState === 'complete') resolve()
    else {
      const check = () => {
        if (peer.iceGatheringState === 'complete') {
          peer.removeEventListener('icegatheringstatechange', check)
          resolve()
        }
      }
      peer.addEventListener('icegatheringstatechange', check)
    }
  })

  const response = await fetch(offerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: peer.localDescription?.sdp, type: peer.localDescription?.type }),
  })
  if (!response.ok) throw new Error(`offer rejected (${response.status})`)
  await peer.setRemoteDescription(await response.json())

  const counter = window.setInterval(() => {
    frameCount = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
  }, 1000)

  return {
    stop: () => {
      clearInterval(counter)
      peer.close()
    },
    send: (message) => {
      if (channel.readyState === 'open') channel.send(JSON.stringify(message))
    },
  }
}

connectButton.onclick = async () => {
  const url = serverInput.value.trim()
  statusEl.textContent = `connecting to ${url}…`
  try {
    connection = url.startsWith('ws') ? await connectWebSocket(url) : await connectWebRtc(url)
    statusEl.textContent = 'live'
    connectButton.disabled = true
    disconnectButton.disabled = false
    startStats()
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error)
  }
}

disconnectButton.onclick = () => {
  connection?.stop()
  connection = null
  connectButton.disabled = false
  disconnectButton.disabled = true
  stopStats()
  statusEl.textContent = 'stopped'
}

sendButton.onclick = () => {
  const text = sayInput.value.trim()
  if (text && connection) connection.send({ cmd: 'speak', text })
}

export {}
