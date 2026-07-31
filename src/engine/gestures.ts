import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import { HandController, type HandShapeName, type HandSide } from './hands'

/**
 * Procedural gesture system v3 on the VRM normalized humanoid rig.
 *
 * v2 lesson kept: a wave is the hand swinging as ONE unit from the wrist —
 * never sine waves on every joint (tentacle). v3 adds:
 *
 * - True finger articulation (HandController): fists, index-point, thumbs-up,
 *   with smooth channel blending.
 * - Camera-relative pointing solved geometrically: the host feeds a world
 *   target and the arm chain (upper → forearm → hand) is aimed by cascade
 *   quaternion solves against the probed bone axes. No Euler sign guessing —
 *   the VRM0 180°-root trap can't bite because every solve runs through the
 *   actual parent world quaternion.
 * - Scold/yell ride the same solve with wag/jab oscillators layered on top,
 *   plus lean, angry face, and a working mouth for the yell.
 * - Idle body life: breath, weight shift, micro arm sway, occasional gaze
 *   re-orients — documentary-footage subtle, never metronome.
 * - A final per-bone quaternion smoothing layer so gesture switches and
 *   retargets can never snap.
 */

export type PointStyle = 'calm' | 'scold' | 'yell'
type GestureKind = 'wave' | 'point' | 'thumbsUp'

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Smoothstep envelope 0→1 over [a,b]. */
function ease(t: number, a: number, b: number): number {
  const x = clamp((t - a) / (b - a), 0, 1)
  return x * x * (3 - 2 * x)
}

/** In-and-out envelope for a gesture of the given length. */
function envelope(t: number, duration: number, attack = 0.45, release = 0.5): number {
  return ease(t, 0, attack) * (1 - ease(t, duration - release, duration))
}

// Scratch registers (module scope; update() is single-threaded per frame).
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _q3 = new THREE.Quaternion()
const _qRestU = new THREE.Quaternion()
const _qRestL = new THREE.Quaternion()
const _qRestH = new THREE.Quaternion()
const UP = new THREE.Vector3(0, 1, 0)

/** Hand roll around the aim axis when pointing (palm orientation), per side. */
const POINT_HAND_ROLL = 0.35

/** Bones that pass through the anti-snap smoothing layer (tau seconds). */
const SMOOTHED_BONES: readonly { name: VRMHumanBoneName; tau: number }[] = [
  { name: 'hips' as VRMHumanBoneName, tau: 0.12 },
  { name: 'spine' as VRMHumanBoneName, tau: 0.1 },
  { name: 'chest' as VRMHumanBoneName, tau: 0.1 },
  { name: 'upperChest' as VRMHumanBoneName, tau: 0.1 },
  { name: 'neck' as VRMHumanBoneName, tau: 0.09 },
  { name: 'head' as VRMHumanBoneName, tau: 0.08 },
  { name: 'leftShoulder' as VRMHumanBoneName, tau: 0.08 },
  { name: 'rightShoulder' as VRMHumanBoneName, tau: 0.08 },
  { name: 'leftUpperArm' as VRMHumanBoneName, tau: 0.06 },
  { name: 'leftLowerArm' as VRMHumanBoneName, tau: 0.06 },
  { name: 'leftHand' as VRMHumanBoneName, tau: 0.05 },
  { name: 'rightUpperArm' as VRMHumanBoneName, tau: 0.06 },
  { name: 'rightLowerArm' as VRMHumanBoneName, tau: 0.06 },
  { name: 'rightHand' as VRMHumanBoneName, tau: 0.05 },
]

export class GestureController {
  private elapsed = 0
  private gesture: GestureKind | null = null
  private gestureStartedAt = 0
  private gestureDuration = 0
  private wasActive = false
  private pointStyle: PointStyle = 'calm'
  private pointHand: HandSide = 'right'
  /** World-space point target — the host feeds this every frame while pointing. */
  private readonly aimTarget = new THREE.Vector3(0, 1.4, 3)
  /** Where the eyes/head act toward (exact screen point; arm may be offset). */
  private readonly lookAim = new THREE.Vector3(0, 1.4, 3)

  private headYawTarget = 0
  private headPitchTarget = 0
  private headYaw = 0
  private headPitch = 0
  /** Occasional idle gaze re-orients (never frozen, never metronome). */
  private idleGazeYaw = 0
  private idleGazePitch = 0
  private idleGazeYawGoal = 0
  private idleGazePitchGoal = 0
  private nextGazeShiftAt = 3.5

  private nextBlinkAt = 2.5
  private blinkStartedAt = -1
  private emotion: 'angry' | 'happy' | 'sad' | 'relaxed' | null = null
  private emotionWeight = 0
  private emotionShown = 0
  private emotionAuto = false

  private readonly hands: Record<HandSide, HandController>
  private readonly baseShape: Record<HandSide, HandShapeName> = { left: 'relaxed', right: 'relaxed' }

  /** Probed facing direction (neck-parent local frame), captured at rest. */
  private headForwardLocal: THREE.Vector3 | null = null
  /** Cached bone-axis probes per side: upper→elbow, elbow→wrist, wrist→knuckles. */
  private readonly armAxes: Record<HandSide, { upper: THREE.Vector3; fore: THREE.Vector3; hand: THREE.Vector3 } | null>

  private readonly smoothQuats = new Map<THREE.Object3D, { q: THREE.Quaternion; tau: number }>()

  /** Extra mouth-open the host maxes with lip-sync (yelling). */
  mouthOpen = 0
  /** World point the eyes/head are acting toward while pointing (host mirrors to vrm.lookAt). */
  readonly lookTargetWorld = new THREE.Vector3()
  lookTargetActive = false

  constructor(private readonly vrm: VRM) {
    this.hands = {
      left: new HandController(vrm, 'left'),
      right: new HandController(vrm, 'right'),
    }
    this.armAxes = { left: this.probeArmAxes('left'), right: this.probeArmAxes('right') }
    for (const { name, tau } of SMOOTHED_BONES) {
      const node = this.bone(name)
      if (node) this.smoothQuats.set(node, { q: node.quaternion.clone(), tau })
    }
  }

  // ------------------------------------------------------------------ gestures

  wave(durationSeconds = 3.4): void {
    this.start('wave', durationSeconds)
    this.hands.right.setShape('open', 0.18)
  }

  /** Raised fist, thumb out. Reads best at bust/waist framing (a to-camera
   * thumbs-up is a mid-shot gesture; closeup crops the raised fist laterally). */
  thumbsUp(durationSeconds = 2.8): void {
    this.start('thumbsUp', durationSeconds)
    this.hands.right.setShape('thumbsUp', 0.16)
  }

  /**
   * Aim the index finger at the current aim target (host feeds world coords).
   * Retargeting an active point of the same hand extends it without re-raising.
   */
  pointToward(opts: { hand?: HandSide; style?: PointStyle; durationSeconds?: number } = {}): void {
    const hand = opts.hand ?? 'right'
    const style = opts.style ?? 'calm'
    const duration = opts.durationSeconds ?? (style === 'calm' ? 2.8 : style === 'scold' ? 3.4 : 3.0)
    const gt = this.elapsed - this.gestureStartedAt
    if (this.gesture === 'point' && gt < this.gestureDuration && this.pointHand === hand) {
      this.gestureDuration = gt + duration
      this.pointStyle = style
    } else {
      this.start('point', duration)
      this.pointStyle = style
      this.pointHand = hand
      this.hands[hand].setShape('indexPoint', 0.16)
    }
    if (style !== 'calm') {
      this.setEmotion('angry', style === 'yell' ? 1 : 0.85)
      this.emotionAuto = true
    }
  }

  /** Arm out, index finger at the lens. */
  point(durationSeconds = 2.8): void {
    this.pointToward({ style: 'calm', durationSeconds })
  }

  /** Fist + index jab, finger wag, stern face — the "no-no-no" at the camera. */
  scold(durationSeconds = 3.4): void {
    this.pointToward({ style: 'scold', durationSeconds })
  }

  /** Lean in, angry, mouth working, index jabbing at the lens. */
  yell(durationSeconds = 3.0): void {
    this.pointToward({ style: 'yell', durationSeconds })
  }

  setAimTargetWorld(target: THREE.Vector3): void {
    this.aimTarget.copy(target)
    this.lookAim.copy(target)
  }

  /** Separate arm and gaze targets (composition offset vs exact screen point). */
  setAimTargets(armTarget: THREE.Vector3, lookTarget: THREE.Vector3): void {
    this.aimTarget.copy(armTarget)
    this.lookAim.copy(lookTarget)
  }

  get pointingHand(): HandSide {
    return this.pointHand
  }

  setEmotion(name: 'angry' | 'happy' | 'sad' | 'relaxed' | 'neutral', weight = 1): void {
    this.emotionAuto = false
    if (name === 'neutral') {
      this.emotion = null
      this.emotionWeight = 0
      return
    }
    this.emotion = name
    this.emotionWeight = clamp(weight, 0, 1)
  }

  setHeadLook(yawDeg: number, pitchDeg: number): void {
    this.headYawTarget = (yawDeg * Math.PI) / 180
    this.headPitchTarget = (pitchDeg * Math.PI) / 180
  }

  /** Hold a hand shape outside of gestures (returns to it after gestures end). */
  setBaseHandShape(side: HandSide, shape: HandShapeName): void {
    this.baseShape[side] = shape
    const gt = this.elapsed - this.gestureStartedAt
    const gestureOwnsHand =
      gt < this.gestureDuration &&
      ((this.gesture === 'point' && this.pointHand === side) || (this.gesture !== 'point' && side === 'right'))
    if (!gestureOwnsHand) this.hands[side].setShape(shape, 0.16)
  }

  get activeGesture(): GestureKind | null {
    return this.elapsed - this.gestureStartedAt < this.gestureDuration ? this.gesture : null
  }

  // ------------------------------------------------------------------ internals

  private start(kind: GestureKind, duration: number): void {
    this.restoreHands()
    this.gesture = kind
    this.gestureStartedAt = this.elapsed
    this.gestureDuration = duration
    this.wasActive = true
  }

  private restoreHands(): void {
    this.hands.left.setShape(this.baseShape.left, 0.22)
    this.hands.right.setShape(this.baseShape.right, 0.22)
  }

  private bone(name: VRMHumanBoneName) {
    return this.vrm.humanoid.getNormalizedBoneNode(name)
  }

  private setRotation(name: VRMHumanBoneName, x: number, y: number, z: number) {
    const node = this.bone(name)
    if (node) node.rotation.set(x, y, z)
  }

  /** Read the actual bone directions from the rig instead of assuming signs. */
  private probeArmAxes(side: HandSide) {
    const lower = this.bone(`${side}LowerArm` as VRMHumanBoneName)
    const hand = this.bone(`${side}Hand` as VRMHumanBoneName)
    const middle = this.bone(`${side}MiddleProximal` as VRMHumanBoneName)
    if (!lower || !hand) return null
    const upper = lower.position.clone().normalize()
    const fore = hand.position.clone().normalize()
    const handAxis = middle && middle.position.lengthSq() > 1e-8 ? middle.position.clone().normalize() : fore.clone()
    return { upper, fore, hand: handAxis }
  }

  /**
   * Cascade aim solve: shoulder→target sets the upper arm, elbow→target the
   * forearm, wrist→target the hand — each in its parent's live world frame,
   * blended from the idle pose by `env`. At env=1 the index finger's line
   * passes through the target, which projects exactly to the requested screen
   * position.
   */
  private solvePointArm(side: HandSide, env: number, gt: number): void {
    const axes = this.armAxes[side]
    const upper = this.bone(`${side}UpperArm` as VRMHumanBoneName)
    const lower = this.bone(`${side}LowerArm` as VRMHumanBoneName)
    const hand = this.bone(`${side}Hand` as VRMHumanBoneName)
    if (!axes || !upper || !lower || !hand || !upper.parent || env <= 0.001) return

    _qRestU.copy(upper.quaternion)
    _qRestL.copy(lower.quaternion)
    _qRestH.copy(hand.quaternion)

    // Style oscillators.
    let armTilt = 0
    let handWag = 0
    let handChop = 0
    if (this.pointStyle === 'yell') {
      const jab = Math.pow(Math.max(0, Math.sin(gt * Math.PI * 2 * 3.0)), 2) * env
      armTilt = jab * 0.09
      handChop = jab * 0.28
    } else if (this.pointStyle === 'scold') {
      handWag = Math.sin(gt * Math.PI * 2 * 2.7) * 0.3 * env
    } else {
      armTilt = Math.sin(gt * Math.PI * 2 * 0.5) * 0.02 * env
    }

    // --- upper arm: shoulder → target ---
    upper.getWorldPosition(_v1)
    _v2.copy(this.aimTarget).sub(_v1).normalize()
    upper.parent.getWorldQuaternion(_q1).invert()
    const dirL = _v2.applyQuaternion(_q1)
    const sideAxis = _v3.copy(UP).applyQuaternion(_q1).cross(dirL).normalize()
    _q2.setFromUnitVectors(axes.upper, dirL)
    if (armTilt !== 0 && sideAxis.lengthSq() > 1e-6) {
      _q3.setFromAxisAngle(sideAxis, armTilt)
      _q2.premultiply(_q3)
    }
    upper.quaternion.copy(_qRestU).slerp(_q2, env)
    upper.updateWorldMatrix(false, false)

    // --- forearm: elbow → target ---
    _v1.copy(lower.position).applyMatrix4(upper.matrixWorld)
    _v2.copy(this.aimTarget).sub(_v1).normalize()
    upper.getWorldQuaternion(_q1).invert()
    const dirL2 = _v2.applyQuaternion(_q1)
    _q2.setFromUnitVectors(axes.fore, dirL2)
    lower.quaternion.copy(_qRestL).slerp(_q2, env)
    lower.updateWorldMatrix(false, false)

    // --- hand: wrist → target, rolled for a natural palm ---
    _v1.copy(hand.position).applyMatrix4(lower.matrixWorld)
    _v2.copy(this.aimTarget).sub(_v1).normalize()
    lower.getWorldQuaternion(_q1).invert()
    const dirL3 = _v2.applyQuaternion(_q1)
    _q2.setFromUnitVectors(axes.hand, dirL3)
    _q3.setFromAxisAngle(dirL3, side === 'right' ? POINT_HAND_ROLL : -POINT_HAND_ROLL)
    _q2.premultiply(_q3)
    if (handWag !== 0) {
      _v3.copy(UP).applyQuaternion(_q1)
      _q3.setFromAxisAngle(_v3.normalize(), handWag)
      _q2.premultiply(_q3)
    }
    if (handChop !== 0) {
      _v3.copy(UP).applyQuaternion(_q1).cross(dirL3)
      if (_v3.lengthSq() > 1e-6) {
        _q3.setFromAxisAngle(_v3.normalize(), handChop)
        _q2.premultiply(_q3)
      }
    }
    hand.quaternion.copy(_qRestH).slerp(_q2, env)
  }

  /**
   * Yaw/pitch (local, neck-parent frame) that turn the probed facing toward
   * the aim target. Math derives the signs — nothing hard-coded.
   */
  private aimHeadAngles(): { yaw: number; pitch: number } {
    const head = this.bone('head' as VRMHumanBoneName)
    const neck = this.bone('neck' as VRMHumanBoneName)
    const pivot = neck ?? head
    if (!pivot || !pivot.parent || !this.headForwardLocal) return { yaw: 0, pitch: 0 }
    const f0 = this.headForwardLocal
    ;(head ?? pivot).getWorldPosition(_v1)
    _v2.copy(this.lookAim).sub(_v1).normalize()
    pivot.parent.getWorldQuaternion(_q1).invert()
    const d = _v2.applyQuaternion(_q1)
    _v3.copy(UP).cross(f0) // ŷ × f0: the direction rotation.y(+) moves the face
    const yaw = Math.atan2(d.dot(_v3), d.x * f0.x + d.z * f0.z)
    const elevation = Math.asin(clamp(d.y, -1, 1))
    // rotation.x(+) changes elevation at rate −f_yawed.z (parent frame, x̂×f)
    _v3.copy(f0).applyAxisAngle(UP, yaw)
    const pitchSign = -Math.sign(_v3.z || -1)
    return { yaw: clamp(yaw, -1.05, 1.05), pitch: clamp(elevation * pitchSign, -0.65, 0.65) }
  }

  update(dt: number): void {
    this.elapsed += dt
    const t = this.elapsed
    this.mouthOpen = 0

    // Probe the facing once, at true rest, before any pose is applied.
    if (!this.headForwardLocal) {
      const neck = this.bone('neck' as VRMHumanBoneName) ?? this.bone('head' as VRMHumanBoneName)
      if (neck?.parent) {
        const dir = this.vrm.lookAt
          ? this.vrm.lookAt.getLookAtWorldDirection(new THREE.Vector3())
          : this.vrm.scene.getWorldDirection(new THREE.Vector3())
        neck.parent.getWorldQuaternion(_q1).invert()
        const f = dir.applyQuaternion(_q1)
        f.y = 0
        if (f.lengthSq() > 1e-6) this.headForwardLocal = f.normalize().clone()
      }
    }

    // ----- idle life: breath, weight shift, micro sway -----
    // Slightly irregular breath (rate wobbles) + two incommensurate weight sines.
    const breath = Math.sin(t * 2 * Math.PI * 0.21 + 0.4 * Math.sin(t * 2 * Math.PI * 0.031))
    const weight = 0.55 * Math.sin((t * 2 * Math.PI) / 13.7) + 0.45 * Math.sin((t * 2 * Math.PI) / 8.9 + 1.7)
    const sway = Math.sin(t * 0.4)

    this.setRotation('hips' as VRMHumanBoneName, 0, 0.012 * Math.sin((t * 2 * Math.PI) / 17.3 + 0.6), 0.022 * weight)
    this.setRotation('spine' as VRMHumanBoneName, 0, 0.018 * sway, 0.01 * sway - 0.013 * weight)
    const chest = this.bone('chest' as VRMHumanBoneName) ?? this.bone('upperChest' as VRMHumanBoneName)
    if (chest) chest.rotation.set(0.02 * breath - 0.008, 0, 0.006 * weight)
    this.setRotation('leftShoulder' as VRMHumanBoneName, 0, 0, 0.007 * breath + 0.005 * weight)
    this.setRotation('rightShoulder' as VRMHumanBoneName, 0, 0, -0.007 * breath + 0.005 * weight)

    // Arms at rest with micro sway — never frozen.
    const armSwayR = 0.016 * Math.sin((t * 2 * Math.PI) / 11.3 + 0.9)
    const armSwayL = 0.016 * Math.sin((t * 2 * Math.PI) / 12.7 + 2.1)
    this.setRotation('leftUpperArm' as VRMHumanBoneName, 0, 0, 1.18 + armSwayL + 0.018 * weight)
    this.setRotation('leftLowerArm' as VRMHumanBoneName, 0, 0, 0.1 + 0.012 * Math.sin(t * 0.5 + 1.1))
    this.setRotation('leftHand' as VRMHumanBoneName, 0, 0, 0)
    this.setRotation('rightUpperArm' as VRMHumanBoneName, 0, 0, -1.18 - armSwayR + 0.018 * weight)
    this.setRotation('rightLowerArm' as VRMHumanBoneName, 0, 0, -0.1 - 0.012 * Math.sin(t * 0.47))
    this.setRotation('rightHand' as VRMHumanBoneName, 0, 0, 0)

    // ----- head look: commanded + idle re-orients -----
    if (t >= this.nextGazeShiftAt) {
      this.idleGazeYawGoal = (Math.random() - 0.5) * 0.26
      this.idleGazePitchGoal = (Math.random() - 0.5) * 0.1
      this.nextGazeShiftAt = t + 4 + Math.random() * 5
    }
    const gazeK = 1 - Math.exp(-dt / 0.55)
    this.idleGazeYaw += (this.idleGazeYawGoal - this.idleGazeYaw) * gazeK
    this.idleGazePitch += (this.idleGazePitchGoal - this.idleGazePitch) * gazeK

    const lerp = 1 - Math.exp(-dt / 0.12)
    this.headYaw += (this.headYawTarget - this.headYaw) * lerp
    this.headPitch += (this.headPitchTarget - this.headPitch) * lerp
    const idleYaw = this.idleGazeYaw + 0.02 * Math.sin(t * 0.33 + 1.7)
    const idlePitch = this.idleGazePitch + 0.012 * Math.sin(t * 0.27)
    let headYawNow = this.headYaw + idleYaw
    let headPitchNow = this.headPitch + idlePitch

    // ----- gestures -----
    const gt = t - this.gestureStartedAt
    const active = gt < this.gestureDuration ? this.gesture : null
    if (!active && this.wasActive) {
      this.wasActive = false
      this.restoreHands()
      if (this.emotionAuto) {
        this.emotion = null
        this.emotionWeight = 0
        this.emotionAuto = false
      }
    }

    this.lookTargetActive = false

    if (active === 'wave') {
      const env = envelope(gt, this.gestureDuration)
      // Arm raised to the side, forearm up — held steady. (Fold sign verified
      // by screenshot: negative z folded the forearm down toward the hip.)
      this.setRotation('rightUpperArm' as VRMHumanBoneName, -0.18 * env, 0, -1.18 + env * 0.98)
      this.setRotation('rightLowerArm' as VRMHumanBoneName, 0, env * 0.32, -0.1 + env * 1.78)
      // The WAVE: the hand swings as one unit from the wrist. One axis. Small.
      const swing = Math.sin(gt * 2 * Math.PI * 2.1) * 0.46 * env
      this.setRotation('rightHand' as VRMHumanBoneName, 0, swing * 0.22, swing)
    } else if (active === 'thumbsUp') {
      const env = envelope(gt, this.gestureDuration, 0.4, 0.45)
      // Same fold sign the wave verified (+z raises the forearm; −z buried the
      // fist at the hip): elbow low, forearm folded UP so the fist presents at
      // shoulder height, angled a touch toward the lens.
      // Fist presented beside the cheek, wave-verified raise heights (+z folds
      // the forearm UP), angled toward the lens so it reads in closeup framing.
      this.setRotation('rightUpperArm' as VRMHumanBoneName, -0.12 * env, -0.22 * env, -1.18 + env * 0.55)
      this.setRotation('rightLowerArm' as VRMHumanBoneName, 0, env * 0.42, -0.1 + env * 1.62)
      // Wrist rolled back so the extended thumb silhouettes at the fist's top
      // edge instead of hiding against the knuckles (screenshot-tuned).
      this.setRotation('rightHand' as VRMHumanBoneName, -0.55 * env, 0, 0.12 * env)
    } else if (active === 'point') {
      const env = envelope(gt, this.gestureDuration, 0.5, 0.55)
      const follow = this.aimHeadAngles()
      headYawNow = headYawNow * (1 - env) + follow.yaw * env
      headPitchNow = headPitchNow * (1 - env) + follow.pitch * env
      // Chest opens toward the target; yell adds the lean-in.
      const chestNode = this.bone('chest' as VRMHumanBoneName) ?? this.bone('upperChest' as VRMHumanBoneName)
      if (chestNode) chestNode.rotation.y += follow.yaw * 0.22 * env
      if (this.pointStyle === 'yell') {
        const spineNode = this.bone('spine' as VRMHumanBoneName)
        if (spineNode) spineNode.rotation.x -= 0.15 * env
        headPitchNow += 0.08 * env
        this.mouthOpen = env * (0.5 + 0.35 * Math.abs(Math.sin(gt * 2 * Math.PI * 3.2)))
      } else if (this.pointStyle === 'scold') {
        const spineNode = this.bone('spine' as VRMHumanBoneName)
        if (spineNode) spineNode.rotation.x -= 0.06 * env
      }
      this.solvePointArm(this.pointHand, env, gt)
      if (env > 0.05) {
        this.lookTargetActive = true
        this.lookTargetWorld.copy(this.lookAim)
      }
    }

    this.setRotation('neck' as VRMHumanBoneName, headPitchNow * 0.35, headYawNow * 0.35, 0)
    this.setRotation('head' as VRMHumanBoneName, headPitchNow * 0.65, headYawNow * 0.65, 0)

    // ----- fingers -----
    this.hands.left.update(dt)
    this.hands.right.update(dt)

    // ----- anti-snap smoothing layer -----
    for (const [node, s] of this.smoothQuats) {
      const k = 1 - Math.exp(-dt / s.tau)
      s.q.slerp(node.quaternion, k)
      node.quaternion.copy(s.q)
    }

    // ----- expressions: emotion + blink -----
    const expressions = this.vrm.expressionManager
    if (expressions) {
      const emotionK = 1 - Math.exp(-dt / 0.22)
      this.emotionShown += ((this.emotion ? this.emotionWeight : 0) - this.emotionShown) * emotionK
      for (const name of ['angry', 'happy', 'sad', 'relaxed'] as const) {
        expressions.setValue(name, this.emotion === name ? this.emotionShown : 0)
      }
      if (this.blinkStartedAt < 0 && t >= this.nextBlinkAt) this.blinkStartedAt = t
      if (this.blinkStartedAt >= 0) {
        const progress = (t - this.blinkStartedAt) / 0.13
        if (progress >= 1) {
          expressions.setValue('blink', 0)
          this.blinkStartedAt = -1
          this.nextBlinkAt = t + 2.5 + Math.random() * 3.5
        } else {
          expressions.setValue('blink', Math.sin(progress * Math.PI))
        }
      }
    }
  }
}
