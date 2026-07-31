// Parse a VRM (glTF binary) JSON chunk and report: VRM version, viseme/expression
// names, finger bones, spring bones — the capabilities the host engine depends on.
import { readFileSync } from 'node:fs'

const path = process.argv[2]
const buf = readFileSync(path)
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not glTF binary')
const jsonLen = buf.readUInt32LE(12)
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))

const ext = json.extensions ?? {}
const vrm0 = ext.VRM
const vrm1 = ext.VRMC_vrm

if (vrm1) {
  console.log('VRM 1.0')
  console.log('expressions:', Object.keys(vrm1.expressions?.preset ?? {}).join(', '))
  const bones = vrm1.humanoid?.humanBones ?? {}
  const fingers = Object.keys(bones).filter((b) => /(thumb|index|middle|ring|little)/i.test(b))
  console.log('humanoid bones:', Object.keys(bones).length, '| finger bones:', fingers.length)
  console.log('spring bones:', ext.VRMC_springBone ? (ext.VRMC_springBone.springs?.length ?? 0) + ' springs' : 'none')
} else if (vrm0) {
  console.log('VRM 0.x —', vrm0.meta?.title ?? 'untitled', '| license:', vrm0.meta?.licenseName ?? '?')
  const groups = vrm0.blendShapeMaster?.blendShapeGroups ?? []
  console.log('blendshapes:', groups.map((g) => g.presetName || g.name).join(', '))
  const bones = vrm0.humanoid?.humanBones ?? []
  const fingers = bones.filter((b) => /(thumb|index|middle|ring|little)/i.test(b.bone))
  console.log('humanoid bones:', bones.length, '| finger bones:', fingers.length)
  console.log('spring bone groups:', vrm0.secondaryAnimation?.boneGroups?.length ?? 0)
} else {
  console.log('No VRM extension — plain glTF. extensions:', Object.keys(ext).join(', '))
}
console.log('meshes:', (json.meshes ?? []).length, '| total morph targets:', (json.meshes ?? []).reduce((n, m) => n + (m.primitives?.[0]?.targets?.length ?? 0), 0))
