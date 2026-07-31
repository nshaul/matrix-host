import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { createGlyphAtlas } from './glyphTexture'
import { applyHologramToAvatar, type HologramMaterialHandle } from './hologramMaterial'
import { createAmbientGlow, createRainLayer, createSkyline, type RainLayer } from './rain'
import { GestureController } from './gestures'
import { LipSync } from './lipsync'

export type BackgroundMode = 'matrix' | 'transparent'

/** Film-print pass: fine grain + vignette. Runs after bloom, before output. */
const FilmGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.045 },
    uVignette: { value: 0.38 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uGrain;
    uniform float uVignette;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float grain = hash(vUv * vec2(1319.7, 911.3) + fract(uTime) * 713.0) - 0.5;
      color.rgb += grain * uGrain;
      float d = distance(vUv, vec2(0.5));
      color.rgb *= 1.0 - smoothstep(0.4, 0.92, d) * uVignette;
      gl_FragColor = color;
    }
  `,
}

/**
 * The living hologram host. Owns the scene, the look, the avatar, and the whole
 * control surface: swap subjects (girl/boy/any VRM/GLB), rotate the head, wave,
 * speak from any audio source, toggle a fully transparent background for OBS,
 * and record the canvas to webm.
 */
export class HologramHost {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly composer: EffectComposer
  private readonly bloom: UnrealBloomPass
  private readonly filmGrade: ShaderPass
  private readonly glyphAtlas = createGlyphAtlas()
  private readonly environment = new THREE.Group()
  private readonly rainLayers: RainLayer[] = []
  private readonly clock = new THREE.Clock()
  private readonly lipSync = new LipSync()

  private vrm: VRM | null = null
  private subjectRoot: THREE.Object3D | null = null
  private materialHandles: HologramMaterialHandle[] = []
  private gestures: GestureController | null = null
  private backgroundMode: BackgroundMode = 'matrix'
  private orbitYaw = 0
  private orbitPitch = 0
  private zoom = 1.9
  private animationFrame = 0
  private disposed = false
  private speakingAudio: HTMLAudioElement | null = null
  private speakingUrl: string | null = null
  private externalVisemes: { aa: number; ih: number; ou: number; ee: number; oh: number } | null = null
  private statusHandler: (message: string) => void = () => {}
  private fpsHandler: (fps: number) => void = () => {}
  private frameCount = 0
  private frameWindowStart = 0

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // ACES filmic: the S-curve compresses hologram highlights the way film would —
    // this is most of the difference between "game glow" and "cinema glow".
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.setClearColor(0x020804, 1)
    this.canvas = this.renderer.domElement
    container.appendChild(this.canvas)

    this.camera = new THREE.PerspectiveCamera(33, 1, 0.1, 60)

    this.environment.add(createSkyline())
    this.environment.add(createAmbientGlow())
    const rainSpecs = [
      { z: -7, width: 26, height: 15, columns: 110, cells: 90, brightness: 0.5, density: 0.85, soft: 0 },
      { z: -3.5, width: 14, height: 9, columns: 70, cells: 64, brightness: 0.7, density: 0.5, soft: 0 },
      { z: 1.4, width: 7, height: 5, columns: 26, cells: 30, brightness: 0.9, density: 0.22, soft: 1 },
    ]
    for (const spec of rainSpecs) {
      const layer = createRainLayer(this.glyphAtlas, spec)
      this.rainLayers.push(layer)
      this.environment.add(layer.mesh)
    }
    this.scene.add(this.environment)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.5, 0.8)
    this.composer.addPass(this.bloom)
    this.filmGrade = new ShaderPass(FilmGradeShader)
    this.composer.addPass(this.filmGrade)
    this.composer.addPass(new OutputPass())

    this.installOrbit()
    this.resize()
    new ResizeObserver(() => this.resize()).observe(container)
    this.animationFrame = requestAnimationFrame(this.tick)
  }

  onStatus(handler: (message: string) => void): void {
    this.statusHandler = handler
  }

  onFps(handler: (fps: number) => void): void {
    this.fpsHandler = handler
  }

  /** Load a subject: .vrm (girl/boy/anything from VRoid Studio) or plain .glb (logo, prop). */
  async loadSubject(url: string): Promise<void> {
    this.statusHandler('loading subject…')
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(url)
    const vrm = (gltf.userData.vrm as VRM | undefined) ?? null

    if (this.subjectRoot) {
      this.scene.remove(this.subjectRoot)
      if (this.vrm) VRMUtils.deepDispose(this.vrm.scene)
      else this.subjectRoot.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    }

    if (vrm) {
      VRMUtils.rotateVRM0(vrm)
      this.vrm = vrm
      this.subjectRoot = vrm.scene
      this.gestures = new GestureController(vrm)
    } else {
      this.vrm = null
      this.gestures = null
      this.subjectRoot = gltf.scene
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const size = box.getSize(new THREE.Vector3())
      const largest = Math.max(size.x, size.y, size.z, 0.001)
      const scale = 1.2 / largest
      gltf.scene.scale.setScalar(scale)
      const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale)
      gltf.scene.position.set(-center.x, 1.25 - center.y, -center.z)
    }

    this.materialHandles = applyHologramToAvatar(this.subjectRoot, this.glyphAtlas)
    this.scene.add(this.subjectRoot)
    this.statusHandler(vrm ? 'subject ready — rigged, visemes live' : 'subject ready — static mesh (no rig)')
  }

  setBackground(mode: BackgroundMode): void {
    this.backgroundMode = mode
    const transparent = mode === 'transparent'
    this.environment.visible = !transparent
    this.renderer.setClearColor(transparent ? 0x000000 : 0x020804, transparent ? 0 : 1)
    for (const handle of this.materialHandles) handle.setBoost(transparent ? 1.35 : 1)
  }

  getBackground(): BackgroundMode {
    return this.backgroundMode
  }

  setHeadLook(yawDeg: number, pitchDeg: number): void {
    this.gestures?.setHeadLook(yawDeg, pitchDeg)
  }

  wave(): void {
    this.gestures?.wave()
  }

  point(): void {
    this.gestures?.point()
  }

  /** Point + finger wag + stern face at the lens. */
  scold(): void {
    this.gestures?.scold()
  }

  /** Lean in, angry, mouth working, pointing — yelling into the camera. */
  yell(): void {
    this.gestures?.yell()
  }

  setEmotion(name: 'angry' | 'happy' | 'sad' | 'relaxed' | 'neutral', weight = 1): void {
    this.gestures?.setEmotion(name, weight)
  }

  /** Speak any audio: URL (ElevenLabs response), Blob/File, or a mic MediaStream. */
  async speak(source: string | Blob | MediaStream): Promise<void> {
    this.stopSpeaking()
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
    audio.onended = () => this.statusHandler('speech finished')
    await audio.play()
    this.statusHandler('speaking…')
  }

  speakDemo(): void {
    this.stopSpeaking()
    this.lipSync.speakDemo()
    this.statusHandler('demo speech (procedural formants)')
  }

  /**
   * Externally-driven mouth (system-voice TTS has no analysable audio stream, so
   * its driver feeds viseme weights straight in). Pass null to return control to
   * the audio analyser.
   */
  setVisemes(weights: { aa?: number; ih?: number; ou?: number; ee?: number; oh?: number } | null): void {
    this.externalVisemes = weights
      ? { aa: weights.aa ?? 0, ih: weights.ih ?? 0, ou: weights.ou ?? 0, ee: weights.ee ?? 0, oh: weights.oh ?? 0 }
      : null
  }

  stopSpeaking(): void {
    this.speakingAudio?.pause()
    this.speakingAudio = null
    if (this.speakingUrl) {
      URL.revokeObjectURL(this.speakingUrl)
      this.speakingUrl = null
    }
  }

  /** Record the canvas for N seconds → webm blob (vp9 when available). */
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

  private installOrbit(): void {
    let dragging = false
    let lastX = 0
    let lastY = 0
    this.canvas.style.touchAction = 'none'
    this.canvas.addEventListener('pointerdown', (event) => {
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
      this.canvas.setPointerCapture(event.pointerId)
    })
    this.canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return
      this.orbitYaw -= (event.clientX - lastX) * 0.005
      this.orbitPitch = Math.min(0.5, Math.max(-0.35, this.orbitPitch + (event.clientY - lastY) * 0.003))
      lastX = event.clientX
      lastY = event.clientY
    })
    const stop = () => {
      dragging = false
    }
    this.canvas.addEventListener('pointerup', stop)
    this.canvas.addEventListener('pointercancel', stop)
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        this.zoom = Math.min(5, Math.max(1.2, this.zoom + event.deltaY * 0.002))
      },
      { passive: false },
    )
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    const dpr = Math.min(window.devicePixelRatio || 1, 2) // naf-allow-fallback: devicePixelRatio is undefined in headless/embedded contexts; 1 is the spec's CSS-pixel identity, not a masked failure
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(width, height, false)
    this.composer.setSize(width, height)
    this.bloom.resolution.set(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    for (const handle of this.materialHandles) handle.setCellPx(9 * dpr)
  }

  private readonly tick = () => {
    if (this.disposed) return
    const dt = Math.min(this.clock.getDelta(), 0.05)
    const elapsed = this.clock.elapsedTime

    // Slow cinematic dolly drift on top of user orbit.
    const driftYaw = Math.sin(elapsed * 0.1) * 0.045
    const driftZoom = 1 + Math.sin(elapsed * 0.067) * 0.02
    const yaw = this.orbitYaw + driftYaw
    const zoom = this.zoom * driftZoom
    const focus = new THREE.Vector3(0, 1.32, 0)
    this.camera.position.set(
      focus.x + Math.sin(yaw) * Math.cos(this.orbitPitch) * zoom,
      focus.y + Math.sin(this.orbitPitch) * zoom * 0.6 + 0.06,
      focus.z + Math.cos(yaw) * Math.cos(this.orbitPitch) * zoom,
    )
    this.camera.lookAt(focus)

    this.gestures?.update(dt)

    const weights = this.externalVisemes ?? this.lipSync.update(dt)
    if (this.externalVisemes) this.lipSync.update(dt) // keep analyser smoothing warm
    const expressions = this.vrm?.expressionManager
    if (expressions) {
      // Gestures may demand the mouth too (yelling) — loudest wins.
      expressions.setValue('aa', Math.max(weights.aa, this.gestures?.mouthOpen ?? 0))
      expressions.setValue('ih', weights.ih)
      expressions.setValue('ee', weights.ee)
      expressions.setValue('ou', weights.ou)
      expressions.setValue('oh', weights.oh)
    }

    this.vrm?.update(dt)

    for (const handle of this.materialHandles) handle.setTime(elapsed)
    for (const layer of this.rainLayers) layer.update(elapsed)
    this.filmGrade.uniforms.uTime.value = elapsed

    if (this.backgroundMode === 'matrix') this.composer.render()
    else this.renderer.render(this.scene, this.camera)

    this.frameCount += 1
    if (elapsed - this.frameWindowStart >= 1) {
      this.fpsHandler(Math.round(this.frameCount / (elapsed - this.frameWindowStart)))
      this.frameCount = 0
      this.frameWindowStart = elapsed
    }

    this.animationFrame = requestAnimationFrame(this.tick)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.animationFrame)
    this.stopSpeaking()
    this.lipSync.dispose()
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene)
    this.renderer.dispose()
    this.canvas.remove()
  }
}
