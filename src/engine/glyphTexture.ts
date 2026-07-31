import * as THREE from 'three'

export const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ΛΣΞΨΦ<>+=*'
export const GLYPH_COUNT = GLYPHS.length

/**
 * Single-row white-on-transparent glyph atlas. Shaders tint it; one texture is
 * shared by the surface material and every rain layer.
 */
export function createGlyphAtlas(cellPx = 64): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = GLYPH_COUNT * cellPx
  canvas.height = cellPx
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = `${Math.round(cellPx * 0.82)}px ui-monospace, Menlo, Consolas, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < GLYPH_COUNT; i += 1) {
      ctx.fillText(GLYPHS[i], i * cellPx + cellPx / 2, cellPx / 2)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Procedural dark-city skyline painted to a canvas texture for the far backdrop. */
export function createSkylineTexture(width = 2048, height = 512): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    let seed = 1401 >>> 0
    const rng = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    ctx.clearRect(0, 0, width, height)
    let x = 0
    while (x < width) {
      const bw = 30 + rng() * 90
      const bh = height * (0.2 + rng() * 0.65)
      ctx.fillStyle = 'rgba(6, 26, 15, 0.92)'
      ctx.fillRect(x, height - bh, bw, bh)
      if (rng() > 0.3) {
        ctx.fillStyle = 'rgba(52, 160, 92, 0.5)'
        for (let wy = height - bh + 8; wy < height - 8; wy += 14) {
          for (let wx = x + 6; wx < x + bw - 6; wx += 12) {
            if (rng() > 0.68) ctx.fillRect(wx, wy, 3, 5)
          }
        }
      }
      x += bw + 4 + rng() * 26
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
