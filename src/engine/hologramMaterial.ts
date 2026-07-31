import * as THREE from 'three'
import { GLYPH_COUNT } from './glyphTexture'

/**
 * The Matrix-hologram surface: luminous green tone ramp from the avatar's own
 * texture, fresnel rim that burns the contours white-hot, and glyph columns
 * flowing down the body in screen space. Additive blending means rain and city
 * light read straight through the figure — hologram physics, no sorting bugs.
 *
 * Built as a ShaderMaterial on three's own skinning/morph chunks, so bones and
 * viseme morphs keep working underneath the look.
 */

const VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <morphtarget_pars_vertex>
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewDirW;
void main() {
  vUv = uv;
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vNormalW = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
  vec3 worldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vViewDirW = normalize(cameraPosition - worldPos);
}
`

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform sampler2D uGlyphs;
uniform float uTime;
uniform float uCellPx;
uniform float uGlyphCount;
uniform float uBoost;
uniform float uHasMap;
uniform float uLumaGain;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewDirW;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec4 base = uHasMap > 0.5 ? texture2D(uMap, vUv) : vec4(0.62, 0.62, 0.62, 1.0);
  float alpha = base.a;
  if (alpha < 0.08) discard;

  float luma = dot(base.rgb, vec3(0.299, 0.587, 0.114));
  // Compress hard: anime textures live near white — the body must sit in the
  // matrix-green band with white reserved for rim, glyph sparks, and bloom.
  // uLumaGain lifts dark surfaces (hair) that would otherwise vanish additively.
  luma = min(pow(luma * uLumaGain, 2.2) * 0.82, 0.9);

  // Sculpting light: flat toon textures carry no form, so a shader key light
  // provides the volume the reference reads as depth.
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(vViewDirW);
  vec3 keyDir = normalize(vec3(0.35, 0.55, 0.75));
  float shade = 0.35 + 0.65 * max(dot(N, keyDir), 0.0);
  luma *= shade;

  vec3 color = mix(vec3(0.004, 0.04, 0.016), vec3(0.05, 0.32, 0.14), smoothstep(0.0, 0.5, luma));
  color = mix(color, vec3(0.16, 0.62, 0.32), smoothstep(0.45, 0.95, luma));

  // Fresnel rim — the reference's hot silhouette contour.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  color += vec3(0.75, 1.0, 0.85) * fres * 0.9;

  // Glyph code flowing down the figure (screen-space columns).
  vec2 cellCoord = gl_FragCoord.xy / uCellPx;
  float col = floor(cellCoord.x);
  float scroll = uTime * (0.35 + 0.9 * hash(vec2(col, 7.0)));
  float rowCoord = cellCoord.y + scroll * 6.0;
  float row = floor(rowCoord);
  vec2 cellLocal = vec2(fract(cellCoord.x), fract(rowCoord));
  float glyphIdx = floor(hash(vec2(col, row)) * uGlyphCount);
  float glyphMask = texture2D(uGlyphs, vec2((glyphIdx + cellLocal.x) / uGlyphCount, cellLocal.y)).a;
  float columnOn = step(0.3, hash(vec2(col, floor(row / 9.0))));

  // Embossed code: the lattice between glyphs darkens lit skin, the glyphs add light.
  color *= 1.0 - 0.42 * columnOn * (1.0 - glyphMask) * smoothstep(0.1, 0.45, luma);
  color += vec3(0.55, 1.0, 0.70) * glyphMask * columnOn * (0.08 + 0.42 * smoothstep(0.15, 0.8, luma));

  // Electro veins: ridged-noise filaments crawling under the skin in UV space,
  // so they follow the anatomy (the reference's neck/collarbone filaments).
  vec2 vp = vUv * 14.0;
  float n1 = sin(vp.x * 3.1 + sin(vp.y * 2.7 + uTime * 0.7));
  float n2 = sin(vp.y * 4.3 + sin(vp.x * 3.7 - uTime * 0.5) + uTime * 0.23);
  float vein = smoothstep(0.975, 1.0, 1.0 - abs(n1 * n2));
  color += vec3(0.8, 1.0, 0.9) * vein * smoothstep(0.08, 0.35, luma) * 0.45;

  // Slow luminous breathing.
  color *= 0.94 + 0.06 * sin(uTime * 1.4);

  // Double-sided shells: back faces contribute a whisper, not a double — that
  // whisper IS the translucent interior volume of the hologram.
  float facing = gl_FrontFacing ? 1.0 : 0.08;

  gl_FragColor = vec4(color * uBoost * alpha * facing, alpha);
}
`

export type HologramMaterialHandle = {
  material: THREE.ShaderMaterial
  setTime(seconds: number): void
  setCellPx(px: number): void
  setBoost(value: number): void
}

export function createHologramMaterial(
  sourceMap: THREE.Texture | null,
  glyphAtlas: THREE.Texture,
  side: THREE.Side = THREE.FrontSide,
  lumaGain = 1,
): HologramMaterialHandle {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uMap: { value: sourceMap },
      uGlyphs: { value: glyphAtlas },
      uTime: { value: 0 },
      uCellPx: { value: 10 },
      uGlyphCount: { value: GLYPH_COUNT },
      uBoost: { value: 1 },
      uHasMap: { value: sourceMap ? 1 : 0 },
      uLumaGain: { value: lumaGain },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Preserve the source sidedness: VRoid hair/face shells are authored
    // double-sided and vanish under a forced FrontSide.
    side,
  })
  return {
    material,
    setTime: (seconds) => {
      material.uniforms.uTime.value = seconds
    },
    setCellPx: (px) => {
      material.uniforms.uCellPx.value = px
    },
    setBoost: (value) => {
      material.uniforms.uBoost.value = value
    },
  }
}

/**
 * Swap every mesh material in a loaded avatar for the hologram look, preserving
 * each mesh's own diffuse texture as the luminance source. Returns handles so the
 * per-frame loop can drive time on all of them.
 */
export function applyHologramToAvatar(root: THREE.Object3D, glyphAtlas: THREE.Texture): HologramMaterialHandle[] {
  const handles: HologramMaterialHandle[] = []
  // MToon outline passes duplicate the whole surface — additively that reads as
  // 2× brightness, so outline slots become a render-nothing material instead.
  const nullMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const replaced = materials.map((original) => {
      if ((original as { isOutline?: boolean }).isOutline) return nullMaterial
      const map = (original as THREE.MeshStandardMaterial).map ?? null
      // Dark hair would vanish additively — lift it; blazing eye whites — damp them.
      const lumaGain = /eye.?white|sirome/i.test(original.name) ? 0.45 : /hair/i.test(original.name) ? 1.7 : 1
      const handle = createHologramMaterial(map, glyphAtlas, original.side, lumaGain)
      handles.push(handle)
      return handle.material
    })
    mesh.material = Array.isArray(mesh.material) ? replaced : replaced[0]
    mesh.frustumCulled = false
  })
  return handles
}
