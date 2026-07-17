import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { renderChannelImage, FORMAT_DIMENSIONS } from '../src/services/imagen.js'

describe('imagen de marca', () => {
  it('renderiza cover al tamaño del formato con barra de marca', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pbos-img-'))
    const src = path.join(dir, 'src.png')
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 100, b: 200 } } })
      .png().toFile(src)
    const out = path.join(dir, 'out.jpg')
    const dims = FORMAT_DIMENSIONS['instagram:feed']
    await renderChannelImage(src, out, { ...dims, label: 'SkyTrace' })
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(1080)
    expect(meta.height).toBe(1350)
    expect(meta.format).toBe('jpeg')
  })

  it('el catálogo de dimensiones cubre los formatos v1', () => {
    expect(FORMAT_DIMENSIONS['linkedin:imagen']).toEqual({ width: 1200, height: 627 })
    expect(FORMAT_DIMENSIONS['wa_status:historia']).toEqual({ width: 1080, height: 1920 })
  })
})
