import { FootageHost, type FootageSegment } from './engine/FootageHost'

/**
 * Segment map for the dev reference footage (public/footage/reference.mp4).
 * Timestamps + mouth anchors are per-footage calibration — swap the video,
 * remap the segments, everything else carries over.
 */
const SEGMENTS: FootageSegment[] = [
  { name: 'idle', start: 13.2, end: 16.8, mouth: { x: 0.47, y: 0.555, r: 0.055 } },
  { name: 'look', start: 22.6, end: 25.8, mouth: { x: 0.615, y: 0.487, r: 0.05 } },
  { name: 'profile', start: 18.2, end: 21.8 },
  { name: 'stand', start: 25.9, end: 27.8 },
  { name: 'reach', start: 28.0, end: 31.2 },
]

const stage = document.getElementById('stage')
if (!stage) throw new Error('missing #stage')

const host = new FootageHost(stage, './footage/reference.mp4', SEGMENTS, 'idle')

declare global {
  interface Window {
    footageHost: FootageHost
  }
}
window.footageHost = host

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const status = $('status')
host.onStatus((message) => {
  status.textContent = message
})

const segmentRow = $('segment-buttons')
for (const name of host.segmentNames()) {
  const button = document.createElement('button')
  button.textContent = name
  button.onclick = () => host.playSegment(name)
  segmentRow.appendChild(button)
}

const bgScene = $<HTMLButtonElement>('bg-scene')
const bgTransparent = $<HTMLButtonElement>('bg-transparent')
bgScene.onclick = () => {
  host.setBackground('scene')
  document.body.classList.remove('transparent-mode', 'show-checker')
  bgScene.classList.add('active')
  bgTransparent.classList.remove('active')
}
bgTransparent.onclick = () => {
  host.setBackground('transparent')
  document.body.classList.add('transparent-mode', 'show-checker')
  bgTransparent.classList.add('active')
  bgScene.classList.remove('active')
}

$<HTMLButtonElement>('speak-demo').onclick = () => host.speakDemo()
const speakFile = $<HTMLInputElement>('speak-file')
speakFile.onchange = () => {
  const file = speakFile.files?.item(0)
  if (file) void host.speak(file)
  speakFile.value = ''
}
$<HTMLButtonElement>('mic').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    await host.speak(stream)
  } catch {
    status.textContent = 'mic permission denied'
  }
}

const recordButton = $<HTMLButtonElement>('record')
recordButton.onclick = async () => {
  recordButton.disabled = true
  status.textContent = 'recording 8s…'
  const blob = await host.record(8)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'living-footage.webm'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  recordButton.disabled = false
  status.textContent = `saved living-footage.webm (${(blob.size / 1_000_000).toFixed(1)} MB)`
}
