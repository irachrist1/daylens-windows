#!/usr/bin/env node
// Renders build/dmg-background.svg to build/dmg-background.png at 1320x840 (@2x of the DMG window).
// Uses the locally installed Electron runtime to rasterize via a headless BrowserWindow.
// Run via: node_modules/.bin/electron scripts/render-dmg-background.js
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const TARGET_WIDTH = 1320
const TARGET_HEIGHT = 840
const BUILD_DIR = path.join(__dirname, '..', 'build')
const SVG_PATH = path.join(BUILD_DIR, 'dmg-background.svg')
const PNG_PATH = path.join(BUILD_DIR, 'dmg-background.png')

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    throw new Error(`Missing ${SVG_PATH}`)
  }

  const svg = fs.readFileSync(SVG_PATH, 'utf8')
  const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:${TARGET_WIDTH}px;height:${TARGET_HEIGHT}px;overflow:hidden}
    img{display:block;width:${TARGET_WIDTH}px;height:${TARGET_HEIGHT}px}
  </style></head><body><img src="${dataUri}"/></body></html>`

  const win = new BrowserWindow({
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    useContentSize: true,
    show: false,
    transparent: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, backgroundThrottling: false },
  })

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 400))

  const image = await win.webContents.capturePage({
    x: 0,
    y: 0,
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
  })

  const size = image.getSize()
  if (size.width !== TARGET_WIDTH || size.height !== TARGET_HEIGHT) {
    const resized = image.resize({ width: TARGET_WIDTH, height: TARGET_HEIGHT, quality: 'best' })
    fs.writeFileSync(PNG_PATH, resized.toPNG())
  } else {
    fs.writeFileSync(PNG_PATH, image.toPNG())
  }

  console.log(`[dmg-bg] wrote ${PNG_PATH} (${TARGET_WIDTH}x${TARGET_HEIGHT})`)
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error('[dmg-bg] failed:', err)
    app.exit(1)
  })
