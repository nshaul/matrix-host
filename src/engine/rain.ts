import * as THREE from 'three'
import { GLYPH_COUNT, createSkylineTexture } from './glyphTexture'

/**
 * Depth-layered glyph rain: shader planes at different z with their own density,
 * speed, brightness, and cell size — sharp dim curtains far behind the figure,
 * bright bokeh-soft streams in front. Additive, so everything composes as light.
 */

const RAIN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const RAIN_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uGlyphs;
uniform float uTime;
uniform float uColumns;
uniform float uCells;
uniform float uGlyphCount;
uniform float uBrightness;
uniform float uDensity;
uniform float uSoft;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  float col = floor(vUv.x * uColumns);
  float colSeed = hash(vec2(col, 3.7));
  if (colSeed > uDensity) discard;

  float speed = 0.05 + colSeed * 0.16;
  float flow = fract(vUv.y + uTime * speed + colSeed * 7.0);
  float trail = pow(flow, 5.0);

  float rowCoord = vUv.y * uCells + floor(uTime * (0.5 + colSeed)) * step(0.96, colSeed);
  float row = floor(rowCoord);
  vec2 cellLocal = vec2(fract(vUv.x * uColumns), fract(rowCoord));
  float glyphIdx = floor(hash(vec2(col, row)) * uGlyphCount);
  float soft = uSoft * 0.35;
  float glyph = texture2D(uGlyphs, vec2((glyphIdx + cellLocal.x) / uGlyphCount, cellLocal.y)).a;
  glyph = mix(glyph, smoothstep(0.1, 0.9, glyph), 1.0 - soft) * (1.0 - soft * 0.3) + soft * 0.22 * trail;

  vec3 green = mix(vec3(0.08, 0.45, 0.2), vec3(0.5, 1.0, 0.65), trail);
  green = mix(green, vec3(0.92, 1.0, 0.95), smoothstep(0.93, 1.0, flow)); // white-hot head
  float a = glyph * trail * uBrightness;
  gl_FragColor = vec4(green * a, a);
}
`

export type RainLayer = {
  mesh: THREE.Mesh
  update(seconds: number): void
}

export function createRainLayer(
  glyphAtlas: THREE.Texture,
  options: {
    width: number
    height: number
    z: number
    columns: number
    cells: number
    brightness: number
    density: number
    soft: number
  },
): RainLayer {
  const material = new THREE.ShaderMaterial({
    vertexShader: RAIN_VERTEX,
    fragmentShader: RAIN_FRAGMENT,
    uniforms: {
      uGlyphs: { value: glyphAtlas },
      uTime: { value: 0 },
      uColumns: { value: options.columns },
      uCells: { value: options.cells },
      uGlyphCount: { value: GLYPH_COUNT },
      uBrightness: { value: options.brightness },
      uDensity: { value: options.density },
      uSoft: { value: options.soft },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(options.width, options.height), material)
  mesh.position.z = options.z
  mesh.position.y = options.height * 0.32
  mesh.frustumCulled = false
  return {
    mesh,
    update(seconds) {
      material.uniforms.uTime.value = seconds
    },
  }
}

export function createSkyline(width = 30, height = 7): THREE.Mesh {
  const texture = createSkylineTexture()
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
  mesh.position.set(0, height * 0.24, -9)
  return mesh
}

/** Ambient glow disc behind the figure — the hologram's light spilling into the dark. */
export function createAmbientGlow(): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
    gradient.addColorStop(0, 'rgba(70, 220, 120, 0.10)')
    gradient.addColorStop(0.55, 'rgba(30, 120, 62, 0.04)')
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 256, 256)
  }
  const texture = new THREE.CanvasTexture(canvas)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 4.5), material)
  mesh.position.set(0, 1.35, -2.5)
  return mesh
}
