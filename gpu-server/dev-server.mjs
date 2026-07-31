// Dev frame-streamer: proves the browser client + command channel end-to-end
// on any machine, no GPU, no Python — ffmpeg pipes the reference footage as
// MJPEG frames over WebSocket. The production path is the aiortc WebRTC
// server (server.py) on the GPU box; the browser client speaks both.
//
// Run: node gpu-server/dev-server.mjs   (ws://localhost:8789)
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'public', 'footage', 'reference.mp4')
const PORT = 8789

const server = createServer()
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  console.log('[dev-server] client connected')
  const ffmpeg = spawn('ffmpeg', [
    '-re',
    '-stream_loop', '-1',
    '-i', source,
    '-f', 'mjpeg',
    '-q:v', '4',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] })

  // MJPEG frame splitter: JPEG SOI (ffd8) … EOI (ffd9)
  let buffer = Buffer.alloc(0)
  ffmpeg.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const start = buffer.indexOf(Buffer.from([0xff, 0xd8]))
      if (start < 0) return
      const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
      if (end < 0) return
      const frame = buffer.subarray(start, end + 2)
      buffer = buffer.subarray(end + 2)
      if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true })
    }
  })

  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    // Command channel: replies mirror the GPU server's (server.py CommandRouter)
    // shapes so the client UI exercises realistic status either way.
    let message
    try {
      message = JSON.parse(String(data))
    } catch (error) {
      ws.send(JSON.stringify({ ok: false, error: String(error) }))
      return
    }
    if (message.cmd === 'speak') {
      ws.send(JSON.stringify({ ok: true, spoke: { engine: 'dev-echo', seconds: 0, samples: 0, text: message.text ?? null } }))
    } else if (message.cmd === 'stop') {
      ws.send(JSON.stringify({ ok: true, stopped: true }))
    } else if (message.cmd === 'status') {
      ws.send(JSON.stringify({ ok: true, generator: 'dev-mjpeg', model_ready: true, uptime_s: Math.round(process.uptime()), gpu: null, fps: 30 }))
    } else {
      ws.send(JSON.stringify({ ok: false, error: `unknown cmd ${JSON.stringify(message.cmd)}`, known: ['speak', 'stop', 'status'] }))
    }
  })

  ws.on('close', () => {
    ffmpeg.kill('SIGKILL')
    console.log('[dev-server] client left')
  })
})

server.listen(PORT, () => console.log(`[dev-server] ws://localhost:${PORT} (mjpeg over websocket)`))
