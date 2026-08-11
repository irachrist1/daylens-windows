#!/usr/bin/env node
// Renders build/icon.svg to build/icon.png (1024) and build/icon.icns (full iconset).
// Uses the locally installed Electron runtime to rasterize, same as render-dmg-background.js.
// Run via: node_modules/.bin/electron scripts/render-icons.js
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BUILD_DIR = path.join(__dirname, '..', 'build')
const SVG_PATH = path.join(BUILD_DIR, 'icon.svg')
const PNG_PATH = path.join(BUILD_DIR, 'icon.png')
const ICNS_PATH = path.join(BUILD_DIR, 'icon.icns')

// iconset member -> pixel size. iconutil requires exactly these names.
const ICONSET = {
  'icon_16x16': 16,
  'icon_16x16@2x': 32,
  'icon_32x32': 32,
  'icon_32x32@2x': 64,
  'icon_128x128': 128,
  'icon_128x128@2x': 256,
  'icon_256x256': 256,
  'icon_256x256@2x': 512,
  'icon_512x512': 512,
  'icon_512x512@2x': 1024,
}

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    throw new Error(`Missing ${SVG_PATH}`)
  }
  const svg = fs.readFileSync(SVG_PATH, 'utf8')
  const sizes = [...new Set(Object.values(ICONSET))].sort((a, b) => a - b)

  const win = new BrowserWindow({
    width: 64,
    height: 64,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false },
  })

  const html = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent"></body>'
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  // Rasterize each size from a re-dimensioned copy of the SVG rather than downscaling
  // one 1024 bitmap — Chromium then renders the vector natively at that size, which
  // keeps the 16px and 32px members legible instead of mushy.
  const rendered = await win.webContents.executeJavaScript(`(async () => {
    const svg = ${JSON.stringify(svg)}
    const out = {}
    for (const size of ${JSON.stringify(sizes)}) {
      const scaled = svg.replace(
        /<svg([^>]*?)width="\\d+" height="\\d+"/,
        '<svg$1width="' + size + '" height="' + size + '"',
      )
      const img = new Image()
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(scaled)
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, size, size)
      ctx.drawImage(img, 0, 0, size, size)
      out[size] = canvas.toDataURL('image/png').split(',')[1]
    }
    return out
  })()`)

  const png = (size) => Buffer.from(rendered[size], 'base64')

  fs.writeFileSync(PNG_PATH, png(1024))
  console.log(`[icons] wrote ${PNG_PATH} (1024x1024)`)

  if (process.platform !== 'darwin') {
    console.log('[icons] skipping icon.icns — iconutil is macOS-only')
    return
  }

  const iconsetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-icon-')) + '/icon.iconset'
  fs.mkdirSync(iconsetDir)
  try {
    for (const [name, size] of Object.entries(ICONSET)) {
      fs.writeFileSync(path.join(iconsetDir, `${name}.png`), png(size))
    }
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', ICNS_PATH])
    console.log(`[icons] wrote ${ICNS_PATH} (${Object.keys(ICONSET).length} members)`)
  } finally {
    fs.rmSync(path.dirname(iconsetDir), { recursive: true, force: true })
  }
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error('[icons] failed:', err)
    app.exit(1)
  })
