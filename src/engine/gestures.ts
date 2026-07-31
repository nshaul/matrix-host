import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

/**
 * Procedural gesture system on the VRM normalized humanoid rig: rest pose,
 * breathing idle, head-look, and a full hand wave with per-finger ripple.
 * No animation assets — every motion is code, so every motion is commandable.
 */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Smoothstep envelope: 0→1 over [a,b]. */
function ease(t: number, a: number, b: number): number {
  const x = clamp((t - a) / (b - a), 0, 1)
  return x * x * (3 - 2 * x)
}

const FINGER_BONES: VRMHumanBoneName[] = [
  'rightThumbProximal',
  'rightIndexProximal',
  'rightIndexIntermediate',
  'rightMiddleProximal',
  'rightMiddleIntermediate',
  'rightRingProximal',
  'rightRingIntermediate',
  'rightLittleProximal',
  'rightLittleIntermediate',
] as VRMHumanBoneName[]

export class GestureController {
  private elapsed = 0
  private waveStartedAt = -Infinity
  private waveDuration = 3.2
  private headYawTarget = 0
  private headPitchTarget = 0
  private headYaw = 0
  private headPitch = 0
  private nextBlinkAt = 2.5
  private blinkStartedAt = -1

  constructor(private readonly vrm: VRM) {}

  /** Command a wave — arm raise, hand oscillation, finger ripple. */
  wave(durationSeconds = 3.2): void {
    this.waveStartedAt = this.elapsed
    this.waveDuration = durationSeconds
  }

  get isWaving(): boolean {
    return this.elapsed - this.waveStartedAt < this.waveDuration
  }

  /** Point the head. Degrees; smoothed internally. */
  setHeadLook(yawDeg: number, pitchDeg: number): void {
    this.headYawTarget = (yawDeg * Math.PI) / 180
    this.headPitchTarget = (pitchDeg * Math.PI) / 180
  }

  private bone(name: VRMHumanBoneName) {
    return this.vrm.humanoid.getNormalizedBoneNode(name)
  }

  update(dt: number): void {
    this.elapsed += dt
    const t = this.elapsed

    // ----- rest pose: arms down from the rig's T-pose -----
    const restArm = 1.18
    const leftUpper = this.bone('leftUpperArm')
    const rightUpper = this.bone('rightUpperArm')
    const leftLower = this.bone('leftLowerArm')
    const rightLower = this.bone('rightLowerArm')
    if (leftUpper) leftUpper.rotation.set(0, 0, restArm)
    if (rightUpper) rightUpper.rotation.set(0, 0, -restArm)
    if (leftLower) leftLower.rotation.set(0, 0, 0.12)
    if (rightLower) rightLower.rotation.set(0, 0, -0.12)

    // ----- breathing + weight sway -----
    const breath = Math.sin(t * 2 * Math.PI * 0.22)
    const sway = Math.sin(t * 0.4)
    const chest = this.bone('chest') ?? this.bone('upperChest')
    const spine = this.bone('spine')
    const hips = this.bone('hips')
    if (chest) chest.rotation.set(0.022 * breath - 0.01, 0, 0)
    if (spine) spine.rotation.set(0, 0.02 * sway, 0.012 * sway)
    if (hips) hips.rotation.set(0, 0, 0.008 * Math.sin(t * 0.31))

    // ----- head look (commanded) + idle micro-motion -----
    const lerp = 1 - Math.exp(-dt / 0.12)
    this.headYaw += (this.headYawTarget - this.headYaw) * lerp
    this.headPitch += (this.headPitchTarget - this.headPitch) * lerp
    const idleYaw = 0.02 * Math.sin(t * 0.33 + 1.7)
    const idlePitch = 0.012 * Math.sin(t * 0.27)
    const neck = this.bone('neck')
    const head = this.bone('head')
    if (neck) neck.rotation.set(this.headPitch * 0.35 + idlePitch * 0.4, this.headYaw * 0.35 + idleYaw * 0.4, 0)
    if (head) head.rotation.set(this.headPitch * 0.65 + idlePitch, this.headYaw * 0.65 + idleYaw, 0)

    // ----- wave: raise right arm, oscillate hand, ripple fingers -----
    const waveT = t - this.waveStartedAt
    if (waveT < this.waveDuration) {
      const envelope = ease(waveT, 0, 0.5) * (1 - ease(waveT, this.waveDuration - 0.55, this.waveDuration))
      if (rightUpper) rightUpper.rotation.set(0, 0, -restArm + envelope * 1.9)
      if (rightLower) rightLower.rotation.set(0, 0, -0.12 - envelope * 0.9)
      const hand = this.bone('rightHand')
      if (hand) hand.rotation.set(0, 0, envelope * Math.sin(waveT * 2 * Math.PI * 2.6) * 0.5)
      FINGER_BONES.forEach((name, i) => {
        const finger = this.bone(name)
        if (!finger) return
        const ripple = Math.sin(waveT * 2 * Math.PI * 2.6 - i * 0.55)
        finger.rotation.set(0, 0, -envelope * (0.18 + 0.22 * ripple))
      })
    } else {
      // relaxed finger curl
      FINGER_BONES.forEach((name) => {
        const finger = this.bone(name)
        if (finger) finger.rotation.set(0, 0, -0.16)
      })
    }

    // ----- blink on its own clock -----
    const expressions = this.vrm.expressionManager
    if (expressions) {
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
