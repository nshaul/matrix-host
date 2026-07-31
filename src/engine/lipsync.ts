/**
 * Audio → viseme weights, provider-agnostic: attach ANY audio source — an
 * HTMLAudioElement playing an ElevenLabs (or any TTS) clip, a mic MediaStream,
 * or a WebAudio node — and read smoothed VRM viseme weights every frame.
 *
 * Heuristic mapping: RMS energy opens the mouth; spectral centroid picks the
 * vowel shape (low → rounded ou/oh, high → spread ih/ee, middle → open aa).
 */

type VisemeWeights = { aa: number; ih: number; ou: number; ee: number; oh: number }

const ATTACK = 0.045
const RELEASE = 0.14

function smooth(current: number, target: number, dt: number): number {
  const tau = target > current ? ATTACK : RELEASE
  return target + (current - target) * Math.exp(-dt / tau)
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export class LipSync {
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private sourceNode: AudioNode | null = null
  private timeDomain: Float32Array<ArrayBuffer> = new Float32Array(0)
  private frequency: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  private readonly weights: VisemeWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }
  private readonly elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()

  private ensureContext(): AudioContext {
    if (!this.context) this.context = new AudioContext()
    if (this.context.state === 'suspended') void this.context.resume()
    return this.context
  }

  private wire(node: AudioNode, toSpeakers: boolean) {
    const context = this.ensureContext()
    this.analyser?.disconnect()
    this.sourceNode?.disconnect()
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    node.connect(analyser)
    if (toSpeakers) analyser.connect(context.destination)
    this.analyser = analyser
    this.sourceNode = node
    this.timeDomain = new Float32Array(analyser.fftSize)
    this.frequency = new Uint8Array(analyser.frequencyBinCount)
  }

  /** Play + analyse a media element (ElevenLabs audio lands here). */
  attachElement(element: HTMLMediaElement): void {
    const context = this.ensureContext()
    let source = this.elementSources.get(element)
    if (!source) {
      source = context.createMediaElementSource(element)
      this.elementSources.set(element, source)
    }
    this.wire(source, true)
  }

  /** Analyse a live MediaStream (mic). Not routed to speakers — no feedback loop. */
  attachStream(stream: MediaStream): void {
    this.wire(this.ensureContext().createMediaStreamSource(stream), false)
  }

  /** Analyse any WebAudio node (procedural/demo speech). */
  attachNode(node: AudioNode, toSpeakers = true): void {
    this.wire(node, toSpeakers)
  }

  detach(): void {
    this.analyser?.disconnect()
    this.sourceNode?.disconnect()
    this.analyser = null
    this.sourceNode = null
  }

  dispose(): void {
    this.detach()
    void this.context?.close()
    this.context = null
  }

  /** Advance smoothing and return the current viseme weights (all 0 when silent). */
  update(dt: number): VisemeWeights {
    let open = 0
    let bright = 0
    let round = 0

    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.timeDomain)
      this.analyser.getByteFrequencyData(this.frequency)

      let sum = 0
      for (let i = 0; i < this.timeDomain.length; i += 1) sum += this.timeDomain[i] * this.timeDomain[i]
      const energy = clamp01(Math.sqrt(sum / this.timeDomain.length) * 7)

      const { sampleRate } = this.analyser.context
      const hzPerBin = sampleRate / this.analyser.fftSize
      const ceiling = Math.min(this.frequency.length - 1, Math.ceil(4000 / hzPerBin))
      let weighted = 0
      let total = 0
      for (let i = 0; i <= ceiling; i += 1) {
        weighted += i * hzPerBin * this.frequency[i]
        total += this.frequency[i]
      }
      const centroid = total > 0 ? clamp01(weighted / total / 4000) : 0

      open = energy
      bright = clamp01((centroid - 0.34) * 3.2)
      round = clamp01((0.3 - centroid) * 3.2)
    }

    const target: VisemeWeights = {
      aa: open * (1 - bright) * (1 - round),
      ih: open * bright * 0.65,
      ee: open * bright * 0.35,
      ou: open * round * 0.6,
      oh: open * round * 0.45,
    }
    this.weights.aa = smooth(this.weights.aa, target.aa, dt)
    this.weights.ih = smooth(this.weights.ih, target.ih, dt)
    this.weights.ee = smooth(this.weights.ee, target.ee, dt)
    this.weights.ou = smooth(this.weights.ou, target.ou, dt)
    this.weights.oh = smooth(this.weights.oh, target.oh, dt)
    return this.weights
  }

  /**
   * Demo speech with no external TTS: vowel-formant bursts through the analyser.
   * Proves the whole talk path (audio → visemes → mouth) without any API key.
   */
  speakDemo(durationSeconds = 3): void {
    const context = this.ensureContext()
    const master = context.createGain()
    master.gain.value = 0
    const carrier = context.createOscillator()
    carrier.type = 'sawtooth'
    carrier.frequency.value = 145
    const formant = context.createBiquadFilter()
    formant.type = 'bandpass'
    formant.Q.value = 5
    carrier.connect(formant)
    formant.connect(master)
    this.attachNode(master, true)

    const now = context.currentTime
    const vowels = [700, 300, 900, 400, 750, 320, 850, 500, 700, 350]
    const syllable = durationSeconds / vowels.length
    vowels.forEach((hz, i) => {
      const t = now + i * syllable
      formant.frequency.setValueAtTime(hz, t)
      master.gain.setValueAtTime(0.0001, t)
      master.gain.exponentialRampToValueAtTime(0.5, t + syllable * 0.25)
      master.gain.exponentialRampToValueAtTime(0.0001, t + syllable * 0.9)
      carrier.frequency.setValueAtTime(125 + (i % 3) * 22, t)
    })
    carrier.start(now)
    carrier.stop(now + durationSeconds + 0.1)
    carrier.onended = () => {
      master.disconnect()
    }
  }
}
