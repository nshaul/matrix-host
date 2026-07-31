import { HologramHost } from './engine/HologramHost'

const stage = document.getElementById('stage')
if (!stage) throw new Error('missing #stage element')

const host = new HologramHost(stage)

// Expose the control surface for external drivers (ElevenLabs glue, stream deck,
// livestream tooling): window.matrixHost.speak(url), .wave(), .setHeadLook(...)
declare global {
  interface Window {
    matrixHost: HologramHost
  }
}
window.matrixHost = host

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const status = $('#status'.slice(1))
host.onStatus((message) => {
  status.textContent = message
})
const fps = $('#fps'.slice(1))
host.onFps((value) => {
  fps.textContent = `${value} fps`
})

// ----- subject switching -----
const girlButton = $<HTMLButtonElement>('subject-girl')
const boyButton = $<HTMLButtonElement>('subject-boy')
const fileInput = $<HTMLInputElement>('subject-file')
let subjectUrl: string | null = null

function markSubject(active: HTMLButtonElement | null) {
  for (const b of [girlButton, boyButton]) b.classList.toggle('active', b === active)
}

async function swapSubject(url: string, active: HTMLButtonElement | null) {
  markSubject(active)
  try {
    await host.loadSubject(url)
  } catch (error) {
    status.textContent = `subject failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

girlButton.onclick = () => void swapSubject('./avatars/alicia.vrm', girlButton)
boyButton.onclick = () => void swapSubject('./avatars/boy.vrm', boyButton)
fileInput.onchange = () => {
  const file = fileInput.files?.item(0)
  if (!file) return
  if (subjectUrl) URL.revokeObjectURL(subjectUrl)
  subjectUrl = URL.createObjectURL(file)
  void swapSubject(subjectUrl, null)
  fileInput.value = ''
}

// ----- background mode -----
const bgMatrix = $<HTMLButtonElement>('bg-matrix')
const bgTransparent = $<HTMLButtonElement>('bg-transparent')
bgMatrix.onclick = () => {
  host.setBackground('matrix')
  document.body.classList.remove('transparent-mode', 'show-checker')
  bgMatrix.classList.add('active')
  bgTransparent.classList.remove('active')
}
bgTransparent.onclick = () => {
  host.setBackground('transparent')
  document.body.classList.add('transparent-mode', 'show-checker')
  bgTransparent.classList.add('active')
  bgMatrix.classList.remove('active')
  status.textContent = 'transparent: checkerboard is the demo backdrop — OBS gets true alpha'
}

// ----- head look + gestures -----
const yaw = $<HTMLInputElement>('yaw')
const pitch = $<HTMLInputElement>('pitch')
const applyLook = () => host.setHeadLook(Number(yaw.value), Number(pitch.value))
yaw.oninput = applyLook
pitch.oninput = applyLook
$<HTMLButtonElement>('wave').onclick = () => host.wave()
$<HTMLButtonElement>('orbit').onclick = () => {
  status.textContent = 'drag the stage to orbit, wheel to zoom'
}

// ----- talk -----
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

// ----- record -----
const recordButton = $<HTMLButtonElement>('record')
recordButton.onclick = async () => {
  recordButton.disabled = true
  status.textContent = 'recording 8s…'
  const blob = await host.record(8)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'matrix-host.webm'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  recordButton.disabled = false
  status.textContent = `saved matrix-host.webm (${(blob.size / 1_000_000).toFixed(1)} MB)`
}

// ----- boot -----
void swapSubject('./avatars/alicia.vrm', girlButton)
