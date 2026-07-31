import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

/**
 * Procedural gesture system v2 on the VRM normalized humanoid rig.
 *
 * Design rule learned the hard way: a hand wave is NOT sine waves on every
 * finger joint (that reads as a tentacle). A real wave is: arm raised and
 * mostly still, hand swinging as one unit from the wrist/elbow, fingers
 * together with only a whisper of stagger.
 *
 * Gestures: wave · point (at camera) · scold (point + finger wag + stern
 * face) · yell (angry + open mouth + lean-in + point). Plus emotions and
 * commanded head-look. Everything is code — everything is commandable.
 */

type GestureKind = 'wave' | 'point' | 'scold' | 'yell'

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

const RIGHT_FINGER_CHAINS: VRMHumanBoneName[][] = [
  ['rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal'],
  ['rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal'],
  ['rightRingProximal', 'rightRingIntermediate', 'rightRingDistal'],
  ['rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal'],
] as VRMHumanBoneName[][]

export class GestureController {
  private elapsed = 0
  private gesture: GestureKind | null = null
  private gestureStartedAt = 0
  private gestureDuration = 0
  private headYawTarget = 0
  private headPitchTarget = 0
  private headYaw = 0
  private headPitch = 0
  private nextBlinkAt = 2.5
  private blinkStartedAt = -1
  private emotion: 'angry' | 'happy' | 'sad' | 'relaxed' | null = null
  private emotionWeight = 0

  /** Extra mouth-open the host maxes with lip-sync (yelling). */
  mouthOpen = 0

  constructor(private readonly vrm: VRM) {}

  wave(durationSeconds = 3.4): void {
    this.start('wave', durationSeconds)
  }

  /** Arm out, index finger at the lens. */
  point(durationSeconds = 2.6): void {
    this.start('point', durationSeconds)
  }

  /** Point + finger wag + stern face — the "no-no-no" at the camera. */
  scold(durationSeconds = 3.4): void {
    this.start('scold', durationSeconds)
    this.setEmotion('angry', 0.85)
  }

  /** Lean in, angry, mouth open, pointing — yelling into the lens. */
  yell(durationSeconds = 3.0): void {
    this.start('yell', durationSeconds)
    this.setEmotion('angry', 1)
  }

  setEmotion(name: 'angry' | 'happy' | 'sad' | 'relaxed' | 'neutral', weight = 1): void {
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

  get activeGesture(): GestureKind | null {
    return this.elapsed - this.gestureStartedAt < this.gestureDuration ? this.gesture : null
  }

  private start(kind: GestureKind, duration: number): void {
    this.gesture = kind
    this.gestureStartedAt = this.elapsed
    this.gestureDuration = duration
  }

  private bone(name: VRMHumanBoneName) {
    return this.vrm.humanoid.getNormalizedBoneNode(name)
  }

  private setRotation(name: VRMHumanBoneName, x: number, y: number, z: number) {
    const node = this.bone(name)
    if (node) node.rotation.set(x, y, z)
  }

  /** Curl a full finger chain (0 = straight, 1 = fist). */
  private curlFinger(chain: VRMHumanBoneName[], amount: number) {
    for (const joint of chain) this.setRotation(joint, 0, 0, -amount * 0.85)
  }

  update(dt: number): void {
    this.elapsed += dt
    const t = this.elapsed
    this.mouthOpen = 0

    // ----- rest pose -----
    this.setRotation('leftUpperArm', 0, 0, 1.18)
    this.setRotation('leftLowerArm', 0, 0, 0.1)
    this.setRotation('rightUpperArm', 0, 0, -1.18)
    this.setRotation('rightLowerArm', 0, 0, -0.1)
    this.setRotation('rightHand', 0, 0, 0)
    this.curlFinger(RIGHT_FINGER_CHAINS[0], 0.15)
    this.curlFinger(RIGHT_FINGER_CHAINS[1], 0.18)
    this.curlFinger(RIGHT_FINGER_CHAINS[2], 0.2)
    this.curlFinger(RIGHT_FINGER_CHAINS[3], 0.22)
    this.setRotation('rightThumbProximal', 0, 0, -0.15)

    // ----- breathing + weight sway -----
    const breath = Math.sin(t * 2 * Math.PI * 0.22)
    const sway = Math.sin(t * 0.4)
    const chest = this.bone('chest') ?? this.bone('upperChest')
    if (chest) chest.rotation.set(0.02 * breath - 0.008, 0, 0)
    this.setRotation('spine', 0, 0.018 * sway, 0.01 * sway)
    this.setRotation('hips', 0, 0, 0.007 * Math.sin(t * 0.31))

    // ----- head look + idle micro-motion -----
    const lerp = 1 - Math.exp(-dt / 0.12)
    this.headYaw += (this.headYawTarget - this.headYaw) * lerp
    this.headPitch += (this.headPitchTarget - this.headPitch) * lerp
    const idleYaw = 0.02 * Math.sin(t * 0.33 + 1.7)
    const idlePitch = 0.012 * Math.sin(t * 0.27)
    let neckPitch = this.headPitch * 0.35 + idlePitch * 0.4
    let headPitchNow = this.headPitch * 0.65 + idlePitch

    // ----- gestures -----
    const gt = t - this.gestureStartedAt
    const active = gt < this.gestureDuration ? this.gesture : null

    if (active === 'wave') {
      const env = envelope(gt, this.gestureDuration)
      // Arm raised to the side, forearm up — held steady.
      this.setRotation('rightUpperArm', -0.18 * env, 0, -1.18 + env * 0.75)
      this.setRotation('rightLowerArm', 0, env * 0.35, -0.1 - env * 1.55)
      // The WAVE: the hand swings as one unit from the wrist. One axis. Small.
      const swing = Math.sin(gt * 2 * Math.PI * 2.1) * 0.42 * env
      this.setRotation('rightHand', 0, swing * 0.25, swing)
      // Fingers together, straight-ish, only a whisper of stagger.
      RIGHT_FINGER_CHAINS.forEach((chain, i) => {
        this.curlFinger(chain, 0.08 + 0.03 * Math.sin(gt * 2 * Math.PI * 2.1 - i * 0.3) * env)
      })
      this.setRotation('rightThumbProximal', 0, 0, -0.1)
    } else if (active === 'point' || active === 'scold' || active === 'yell') {
      const env = envelope(gt, this.gestureDuration, 0.4, 0.45)
      // Arm rotates forward to aim at the lens: NEGATIVE Y swing — the VRM0
      // normalized rig sits under the 180°-rotated root, so local Z is flipped
      // versus world and a positive swing aims the arm backwards.
      this.setRotation('rightUpperArm', -0.12 * env, -1.25 * env, -1.18 + env * 0.95)
      this.setRotation('rightLowerArm', 0, -0.3 * env, -0.1 + env * 0.02)
      // Index extended, the rest curled into the palm, thumb tucked.
      this.curlFinger(RIGHT_FINGER_CHAINS[0], 0.02)
      this.curlFinger(RIGHT_FINGER_CHAINS[1], 1.05 * env + 0.18 * (1 - env))
      this.curlFinger(RIGHT_FINGER_CHAINS[2], 1.1 * env + 0.2 * (1 - env))
      this.curlFinger(RIGHT_FINGER_CHAINS[3], 1.15 * env + 0.22 * (1 - env))
      this.setRotation('rightThumbProximal', 0, 0, -0.6 * env)

      if (active === 'scold') {
        // Finger wag: the whole hand rocks side-to-side at the wrist.
        this.setRotation('rightHand', 0, Math.sin(gt * 2 * Math.PI * 2.8) * 0.32 * env, 0)
      } else {
        this.setRotation('rightHand', 0, 0, 0)
      }

      if (active === 'yell') {
        // Lean into the camera, chin down, mouth working.
        this.setRotation('spine', -0.14 * env, 0.018 * sway, 0.01 * sway)
        neckPitch += 0.1 * env
        headPitchNow += 0.06 * env
        this.mouthOpen = env * (0.5 + 0.35 * Math.abs(Math.sin(gt * 2 * Math.PI * 3.2)))
      }
    }

    this.setRotation('neck', neckPitch, this.headYaw * 0.35 + idleYaw * 0.4, 0)
    this.setRotation('head', headPitchNow, this.headYaw * 0.65 + idleYaw, 0)

    // ----- expressions: emotion + blink -----
    const expressions = this.vrm.expressionManager
    if (expressions) {
      for (const name of ['angry', 'happy', 'sad', 'relaxed'] as const) {
        expressions.setValue(name, this.emotion === name ? this.emotionWeight : 0)
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
