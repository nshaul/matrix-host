import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

/**
 * Finger articulation on the VRM normalized humanoid rig.
 *
 * Every finger joint is driven from a small channel set (per-finger curl,
 * splay, three thumb channels) through empirically-probed curl axes: the
 * normalized rig zeroes rest rotations, so each joint's local axes equal the
 * root frame — we read the actual bone direction from the child joint's local
 * position and derive the curl axis as (fingerDir × palmarNormal). That makes
 * the curls correct for either hand without hard-coding the VRM0 sign traps.
 *
 * Shapes are targets; the controller exponential-smooths every channel so a
 * fist forms like a hand closing, never like a switch flipping.
 */

export type HandSide = 'left' | 'right'
export type HandShapeName = 'open' | 'relaxed' | 'fist' | 'indexPoint' | 'thumbsUp'

/** Channel set: finger curls are 0 (straight) → 1 (buried in the palm). */
export interface HandPose {
  index: number
  middle: number
  ring: number
  little: number
  /** Finger splay: 0 = together, 1 = fanned wide. */
  spread: number
  /** Thumb swings across the palm (opposition — the fist wrap). */
  thumbAcross: number
  /** Thumb tip fold. */
  thumbCurl: number
  /** Thumb abduction away from the palm (thumbs-up). */
  thumbOut: number
}

export const HAND_SHAPES: Record<HandShapeName, HandPose> = {
  open: { index: 0.04, middle: 0.03, ring: 0.04, little: 0.06, spread: 0.55, thumbAcross: 0.1, thumbCurl: 0.08, thumbOut: 0.4 },
  relaxed: { index: 0.24, middle: 0.28, ring: 0.33, little: 0.38, spread: 0.14, thumbAcross: 0.2, thumbCurl: 0.22, thumbOut: 0.15 },
  fist: { index: 1, middle: 1, ring: 1, little: 1, spread: 0, thumbAcross: 0.9, thumbCurl: 0.85, thumbOut: 0 },
  indexPoint: { index: 0.03, middle: 1, ring: 1, little: 1, spread: 0, thumbAcross: 0.85, thumbCurl: 0.8, thumbOut: 0 },
  thumbsUp: { index: 1, middle: 1, ring: 1, little: 1, spread: 0, thumbAcross: 0.06, thumbCurl: 0.05, thumbOut: 1 },
}

// ---- tuning (kept together: iterate here, verify by screenshot) ----
/** Radians of curl per joint (proximal, intermediate, distal) at curl = 1. */
const JOINT_CURL_RAD: readonly [number, number, number] = [1.4, 1.6, 0.85]
const SPREAD_MAX_RAD = 0.17
/** Splay direction per finger, index → little (away from / toward the middle line). */
const SPREAD_FACTORS: readonly [number, number, number, number] = [1, 0.25, -0.5, -1]
const THUMB_ACROSS_RAD = 1.0
const THUMB_ACROSS_PROXIMAL_RAD = 0.35
const THUMB_CURL_RAD: readonly [number, number] = [0.55, 0.95]
const THUMB_OUT_RAD = 0.55
const THUMB_OUT_PROXIMAL_RAD = 0.2

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const
const JOINTS = ['Proximal', 'Intermediate', 'Distal'] as const
type FingerName = (typeof FINGERS)[number]

const FINGER_CHANNEL: Record<FingerName, 'index' | 'middle' | 'ring' | 'little'> = {
  Index: 'index',
  Middle: 'middle',
  Ring: 'ring',
  Little: 'little',
}

const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _v = new THREE.Vector3()

/**
 * Palm direction used to derive curl axes. The VRM T-pose spec says palms
 * down, but in this rig's normalized local frame the empirically-correct
 * palmar direction is +Y (verified by screenshot: -Y hyperextended the
 * fingers backward and a "fist" read as an open palm).
 */
const PALMAR = new THREE.Vector3(0, 1, 0)
const UP = new THREE.Vector3(0, 1, 0)

export class HandController {
  /** chains[finger][joint] — null where the model lacks the bone. */
  private readonly chains: (THREE.Object3D | null)[][] = []
  /** Probed curl axis per joint (unit vector in the joint's local frame). */
  private readonly curlAxes: THREE.Vector3[][] = []
  private readonly thumbMeta: THREE.Object3D | null
  private readonly thumbProx: THREE.Object3D | null
  private readonly thumbDist: THREE.Object3D | null

  private readonly current: HandPose = { ...HAND_SHAPES.relaxed }
  private readonly target: HandPose = { ...HAND_SHAPES.relaxed }
  private tau = 0.12
  private shape: HandShapeName = 'relaxed'

  constructor(
    vrm: VRM,
    readonly side: HandSide,
  ) {
    const bone = (name: string) => vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName)

    for (const finger of FINGERS) {
      const chain = JOINTS.map((joint) => bone(`${side}${finger}${joint}`))
      this.chains.push(chain)
      // Probe the bone direction from the next joint's local offset; the curl
      // axis is perpendicular to both the finger and the palm normal.
      const axes: THREE.Vector3[] = []
      let lastAxis = new THREE.Vector3(0, 0, side === 'right' ? -1 : 1)
      for (let j = 0; j < chain.length; j += 1) {
        const child = chain[j + 1]
        if (child && child.position.lengthSq() > 1e-8) {
          const dir = child.position.clone().normalize()
          const axis = dir.cross(PALMAR).normalize()
          if (axis.lengthSq() > 1e-6) lastAxis = axis
        }
        axes.push(lastAxis.clone())
      }
      this.curlAxes.push(axes)
    }

    this.thumbMeta = bone(`${side}ThumbMetacarpal`)
    this.thumbProx = bone(`${side}ThumbProximal`)
    this.thumbDist = bone(`${side}ThumbDistal`)
  }

  get shapeName(): HandShapeName {
    return this.shape
  }

  /** Blend toward a named shape (or an explicit channel set). */
  setShape(shape: HandShapeName | HandPose, blendSeconds = 0.12): void {
    const pose = typeof shape === 'string' ? HAND_SHAPES[shape] : shape
    if (typeof shape === 'string') this.shape = shape
    Object.assign(this.target, pose)
    this.tau = Math.max(0.02, blendSeconds)
  }

  /** Nudge individual channels on top of the current target (additive acting). */
  setChannels(channels: Partial<HandPose>): void {
    Object.assign(this.target, channels)
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt / this.tau)
    const cur = this.current as unknown as Record<string, number>
    const tgt = this.target as unknown as Record<string, number>
    for (const key of Object.keys(cur)) cur[key] += (tgt[key] - cur[key]) * k
    this.apply()
  }

  private apply(): void {
    const pose = this.current
    // Splay + thumb-across mirror between hands; probed curl axes already handle
    // curl. Thumb signs verified by screenshot: the opposite across-sign hooked
    // the thumb over the BACK of the fist, and the opposite out-sign made
    // thumbs-up curl backward instead of extending.
    const spreadSign = this.side === 'right' ? -1 : 1
    const acrossSign = spreadSign
    const outSign = -spreadSign

    for (let f = 0; f < FINGERS.length; f += 1) {
      const curl = pose[FINGER_CHANNEL[FINGERS[f]]]
      const chain = this.chains[f]
      const axes = this.curlAxes[f]
      for (let j = 0; j < chain.length; j += 1) {
        const node = chain[j]
        if (!node) continue
        _q.setFromAxisAngle(axes[j], curl * JOINT_CURL_RAD[j])
        if (j === 0) {
          _q2.setFromAxisAngle(UP, spreadSign * SPREAD_FACTORS[f] * pose.spread * SPREAD_MAX_RAD)
          _q.premultiply(_q2)
        }
        node.quaternion.copy(_q)
      }
    }

    if (this.thumbMeta) {
      _q.setFromAxisAngle(UP, acrossSign * pose.thumbAcross * THUMB_ACROSS_RAD)
      _q2.setFromAxisAngle(_v.set(1, 0, 0), spreadSign * pose.thumbOut * THUMB_OUT_RAD)
      this.thumbMeta.quaternion.copy(_q).multiply(_q2)
    }
    if (this.thumbProx) {
      _q.setFromAxisAngle(UP, acrossSign * (pose.thumbAcross * THUMB_ACROSS_PROXIMAL_RAD + pose.thumbCurl * THUMB_CURL_RAD[0]))
      _q2.setFromAxisAngle(_v.set(1, 0, 0), spreadSign * pose.thumbOut * THUMB_OUT_PROXIMAL_RAD)
      this.thumbProx.quaternion.copy(_q).multiply(_q2)
    }
    if (this.thumbDist) {
      this.thumbDist.quaternion.setFromAxisAngle(UP, acrossSign * pose.thumbCurl * THUMB_CURL_RAD[1])
    }
  }
}
