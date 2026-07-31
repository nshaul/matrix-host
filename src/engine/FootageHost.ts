import { LipSync } from './lipsync'
import { GLYPHS, GLYPH_COUNT } from './glyphTexture'

/**
 * The Living Footage Engine: AI-video-grade pixels, directed live.
 *
 * The source video IS the quality — this engine makes it an interactive host:
 * a segment state machine (idle loops seamlessly, gestures crossfade in and
 * out on command), a live matrix layer (glyph churn, rain, film grade) so the
 * frame is never a static movie, a per-segment mouth-warp driven by real audio
 * so she talks, and a luma-key matte for true-alpha OBS overlay.
 *
 * One WebGL pass does everything: two video textures (double-buffered for
 * seamless crossfades), glyph atlas, warp, key, grade — 60 fps on any GPU.
 */

/** Facial anchors at one timestamp of the footage (video UV, y down). */
export type AnchorKeyframe = {
  t: number
  mouth?: [number, number]
  eyeL?: [number, number]
  eyeR?: [number, number]
}

export type FootageSegment = {
  name: string
  start: number
  end: number
  /**
   * Keyframed facial anchors — the face drifts through a segment, so anchors
   * are tracks, lerped by playback time. Warps only fire where anchors exist.
   */
  track?: AnchorKeyframe[]
  mouthR?: number
  eyeR?: number
}

export type FootageBackgroundMode = 'scene' | 'transparent'

const CROSSFADE_SECONDS = 0.45

/** Lerp a segment's facial-anchor track at a playback time. */
function anchorsAt(
  segment: FootageSegment,
  time: number,
): { mouth?: [number, number]; eyeL?: [number, number]; eyeR?: [number, number] } {
  const track = segment.track
  if (!track || track.length === 0) return {}
  let before = track[0]
  let after = track[track.length - 1]
  for (const key of track) {
    if (key.t <= time) before = key
    if (key.t >= time) {
      after = key
      break
    }
  }
  const span = after.t - before.t
  const mix = span > 0 ? Math.min(1, Math.max(0, (time - before.t) / span)) : 0
  const lerpPair = (a?: [number, number], b?: [number, number]): [number, number] | undefined =>
    a && b ? [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix] : (a ?? b)
  return {
    mouth: lerpPair(before.mouth, after.mouth),
    eyeL: lerpPair(before.eyeL, after.eyeL),
    eyeR: lerpPair(before.eyeR, after.eyeR),
  }
}

const VERTEX = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

const FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVideoA;
uniform sampler2D uVideoB;
uniform sampler2D uGlyphs;
uniform float uFade;        // 0 = A, 1 = B
uniform float uTime;
uniform float uJaw;         // 0..1 mouth-open from live audio
uniform float uBlink;       // 0..1 eyelids closed
uniform vec3 uMouthA;       // xy = uv center, z = radius (0 disables)
uniform vec3 uMouthB;
uniform vec3 uEyeLA;        // per-slot eye anchors, z = radius (0 disables)
uniform vec3 uEyeRA;
uniform vec3 uEyeLB;
uniform vec3 uEyeRB;
uniform float uTransparent; // 1 = luma-key alpha out
uniform vec4 uContentBox;   // x,y = offset, z,w = scale of contain-fit
uniform float uGlyphCount;
uniform float uCanvasHeight;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// Jaw-open warp: inside the mouth ellipse, pixels below the lip line sample
// from above, stretching the mouth open downward.
vec2 mouthWarp(vec2 uv, vec3 mouth, float jaw) {
  if (mouth.z <= 0.0 || jaw <= 0.001) return uv;
  vec2 d = (uv - mouth.xy) / mouth.z;
  d.y *= 0.72; // ellipse
  float falloff = smoothstep(1.0, 0.15, length(d));
  float below = smoothstep(-0.15, 0.6, (uv.y - mouth.xy.y) / mouth.z);
  uv.y -= jaw * falloff * below * mouth.z * 0.55;
  return uv;
}

// Blink warp: inside the eye ellipse, pixels collapse toward the upper-lid
// line, so the lid skin sweeps down over the iris.
vec2 blinkWarp(vec2 uv, vec3 eye, float blink) {
  if (eye.z <= 0.0 || blink <= 0.001) return uv;
  vec2 d = (uv - eye.xy) / eye.z;
  d.y *= 1.4;
  float falloff = smoothstep(1.0, 0.2, length(d));
  float lidLine = eye.y - eye.z * 0.42;
  uv.y = mix(uv.y, lidLine, blink * falloff * 0.85);
  return uv;
}

vec2 toVideoUv(vec2 uv) {
  return (uv - uContentBox.xy) / uContentBox.zw;
}

void main() {
  vec2 uv = toVideoUv(vUv);
  float inFrame = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec2 uvClamped = clamp(uv, 0.0, 1.0);

  vec2 uvA = blinkWarp(blinkWarp(mouthWarp(uvClamped, uMouthA, uJaw), uEyeLA, uBlink), uEyeRA, uBlink);
  vec2 uvB = blinkWarp(blinkWarp(mouthWarp(uvClamped, uMouthB, uJaw), uEyeLB, uBlink), uEyeRB, uBlink);
  vec3 vidA = texture2D(uVideoA, uvA).rgb;
  vec3 vidB = texture2D(uVideoB, uvB).rgb;
  vec3 video = mix(vidA, vidB, uFade) * inFrame;
  float luma = dot(video, vec3(0.299, 0.587, 0.114));

  vec3 color = video;

  // Live glyph shimmer: a churning code grid breathing over the figure, so the
  // frame is alive even when the footage rests.
  float cellPx = 9.0;
  vec2 cellCoord = gl_FragCoord.xy / cellPx;
  vec2 cell = floor(cellCoord);
  float churnTick = floor(uTime * (0.8 + 1.6 * hash(cell)));
  float glyphIdx = floor(hash(cell + churnTick * 0.13) * uGlyphCount);
  vec2 cellLocal = fract(cellCoord);
  float glyph = texture2D(uGlyphs, vec2((glyphIdx + cellLocal.x) / uGlyphCount, 1.0 - cellLocal.y)).a;
  color += vec3(0.35, 1.0, 0.55) * glyph * smoothstep(0.16, 0.75, luma) * 0.12;

  // Live front rain: sparse bright streams falling over everything.
  float col = floor(gl_FragCoord.x / 14.0);
  float colSeed = hash(vec2(col, 3.7));
  if (colSeed < 0.16) {
    float y = gl_FragCoord.y / uCanvasHeight;
    float flow = fract(1.0 - y + uTime * (0.08 + colSeed * 0.3) + colSeed * 7.0);
    float trail = pow(flow, 5.5);
    float rGlyphIdx = floor(hash(vec2(col, floor(gl_FragCoord.y / 14.0))) * uGlyphCount);
    vec2 rLocal = vec2(fract(gl_FragCoord.x / 14.0), fract(gl_FragCoord.y / 14.0));
    float rGlyph = texture2D(uGlyphs, vec2((rGlyphIdx + rLocal.x) / uGlyphCount, 1.0 - rLocal.y)).a;
    color += vec3(0.5, 1.0, 0.68) * rGlyph * trail * 0.3;
  }

  // Film grade: gentle green lift in the mids, grain, vignette.
  color = mix(color, color * vec3(0.92, 1.06, 0.96), 0.5);
  float grain = hash(gl_FragCoord.xy + fract(uTime) * 713.0) - 0.5;
  color += grain * 0.03;
  float d = distance(vUv, vec2(0.5));
  color *= 1.0 - smoothstep(0.42, 0.95, d) * 0.42;

  // Luma-key band is per-footage calibration: this reference has bright rain in
  // its own background, so the key sits high; clean-backdrop footage keys low.
  float alpha = uTransparent > 0.5 ? smoothstep(0.3, 0.52, luma) * inFrame : 1.0;
  gl_FragColor = vec4(color * (uTransparent > 0.5 ? alpha : 1.0), alpha);
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('shader alloc failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader) ?? 'unknown'}`)
  }
  return shader
}

function createVideo(src: string): HTMLVideoElement {
  const video = document.createElement('video')
  video.src = src
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  return video
}

export class FootageHost {
  readonly canvas: HTMLCanvasElement
  private readonly gl: WebGLRenderingContext
  private readonly videos: [HTMLVideoElement, HTMLVideoElement]
  private readonly textures: [WebGLTexture, WebGLTexture]
  private readonly glyphTexture: WebGLTexture
  private readonly uniforms = new Map<string, WebGLUniformLocation>()
  private readonly lipSync = new LipSync()
  private readonly segments: Map<string, FootageSegment>
  private readonly idleName: string

  private active = 0 // index of the video currently on screen
  private fade = 0 // 0 = videos[active] fully visible... interpreted at draw
  private fadeTarget = 0
  private currentSegment: FootageSegment
  private queuedSegment: FootageSegment | null = null
  private backgroundMode: FootageBackgroundMode = 'scene'
  private animationFrame = 0
  private disposed = false
  private lastNow = 0
  private jaw = 0
  private blink = 0
  private nextBlinkAt = 2.5
  private blinkStartedAt = -1
  private homeName: string
  private speakingAudio: HTMLAudioElement | null = null
  private speakingUrl: string | null = null
  private statusHandler: (message: string) => void = () => {}

  constructor(
    private readonly container: HTMLElement,
    videoSrc: string,
    segments: FootageSegment[],
    idleName: string,
  ) {
    this.segments = new Map(segments.map((s) => [s.name, s]))
    const idle = this.segments.get(idleName)
    if (!idle) throw new Error(`idle segment "${idleName}" missing`)
    this.idleName = idleName
    this.homeName = idleName
    this.currentSegment = idle

    this.canvas = document.createElement('canvas')
    container.appendChild(this.canvas)
    const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true })
    if (!gl) throw new Error('WebGL unavailable')
    this.gl = gl

    const program = gl.createProgram()
    if (!program) throw new Error('program alloc failed')
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program) ?? 'unknown'}`)
    }
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPosition = gl.getAttribLocation(program, 'aPosition')
    gl.enableVertexAttribArray(aPosition)
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)

    for (const name of [
      'uVideoA',
      'uVideoB',
      'uGlyphs',
      'uFade',
      'uTime',
      'uJaw',
      'uBlink',
      'uMouthA',
      'uMouthB',
      'uEyeLA',
      'uEyeRA',
      'uEyeLB',
      'uEyeRB',
      'uTransparent',
      'uContentBox',
      'uGlyphCount',
      'uCanvasHeight',
    ]) {
      const location = gl.getUniformLocation(program, name)
      if (location) this.uniforms.set(name, location)
    }

    this.videos = [createVideo(videoSrc), createVideo(videoSrc)]
    this.textures = [this.createVideoTexture(), this.createVideoTexture()]
    this.glyphTexture = this.createGlyphTexture()

    gl.uniform1i(this.uniforms.get('uVideoA') ?? null, 0)
    gl.uniform1i(this.uniforms.get('uVideoB') ?? null, 1)
    gl.uniform1i(this.uniforms.get('uGlyphs') ?? null, 2)
    gl.uniform1f(this.uniforms.get('uGlyphCount') ?? null, GLYPH_COUNT)

    this.resize()
    new ResizeObserver(() => this.resize()).observe(container)

    void this.boot()
    this.animationFrame = requestAnimationFrame(this.tick)
  }

  onStatus(handler: (message: string) => void): void {
    this.statusHandler = handler
  }

  private async boot(): Promise<void> {
    const [a] = this.videos
    await new Promise<void>((resolve) => {
      if (a.readyState >= 2) resolve()
      else a.addEventListener('loadeddata', () => resolve(), { once: true })
    })
    a.currentTime = this.currentSegment.start
    await a.play()
    this.statusHandler(`footage live — segment "${this.currentSegment.name}"`)
  }

  /** Command a gesture segment; it plays once, then crossfades home. */
  playSegment(name: string): void {
    const segment = this.segments.get(name)
    if (!segment || segment.name === this.currentSegment.name) return
    this.queuedSegment = segment
  }

  /** Make a segment the looping home (eye contact while presenting/speaking). */
  holdSegment(name: string): void {
    if (this.segments.has(name)) {
      this.homeName = name
      this.playSegment(name)
    }
  }

  /** Return home to the resting idle loop. */
  release(): void {
    this.homeName = this.idleName
    this.playSegment(this.idleName)
  }

  /** Blink now (a natural clock also blinks on its own during eyes-open segments). */
  blinkNow(): void {
    this.blinkStartedAt = this.lastNow / 1000
  }

  segmentNames(): string[] {
    return [...this.segments.keys()]
  }

  setBackground(mode: FootageBackgroundMode): void {
    this.backgroundMode = mode
  }

  async speak(source: string | Blob | MediaStream): Promise<void> {
    this.stopSpeaking()
    this.holdSegment('look') // eye contact while talking
    if (source instanceof MediaStream) {
      this.lipSync.attachStream(source)
      this.statusHandler('lip-sync: live stream')
      return
    }
    const url = typeof source === 'string' ? source : URL.createObjectURL(source)
    if (typeof source !== 'string') this.speakingUrl = url
    const audio = new Audio()
    audio.crossOrigin = 'anonymous'
    audio.src = url
    this.speakingAudio = audio
    this.lipSync.attachElement(audio)
    audio.onended = () => {
      this.release()
      this.statusHandler('speech finished')
    }
    await audio.play()
    this.statusHandler('speaking…')
  }

  speakDemo(): void {
    this.stopSpeaking()
    this.holdSegment('look')
    this.lipSync.speakDemo()
    setTimeout(() => this.release(), 3600)
    this.statusHandler('demo speech')
  }

  stopSpeaking(): void {
    this.speakingAudio?.pause()
    this.speakingAudio = null
    if (this.speakingUrl) {
      URL.revokeObjectURL(this.speakingUrl)
      this.speakingUrl = null
    }
  }

  record(seconds: number): Promise<Blob> {
    const stream = this.canvas.captureStream(60)
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    )
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 12_000_000 } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    return new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }))
      recorder.start()
      setTimeout(() => recorder.stop(), seconds * 1000)
    })
  }

  private createVideoTexture(): WebGLTexture {
    const gl = this.gl
    const texture = gl.createTexture()
    if (!texture) throw new Error('texture alloc failed')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return texture
  }

  private createGlyphTexture(): WebGLTexture {
    const gl = this.gl
    const canvas = document.createElement('canvas')
    const cell = 48
    canvas.width = GLYPH_COUNT * cell
    canvas.height = cell
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.font = `${Math.round(cell * 0.82)}px ui-monospace, Menlo, Consolas, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#fff'
      for (let i = 0; i < GLYPH_COUNT; i += 1) ctx.fillText(GLYPHS[i], i * cell + cell / 2, cell / 2)
    }
    const texture = gl.createTexture()
    if (!texture) throw new Error('glyph texture alloc failed')
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return texture
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) // naf-allow-fallback: undefined in headless; 1 is the spec identity
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
  }

  private uploadVideoFrame(slot: 0 | 1): void {
    const gl = this.gl
    const video = this.videos[slot]
    if (video.readyState < 2) return
    gl.activeTexture(slot === 0 ? gl.TEXTURE0 : gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.textures[slot])
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
  }

  private queuedTarget: FootageSegment | null = null

  private beginCrossfade(target: FootageSegment): void {
    const next = (1 - this.active) as 0 | 1
    const video = this.videos[next]
    video.currentTime = target.start
    void video.play()
    this.queuedTarget = target
    this.fadeTarget = 1
  }

  private readonly tick = (now: number) => {
    if (this.disposed) return
    const dt = this.lastNow ? Math.min((now - this.lastNow) / 1000, 0.05) : 0.016
    this.lastNow = now
    const gl = this.gl

    // ----- segment state machine -----
    const activeVideo = this.videos[this.active]
    if (this.queuedSegment && this.fadeTarget === 0) {
      this.beginCrossfade(this.queuedSegment)
      this.queuedSegment = null
    } else if (this.fadeTarget === 0 && activeVideo.currentTime >= this.currentSegment.end - CROSSFADE_SECONDS) {
      // Segment running out: crossfade home — the home loop (idle, or a held
      // segment like "look" while speaking) loops onto itself this way too.
      const home = this.segments.get(this.homeName)
      if (home) this.beginCrossfade(home)
    }

    if (this.fadeTarget === 1) {
      this.fade = Math.min(1, this.fade + dt / CROSSFADE_SECONDS)
      if (this.fade >= 1) {
        // Swap buffers: the faded-in segment becomes current.
        this.videos[this.active].pause()
        this.active = 1 - this.active
        this.currentSegment = this.queuedTarget ?? this.currentSegment
        this.queuedTarget = null
        this.fade = 0
        this.fadeTarget = 0
      }
    }

    // ----- audio → jaw -----
    const weights = this.lipSync.update(dt)
    this.jaw += ((weights.aa + weights.oh * 0.7 + weights.ou * 0.5) * 1.4 - this.jaw) * (1 - Math.exp(-dt / 0.06))

    // ----- blink clock: only while an eyes-open segment is on screen -----
    const seconds = now / 1000
    const hasEyes = this.currentSegment.track?.some((key) => key.eyeL || key.eyeR) ?? false
    if (hasEyes) {
      if (this.blinkStartedAt < 0 && seconds >= this.nextBlinkAt) this.blinkStartedAt = seconds
      if (this.blinkStartedAt >= 0) {
        const progress = (seconds - this.blinkStartedAt) / 0.16
        if (progress >= 1) {
          this.blink = 0
          this.blinkStartedAt = -1
          this.nextBlinkAt = seconds + 2.2 + Math.random() * 3.2
        } else {
          this.blink = Math.sin(progress * Math.PI)
        }
      }
    } else {
      this.blink = 0
      this.blinkStartedAt = -1
      this.nextBlinkAt = seconds + 1.5
    }

    // ----- draw -----
    this.uploadVideoFrame(0)
    this.uploadVideoFrame(1)

    const set1f = (name: string, value: number) => gl.uniform1f(this.uniforms.get(name) ?? null, value)
    const activeIsA = this.active === 0
    set1f('uFade', activeIsA ? this.fade : 1 - this.fade)
    set1f('uTime', now / 1000)
    set1f('uJaw', Math.min(1, this.jaw))
    set1f('uTransparent', this.backgroundMode === 'transparent' ? 1 : 0)
    set1f('uCanvasHeight', this.canvas.height)

    set1f('uBlink', this.blink)
    const segmentOf = (slot: number) =>
      slot === this.active ? this.currentSegment : (this.queuedTarget ?? this.currentSegment)
    const set3 = (name: string, x: number, y: number, z: number) =>
      gl.uniform3f(this.uniforms.get(name) ?? null, x, y, z)
    for (const slot of [0, 1] as const) {
      const segment = segmentOf(slot)
      const anchors = anchorsAt(segment, this.videos[slot].currentTime)
      const suffix = slot === 0 ? 'A' : 'B'
      set3(`uMouth${suffix}`, anchors.mouth?.[0] ?? 0, anchors.mouth?.[1] ?? 0, anchors.mouth ? (segment.mouthR ?? 0.05) : 0)
      set3(`uEyeL${suffix}`, anchors.eyeL?.[0] ?? 0, anchors.eyeL?.[1] ?? 0, anchors.eyeL ? (segment.eyeR ?? 0.04) : 0)
      set3(`uEyeR${suffix}`, anchors.eyeR?.[0] ?? 0, anchors.eyeR?.[1] ?? 0, anchors.eyeR ? (segment.eyeR ?? 0.04) : 0)
    }

    // Contain-fit the video into the canvas.
    const video = this.videos[this.active]
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw > 0 && vh > 0) {
      const scale = Math.min(this.canvas.width / vw, this.canvas.height / vh)
      const w = (vw * scale) / this.canvas.width
      const h = (vh * scale) / this.canvas.height
      gl.uniform4f(this.uniforms.get('uContentBox') ?? null, (1 - w) / 2, (1 - h) / 2, w, h)
    }

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    this.animationFrame = requestAnimationFrame(this.tick)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.animationFrame)
    this.stopSpeaking()
    this.lipSync.dispose()
    for (const video of this.videos) {
      video.pause()
      video.src = ''
    }
    for (const texture of this.textures) this.gl.deleteTexture(texture)
    this.gl.deleteTexture(this.glyphTexture)
    this.canvas.remove()
  }
}
