import sharp from 'sharp'

export const FORMAT_DIMENSIONS = {
  'linkedin:imagen': { width: 1200, height: 627 },
  'instagram:feed': { width: 1080, height: 1350 },
  'instagram:historia': { width: 1080, height: 1920 },
  'wa_status:historia': { width: 1080, height: 1920 },
}

export async function renderChannelImage(srcPath, outPath, { width, height, label }) {
  const barH = Math.round(height * 0.06)
  const fontSize = Math.round(barH * 0.5)
  const svg = Buffer.from(`
    <svg width="${width}" height="${barH}">
      <rect width="100%" height="100%" fill="black" fill-opacity="0.55"/>
      <text x="${Math.round(width * 0.02)}" y="${Math.round(barH * 0.68)}"
        font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}"
        fill="white">${escapeXml(label)}</text>
    </svg>
  `)
  await sharp(srcPath)
    .resize(width, height, { fit: 'cover', position: 'attention' })
    .composite([{ input: svg, top: height - barH, left: 0 }])
    .jpeg({ quality: 88 })
    .toFile(outPath)
  return outPath
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
}
