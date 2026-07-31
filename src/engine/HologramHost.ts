import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { createGlyphAtlas } from './glyphTexture'
import { applyHologramToAvatar, type HologramMaterialHandle } from './hologramMaterial'
import { createAmbientGlow, createRainLayer, createSkyline, type RainLayer } from './rain'
import { GestureController } from './gestures'
import { LipSync } from './lipsync'

export type BackgroundMode = 'matrix' | 'transparent'

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
  private statusHandler: (message: string) => void = () => {}
  private fpsHandler: (fps: number) => void = () => {}
  private frameCount = 0
  private frameWindowStart = 0

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.45, 0.72)
    this.composer.addPass(this.bloom)
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

    const focus = new THREE.Vector3(0, 1.32, 0)
    this.camera.position.set(
      focus.x + Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * this.zoom,
      focus.y + Math.sin(this.orbitPitch) * this.zoom * 0.6 + 0.06,
      focus.z + Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * this.zoom,
    )
    this.camera.lookAt(focus)

    this.gestures?.update(dt)

    const weights = this.lipSync.update(dt)
    const expressions = this.vrm?.expressionManager
    if (expressions) {
      expressions.setValue('aa', weights.aa)
      expressions.setValue('ih', weights.ih)
      expressions.setValue('ee', weights.ee)
      expressions.setValue('ou', weights.ou)
      expressions.setValue('oh', weights.oh)
    }

    this.vrm?.update(dt)

    for (const handle of this.materialHandles) handle.setTime(elapsed)
    for (const layer of this.rainLayers) layer.update(elapsed)

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
