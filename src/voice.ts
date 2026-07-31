import type { GenerateOptions, KokoroTTS } from 'kokoro-js'
import type { HologramHost } from './engine/HologramHost'

// ---------------------------------------------------------------------------
// HostVoice — the avatar's own voice. Three engines:
//   system     — speechSynthesis: instant, offline, zero download. No audio
//                stream is exposed, so the mouth is driven by a text-derived
//                viseme track (see SystemVisemeDriver).
//   kokoro     — in-browser neural TTS (kokoro-js, ~90 MB one-time download,
//                cached by the browser). Free forever, no key, no server.
//   elevenlabs — premium option with the user's own API key. Key lives in
//                memory only — never persisted (project law: no localStorage).
// ---------------------------------------------------------------------------

export type VoiceEngine = 'system' | 'kokoro' | 'elevenlabs'

export interface VoiceOption {
  id: string
  label: string
}

export interface SpeakOptions {
  engine: VoiceEngine
  /** Engine-specific voice id (system: voiceURI, kokoro: e.g. 'af_heart', elevenlabs: voice id). */
  voice?: string
  /** ElevenLabs API key — required for the elevenlabs engine, ignored otherwise. */
  apiKey?: string
}

type VisemeKey = 'aa' | 'ih' | 'ou' | 'ee' | 'oh'
type VisemeWeights = { aa?: number; ih?: number; ou?: number; ee?: number; oh?: number }

const VOWEL_TO_VISEME: Record<string, VisemeKey> = {
  a: 'aa',
  e: 'ee',
  i: 'ih',
  o: 'oh',
  u: 'ou',
  y: 'ih',
}

/** Mouth chatter rate for the text-driven track: one open/close pulse per slot. */
const VISEME_SLOT_MS = 84 // ~12 Hz — inside the natural 10–14 Hz speech envelope

interface VisemeWord {
  /** Start offset (ms) in the self-paced schedule. */
  start: number
  duration: number
  /** Character index of the word in the source text (for onboundary resync). */
  charStart: number
  /** Vowel-derived viseme frames, cycled through for the word's duration. */
  frames: VisemeKey[]
}

/**
 * Drives host.setVisemes from text alone. speechSynthesis exposes no audio to
 * analyse, so this is the mouth. Two clocks cooperate:
 *  - a self-paced schedule built from estimated per-word durations — always
 *    running, so the track works even where onboundary never fires (Firefox,
 *    headless Chrome, voiceless environments);
 *  - utterance.onboundary (per word in Chrome) resyncs the schedule to the
 *    word actually being spoken, so with a real voice the mouth tracks it.
 */
class SystemVisemeDriver {
  private words: VisemeWord[] = []
  private timer = 0
  private clockStart = 0
  private sawSpeechEvents = false
  private finished = false

  constructor(
    private readonly applyVisemes: (weights: VisemeWeights | null) => void,
    private readonly onDone: () => void,
  ) {}

  start(text: string): void {
    this.words = SystemVisemeDriver.buildTrack(text)
    this.clockStart = performance.now()
    this.timer = window.setInterval(() => this.tick(), 33)
  }

  /** The synthesis engine reported real progress — trust its clock from here on. */
  markSpeechStarted(): void {
    this.sawSpeechEvents = true
    this.clockStart = performance.now()
  }

  /** onboundary: resync the schedule so the reported word starts now. */
  onBoundary(charIndex: number): void {
    this.sawSpeechEvents = true
    let index = 0
    for (let i = 0; i < this.words.length; i += 1) {
      if (this.words[i].charStart <= charIndex) index = i
      else break
    }
    this.clockStart = performance.now() - this.words[index].start
  }

  stop(): void {
    if (this.finished) return
    this.finished = true
    window.clearInterval(this.timer)
    this.applyVisemes(null)
    this.onDone()
  }

  private tick(): void {
    if (this.finished || this.words.length === 0) {
      if (this.words.length === 0) this.stop()
      return
    }
    const t = performance.now() - this.clockStart
    const last = this.words[this.words.length - 1]
    const scheduleEnd = last.start + last.duration

    if (t >= scheduleEnd) {
      if (!this.sawSpeechEvents) {
        // Voiceless environment: the schedule is the only clock — we're done.
        if (t >= scheduleEnd + 250) this.stop()
        else this.applyVisemes({})
      } else if (t >= scheduleEnd + 4000) {
        // Engine stalled after real events — hard cap so the mouth never sticks.
        this.stop()
      } else {
        // Waiting for onend: hold the mouth closed but keep ownership.
        this.applyVisemes({})
      }
      return
    }

    const word = this.words.find((w) => t >= w.start && t < w.start + w.duration)
    if (!word) {
      this.applyVisemes({}) // inter-word gap — mouth closed
      return
    }
    const local = t - word.start
    const slot = Math.floor(local / VISEME_SLOT_MS) % word.frames.length
    const frac = (local % VISEME_SLOT_MS) / VISEME_SLOT_MS
    // Sine pulse per slot: mouth opens and closes once per viseme frame.
    const weight = 0.18 + 0.62 * Math.sin(Math.PI * frac)
    this.applyVisemes({ [word.frames[slot]]: weight })
  }

  private static buildTrack(text: string): VisemeWord[] {
    const words: VisemeWord[] = []
    const matcher = /\S+/g
    let match: RegExpExecArray | null
    let cursor = 0
    while ((match = matcher.exec(text)) !== null) {
      const raw = match[0]
      const frames: VisemeKey[] = []
      for (const char of raw.toLowerCase()) {
        const viseme = VOWEL_TO_VISEME[char]
        if (viseme) frames.push(viseme)
      }
      // Consonant-only word ("hmm", "pst"): the mouth still moves — a closed-ish
      // 'ih' is the honest shape for it, not a skipped beat.
      if (frames.length === 0) frames.push('ih')
      const duration = Math.min(850, Math.max(220, 160 + raw.length * 65))
      words.push({ start: cursor, duration, charStart: match.index, frames })
      cursor += duration + 40 // small inter-word gap
    }
    return words
  }
}

/** Curated Kokoro voices — ids from the Kokoro-82M ONNX release. */
const KOKORO_VOICES: VoiceOption[] = [
  { id: 'af_heart', label: 'Heart · US female' },
  { id: 'af_bella', label: 'Bella · US female' },
  { id: 'af_nicole', label: 'Nicole · US female (soft)' },
  { id: 'af_sky', label: 'Sky · US female' },
  { id: 'am_michael', label: 'Michael · US male' },
  { id: 'am_fenrir', label: 'Fenrir · US male (deep)' },
  { id: 'am_puck', label: 'Puck · US male' },
  { id: 'bf_emma', label: 'Emma · UK female' },
  { id: 'bf_isabella', label: 'Isabella · UK female' },
  { id: 'bm_george', label: 'George · UK male' },
  { id: 'bm_lewis', label: 'Lewis · UK male' },
]

const ELEVEN_API = 'https://api.elevenlabs.io'
const ELEVEN_DEFAULT_VOICE: VoiceOption = { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel · default' }
const ELEVEN_MODEL = 'eleven_multilingual_v2'

export class HostVoice {
  /** Debug/verification hooks: last weights we pushed (null = analyser owns the mouth). */
  _debugCurrentWeights: VisemeWeights | null = null
  /** Peak viseme weight since the current/last speak started. */
  _debugVisemePeak = 0

  private speakSeq = 0
  private systemDriver: SystemVisemeDriver | null = null
  private elevenAbort: AbortController | null = null
  private kokoroPromise: Promise<KokoroTTS> | null = null

  constructor(
    private readonly host: HologramHost,
    private readonly status: (message: string) => void,
  ) {}

  /**
   * Speak `text` with the chosen engine. Resolves when the utterance has
   * finished (system) or once audio playback has started (kokoro/elevenlabs —
   * the host's analyser lip-sync takes over from there). Rejects with a clear
   * message on any failure; every error is also surfaced to the status line.
   */
  async speak(text: string, options: SpeakOptions): Promise<void> {
    const line = text.trim()
    if (!line) throw this.surface(new Error('nothing to say — empty text'))
    this.stop()
    const seq = ++this.speakSeq
    this._debugVisemePeak = 0
    try {
      if (options.engine === 'system') await this.speakSystem(line, options.voice)
      else if (options.engine === 'kokoro') await this.speakKokoro(line, options.voice, seq)
      else if (options.engine === 'elevenlabs') await this.speakElevenLabs(line, options.voice, options.apiKey, seq)
      else throw new Error(`unknown voice engine: ${String(options.engine)}`)
    } catch (error) {
      throw this.surface(error)
    }
  }

  /** List selectable voices for an engine. List failures are surfaced to status, never thrown. */
  async listVoices(engine: VoiceEngine, apiKey?: string): Promise<VoiceOption[]> {
    if (engine === 'system') return this.listSystemVoices()
    if (engine === 'kokoro') return KOKORO_VOICES
    return this.listElevenVoices(apiKey)
  }

  /** Stop speech from any engine and return the mouth to the analyser. */
  stop(): void {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    this.systemDriver?.stop()
    this.systemDriver = null
    this.elevenAbort?.abort()
    this.elevenAbort = null
    this.host.stopSpeaking()
  }

  // ----- system (speechSynthesis) ------------------------------------------

  private async speakSystem(text: string, voiceUri?: string): Promise<void> {
    if (!('speechSynthesis' in window)) {
      throw new Error('system speech synthesis is not available in this browser — try Kokoro')
    }
    const utterance = new SpeechSynthesisUtterance(text)
    if (voiceUri) {
      const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceUri)
      if (voice) utterance.voice = voice
    }
    this.status('speaking…')
    await new Promise<void>((resolve) => {
      const driver = new SystemVisemeDriver(
        (weights) => this.applyVisemes(weights),
        () => {
          if (this.systemDriver === driver) this.systemDriver = null
          this.status('speech finished')
          resolve()
        },
      )
      this.systemDriver = driver
      utterance.onstart = () => driver.markSpeechStarted()
      utterance.onboundary = (event) => driver.onBoundary(event.charIndex)
      utterance.onend = () => driver.stop()
      utterance.onerror = (event) => {
        if (event.error !== 'canceled' && event.error !== 'interrupted') {
          this.status(`system voice error: ${event.error}`)
        }
        driver.stop()
      }
      driver.start(text)
      window.speechSynthesis.speak(utterance)
    })
  }

  private applyVisemes(weights: VisemeWeights | null): void {
    this.host.setVisemes(weights)
    this._debugCurrentWeights = weights
    if (weights) {
      for (const value of Object.values(weights)) {
        if (typeof value === 'number' && value > this._debugVisemePeak) this._debugVisemePeak = value
      }
    }
  }

  private listSystemVoices(): Promise<VoiceOption[]> {
    if (!('speechSynthesis' in window)) return Promise.resolve([])
    const toOptions = (voices: SpeechSynthesisVoice[]): VoiceOption[] =>
      voices.map((v) => ({ id: v.voiceURI, label: `${v.name} (${v.lang})` }))
    const now = window.speechSynthesis.getVoices()
    if (now.length > 0) return Promise.resolve(toOptions(now))
    // Chrome populates the list asynchronously — wait for voiceschanged, bounded.
    return new Promise((resolve) => {
      const settle = () => {
        window.clearTimeout(timeout)
        window.speechSynthesis.removeEventListener('voiceschanged', settle)
        resolve(toOptions(window.speechSynthesis.getVoices()))
      }
      const timeout = window.setTimeout(settle, 1500)
      window.speechSynthesis.addEventListener('voiceschanged', settle)
    })
  }

  // ----- kokoro (in-browser neural TTS) ------------------------------------

  private async speakKokoro(text: string, voice: string | undefined, seq: number): Promise<void> {
    const voiceId = voice ?? 'af_heart' // documented engine default, not a masked failure
    if (!KOKORO_VOICES.some((v) => v.id === voiceId)) {
      throw new Error(`unknown kokoro voice: ${voiceId}`)
    }
    const tts = await this.getKokoro()
    if (seq !== this.speakSeq) return // superseded while the model loaded
    this.status('kokoro: generating…')
    const audio = await tts.generate(text, { voice: voiceId as GenerateOptions['voice'] })
    if (seq !== this.speakSeq) return
    const wav = audio.toWav()
    const blob = new Blob([wav], { type: 'audio/wav' })
    await this.host.speak(blob)
  }

  private getKokoro(): Promise<KokoroTTS> {
    if (!this.kokoroPromise) {
      this.kokoroPromise = this.loadKokoro().catch((error: unknown) => {
        this.kokoroPromise = null // a failed download must be retryable
        throw error
      })
    }
    return this.kokoroPromise
  }

  private async loadKokoro(): Promise<KokoroTTS> {
    this.status('kokoro: loading engine…')
    const { KokoroTTS: Kokoro } = await import('kokoro-js')
    const hasWebGpu = 'gpu' in navigator && Boolean((navigator as { gpu?: unknown }).gpu)
    const device = hasWebGpu ? 'webgpu' : 'wasm'
    const dtype = hasWebGpu ? 'fp32' : 'q8'
    this.status(`kokoro: preparing model (${device}) — first run downloads ~90 MB, then it's cached…`)
    return Kokoro.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      device,
      dtype,
      progress_callback: (info: { status: string; file?: string; progress?: number }) => {
        if (info.status === 'progress' && typeof info.progress === 'number') {
          this.status(`kokoro: downloading model ${info.progress.toFixed(0)}%…`)
        } else if (info.status === 'ready') {
          this.status('kokoro: model ready')
        }
      },
    })
  }

  // ----- elevenlabs (premium, user key) ------------------------------------

  private async speakElevenLabs(
    text: string,
    voice: string | undefined,
    apiKey: string | undefined,
    seq: number,
  ): Promise<void> {
    const key = apiKey?.trim()
    if (!key) throw new Error('ElevenLabs needs an API key — paste yours in the key field')
    const voiceId = voice ?? ELEVEN_DEFAULT_VOICE.id // documented engine default
    this.status('elevenlabs: generating…')
    this.elevenAbort = new AbortController()
    const response = await fetch(
      `${ELEVEN_API}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
        signal: this.elevenAbort.signal,
      },
    )
    if (response.status === 401) throw new Error('ElevenLabs rejected the API key (401) — check the key')
    if (response.status === 429) throw new Error('ElevenLabs quota exceeded (429) — the account is out of characters')
    if (!response.ok) throw new Error(`ElevenLabs request failed (${response.status})`)
    const blob = await response.blob()
    if (seq !== this.speakSeq) return
    await this.host.speak(blob)
  }

  private async listElevenVoices(apiKey?: string): Promise<VoiceOption[]> {
    const key = apiKey?.trim()
    if (!key) return [ELEVEN_DEFAULT_VOICE]
    try {
      const response = await fetch(`${ELEVEN_API}/v1/voices`, { headers: { 'xi-api-key': key } })
      if (response.status === 401) {
        this.status('ElevenLabs rejected the API key (401) — showing the default voice')
        return [ELEVEN_DEFAULT_VOICE]
      }
      if (!response.ok) {
        this.status(`ElevenLabs voice list failed (${response.status}) — showing the default voice`)
        return [ELEVEN_DEFAULT_VOICE]
      }
      const data = (await response.json()) as { voices?: Array<{ voice_id: string; name: string; category?: string }> }
      const voices = (data.voices ?? []).map((v) => ({
        id: v.voice_id,
        label: v.category ? `${v.name} · ${v.category}` : v.name,
      }))
      return voices.length > 0 ? voices : [ELEVEN_DEFAULT_VOICE]
    } catch {
      this.status('ElevenLabs unreachable — check the network; showing the default voice')
      return [ELEVEN_DEFAULT_VOICE]
    }
  }

  private surface(error: unknown): Error {
    const err = error instanceof Error ? error : new Error(String(error))
    this.status(err.message)
    return err
  }
}

// ---------------------------------------------------------------------------
// VoiceCommands — "its own voice control". Continuous SpeechRecognition parses
// final transcripts against a small grammar and emits structured actions.
// ---------------------------------------------------------------------------

export type VoiceCommandAction =
  | { type: 'wave' }
  | { type: 'point' }
  | { type: 'point-at'; x: number; y: number }
  | { type: 'thumbs-up' }
  | { type: 'scold' }
  | { type: 'yell' }
  | { type: 'look'; yaw: number; pitch: number }
  | { type: 'emotion'; name: 'happy' | 'angry' | 'sad' | 'relaxed' | 'neutral' }
  | { type: 'background'; mode: 'matrix' | 'transparent' }
  | { type: 'say'; text: string }
  | { type: 'stop-listening' }

/** Parse one final transcript. Returns null when nothing in the grammar matched. */
export function parseVoiceCommand(transcript: string): VoiceCommandAction | null {
  const text = transcript.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null

  if (/\bstop listening\b/.test(text)) return { type: 'stop-listening' }

  const say = /^(?:please )?(?:say|repeat after me)\s+(.+)$/.exec(text)
  if (say) return { type: 'say', text: say[1] }

  if (/\blook at me\b/.test(text)) return { type: 'look', yaw: 0, pitch: 0 }
  const look = /\blook (?:to the )?(left|right|up|down)\b/.exec(text)
  if (look) {
    if (look[1] === 'left') return { type: 'look', yaw: -35, pitch: 0 }
    if (look[1] === 'right') return { type: 'look', yaw: 35, pitch: 0 }
    if (look[1] === 'up') return { type: 'look', yaw: 0, pitch: 20 }
    return { type: 'look', yaw: 0, pitch: -20 }
  }

  if (/\bwave\b/.test(text)) return { type: 'wave' }
  if (/\bthumbs? up\b/.test(text)) return { type: 'thumbs-up' }
  const corner = /\bpoint (?:to |at )?(?:the )?(top|bottom) (left|right)\b/.exec(text)
  if (corner) {
    return {
      type: 'point-at',
      x: corner[2] === 'right' ? 0.9 : 0.1,
      y: corner[1] === 'top' ? 0.12 : 0.85,
    }
  }
  if (/\bpoint at me\b|\bpoint (?:at|to) the camera\b/.test(text)) return { type: 'point-at', x: 0.5, y: 0.5 }
  if (/\bpoint\b/.test(text)) return { type: 'point' }
  if (/\bscold\b/.test(text)) return { type: 'scold' }
  if (/\byell\b/.test(text)) return { type: 'yell' }

  const emotion = /\b(?:be |feel )?(happy|angry|sad|relaxed|neutral)\b/.exec(text)
  if (emotion) return { type: 'emotion', name: emotion[1] as 'happy' | 'angry' | 'sad' | 'relaxed' | 'neutral' }

  if (/\b(?:green screen|transparent)\b/.test(text)) return { type: 'background', mode: 'transparent' }
  if (/\b(?:matrix|background)\b/.test(text)) return { type: 'background', mode: 'matrix' }

  return null
}

// SpeechRecognition is not in TypeScript's DOM lib (only its Result types are),
// so declare the minimal surface we use.
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

export interface VoiceCommandsOptions {
  onAction: (action: VoiceCommandAction) => void
  onStatus: (message: string) => void
  /** Fired whenever listening genuinely starts or stops (incl. self-stop on "stop listening" / mic denial). */
  onStateChange?: (active: boolean) => void
}

export class VoiceCommands {
  private recognition: SpeechRecognitionLike | null = null
  private activeFlag = false
  private restartTimer = 0

  constructor(private readonly options: VoiceCommandsOptions) {}

  get supported(): boolean {
    return Boolean(this.ctor())
  }

  get active(): boolean {
    return this.activeFlag
  }

  start(): void {
    if (this.activeFlag) return
    const Ctor = this.ctor()
    if (!Ctor) {
      this.options.onStatus('voice control needs Chrome/Edge (SpeechRecognition API unavailable here)')
      return
    }
    const recognition = new Ctor()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        if (result.isFinal) this.handleTranscript(result[0].transcript)
      }
    }
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.options.onStatus('voice control: microphone permission denied')
        this.stop()
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        this.options.onStatus(`voice control error: ${event.error}`)
      }
    }
    recognition.onend = () => {
      // Chrome ends recognition after silence — restart while we're meant to listen.
      if (!this.activeFlag) return
      this.restartTimer = window.setTimeout(() => {
        if (!this.activeFlag || !this.recognition) return
        try {
          this.recognition.start()
        } catch {
          // already restarting — the next onend cycle picks it up
        }
      }, 250)
    }
    this.recognition = recognition
    this.activeFlag = true
    try {
      recognition.start()
      this.options.onStatus('voice control: listening — try “wave”, “look left”, “say hello”, “stop listening”')
      this.options.onStateChange?.(true)
    } catch (error) {
      this.activeFlag = false
      this.recognition = null
      this.options.onStatus(`voice control failed to start: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  stop(): void {
    if (!this.activeFlag && !this.recognition) return
    this.activeFlag = false
    window.clearTimeout(this.restartTimer)
    const recognition = this.recognition
    this.recognition = null
    if (recognition) {
      recognition.onresult = null
      recognition.onend = null
      recognition.onerror = null
      try {
        recognition.abort()
      } catch {
        // already stopped — nothing to abort
      }
    }
    this.options.onStatus('voice control: off')
    this.options.onStateChange?.(false)
  }

  private handleTranscript(transcript: string): void {
    const action = parseVoiceCommand(transcript)
    if (!action) {
      this.options.onStatus(`heard: ${transcript.trim()}`)
      return
    }
    if (action.type === 'stop-listening') {
      this.stop()
      return
    }
    this.options.onAction(action)
  }

  private ctor(): SpeechRecognitionCtor | null {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor
      webkitSpeechRecognition?: SpeechRecognitionCtor
    }
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
  }
}
