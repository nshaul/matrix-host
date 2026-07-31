import { HologramHost } from './engine/HologramHost'
import { HostVoice, VoiceCommands, parseVoiceCommand, type VoiceEngine } from './voice'

const stage = document.getElementById('stage')
if (!stage) throw new Error('missing #stage element')

const host = new HologramHost(stage)

// Expose the control surface for external drivers (ElevenLabs glue, stream deck,
// livestream tooling): window.matrixHost.speak(url), .wave(), .setHeadLook(...)
// and window.hostVoice.speak('hello', { engine: 'system' })
declare global {
  interface Window {
    matrixHost: HologramHost
    hostVoice: HostVoice
    parseVoiceCommand: typeof parseVoiceCommand
  }
}
window.matrixHost = host
// Debug surface: lets external tooling (and headless verification) exercise the
// real spoken-command grammar without a microphone.
window.parseVoiceCommand = parseVoiceCommand

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
const subjectSelect = $<HTMLSelectElement>('subject-select')
const fileInput = $<HTMLInputElement>('subject-file')
let subjectUrl: string | null = null

async function swapSubject(url: string) {
  try {
    await host.loadSubject(url)
  } catch (error) {
    status.textContent = `subject failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

subjectSelect.onchange = () => void swapSubject(subjectSelect.value)
fileInput.onchange = () => {
  const file = fileInput.files?.item(0)
  if (!file) return
  if (subjectUrl) URL.revokeObjectURL(subjectUrl)
  subjectUrl = URL.createObjectURL(file)
  void swapSubject(subjectUrl)
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
$<HTMLButtonElement>('point').onclick = () => host.point()
$<HTMLButtonElement>('scold').onclick = () => host.scold()
$<HTMLButtonElement>('yell').onclick = () => host.yell()
$<HTMLButtonElement>('thumbsup').onclick = () => host.thumbsUp()
$<HTMLButtonElement>('point-corner').onclick = () => host.pointAt(0.9, 0.12, { durationSeconds: 3.5 })
$<HTMLSelectElement>('framing').onchange = (event) => {
  host.setFraming((event.target as HTMLSelectElement).value as 'closeup' | 'bust' | 'waist' | 'full')
}
$<HTMLSelectElement>('emotion').onchange = (event) => {
  host.setEmotion((event.target as HTMLSelectElement).value as 'neutral' | 'happy' | 'angry' | 'sad' | 'relaxed')
}
$<HTMLButtonElement>('orbit').onclick = () => {
  status.textContent = 'drag the stage to orbit, wheel to zoom'
}

// ----- voice: the host's own voice (system / kokoro / elevenlabs) -----
const hostVoice = new HostVoice(host, (message) => {
  status.textContent = message
})
window.hostVoice = hostVoice

const engineSelect = $<HTMLSelectElement>('voice-engine')
const voiceSelect = $<HTMLSelectElement>('voice-name')
const keyRow = $('eleven-key-row')
const keyInput = $<HTMLInputElement>('eleven-key')
const sayText = $<HTMLInputElement>('say-text')
const sayButton = $<HTMLButtonElement>('say')

const currentEngine = (): VoiceEngine => engineSelect.value as VoiceEngine
// An empty key field means "no key provided" — HostVoice then fails loud for elevenlabs.
const currentKey = (): string | undefined => {
  const key = keyInput.value.trim()
  return key === '' ? undefined : key
}
// '' is the "Default voice" option — each engine documents its own default voice.
const currentVoice = (): string | undefined => {
  return voiceSelect.value === '' ? undefined : voiceSelect.value
}

let voiceListSeq = 0
async function refreshVoices() {
  const seq = ++voiceListSeq
  const engine = currentEngine()
  const voices = await hostVoice.listVoices(engine, currentKey())
  if (seq !== voiceListSeq) return // engine switched while the list loaded
  voiceSelect.innerHTML = ''
  if (voices.length === 0) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = 'Default voice'
    voiceSelect.appendChild(option)
    return
  }
  for (const voice of voices) {
    const option = document.createElement('option')
    option.value = voice.id
    option.textContent = voice.label
    voiceSelect.appendChild(option)
  }
}

engineSelect.onchange = () => {
  keyRow.hidden = currentEngine() !== 'elevenlabs'
  void refreshVoices()
}
keyInput.onchange = () => {
  if (currentEngine() === 'elevenlabs') void refreshVoices()
}

function sayIt() {
  const text = sayText.value.trim()
  if (!text) {
    status.textContent = 'type something to say first'
    return
  }
  hostVoice.speak(text, { engine: currentEngine(), voice: currentVoice(), apiKey: currentKey() }).catch(() => {
    // error message already on the status line via HostVoice's status callback
  })
}
sayButton.onclick = sayIt
sayText.onkeydown = (event) => {
  if (event.key === 'Enter') sayIt()
}
void refreshVoices()

// ----- voice control: spoken commands drive the host -----
const voiceControlButton = $<HTMLButtonElement>('voice-control')
const voiceCommands = new VoiceCommands({
  onStatus: (message) => {
    status.textContent = message
  },
  onStateChange: (active) => {
    voiceControlButton.classList.toggle('active', active)
  },
  onAction: (action) => {
    switch (action.type) {
      case 'wave':
        host.wave()
        break
      case 'point':
        host.point()
        break
      case 'point-at':
        host.pointAt(action.x, action.y, { durationSeconds: 3.5 })
        break
      case 'thumbs-up':
        host.thumbsUp()
        break
      case 'scold':
        host.scold()
        break
      case 'yell':
        host.yell()
        break
      case 'look':
        yaw.value = String(action.yaw)
        pitch.value = String(action.pitch)
        host.setHeadLook(action.yaw, action.pitch)
        break
      case 'emotion':
        $<HTMLSelectElement>('emotion').value = action.name
        host.setEmotion(action.name)
        break
      case 'background':
        // Route through the buttons so panel state stays consistent.
        if (action.mode === 'transparent') bgTransparent.click()
        else bgMatrix.click()
        break
      case 'say':
        hostVoice.speak(action.text, { engine: currentEngine(), voice: currentVoice(), apiKey: currentKey() }).catch(() => {
          // error message already on the status line via HostVoice's status callback
        })
        break
      case 'stop-listening':
        break // VoiceCommands stops itself; onStateChange resets the button
    }
  },
})
voiceControlButton.onclick = () => {
  if (voiceCommands.active) voiceCommands.stop()
  else voiceCommands.start()
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
void swapSubject(subjectSelect.value)
