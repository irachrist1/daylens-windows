import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { resetIconResolverCache, resolveIcon } from '../src/main/services/iconResolver.ts'

function tempCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-icons-'))
}

function sampleDataUrl(label: string): string {
  return `data:image/png;base64,${Buffer.from(label, 'utf8').toString('base64')}`
}

function samplePngBytes(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
    'base64',
  )
}

function createChromiumFaviconsDb(profileDir: string, entries: Array<{ pageUrl: string; iconId: number; imageData: Buffer; width?: number }>): string {
  fs.mkdirSync(profileDir, { recursive: true })
  const dbPath = path.join(profileDir, 'Favicons')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE icon_mapping (
      page_url TEXT NOT NULL,
      icon_id INTEGER NOT NULL
    );
    CREATE TABLE favicon_bitmaps (
      icon_id INTEGER NOT NULL,
      image_data BLOB NOT NULL,
      width INTEGER NOT NULL DEFAULT 16
    );
  `)

  const insertMapping = db.prepare('INSERT INTO icon_mapping (page_url, icon_id) VALUES (?, ?)')
  const insertBitmap = db.prepare('INSERT INTO favicon_bitmaps (icon_id, image_data, width) VALUES (?, ?, ?)')
  for (const entry of entries) {
    insertMapping.run(entry.pageUrl, entry.iconId)
    insertBitmap.run(entry.iconId, entry.imageData, entry.width ?? 16)
  }
  db.close()
  return dbPath
}

test('app icon resolution prefers stored active-window icon and survives cache reloads', async () => {
  resetIconResolverCache()
  const cacheDir = tempCacheDir()
  const activeWindowIconBase64 = Buffer.from('newthing-live-icon', 'utf8').toString('base64')

  const first = await resolveIcon({
    kind: 'app',
    bundleId: 'C:\\Apps\\NewThing\\newthing.exe',
    appName: 'NewThing',
  }, {
    cacheDir,
    platform: 'win32',
    getFileIconDataUrl: async () => null,
    getAppIdentity: () => ({
      appInstanceId: 'C:\\Apps\\NewThing\\newthing.exe',
      bundleId: 'C:\\Apps\\NewThing\\newthing.exe',
      rawAppName: 'NewThing',
      canonicalAppId: 'newthing',
      displayName: 'NewThing',
      defaultCategory: 'development',
      firstSeenAt: 100,
      lastSeenAt: 200,
      metadata: {
        executablePath: 'C:\\Apps\\NewThing\\newthing.exe',
        activeWindowIconBase64,
        activeWindowIconMime: 'image/png',
      },
    }),
  })

  assert.equal(first.source, 'active_window')
  assert.match(first.dataUrl ?? '', /^data:image\/png;base64,/)

  resetIconResolverCache()
  const second = await resolveIcon({
    kind: 'app',
    bundleId: 'C:\\Apps\\NewThing\\newthing.exe',
    appName: 'NewThing',
  }, {
    cacheDir,
    platform: 'win32',
    getFileIconDataUrl: async () => null,
    getAppIdentity: () => null,
  })

  assert.equal(second.source, 'active_window')
  assert.equal(second.dataUrl, first.dataUrl)
})

test('app icon resolution falls back to executable icons and UWP manifest icons', async () => {
  resetIconResolverCache()

  const fileIcon = await resolveIcon({
    kind: 'app',
    bundleId: 'C:\\Apps\\LocalApp\\localapp.exe',
    appName: 'LocalApp',
  }, {
    cacheDir: tempCacheDir(),
    platform: 'win32',
    getFileIconDataUrl: async (filePath) => filePath.endsWith('localapp.exe') ? sampleDataUrl('exe-icon') : null,
    resolveWindowsUwpIcon: async () => null,
    getAppIdentity: () => null,
  })

  assert.equal(fileIcon.source, 'app_file')
  assert.equal(fileIcon.dataUrl, sampleDataUrl('exe-icon'))

  resetIconResolverCache()
  const uwpIcon = await resolveIcon({
    kind: 'app',
    bundleId: 'Contoso.NewApp_8wekyb3d8bbwe',
    appName: 'Contoso NewApp',
  }, {
    cacheDir: tempCacheDir(),
    platform: 'win32',
    getFileIconDataUrl: async () => null,
    resolveWindowsUwpIcon: async (packageFamily) => packageFamily === 'Contoso.NewApp_8wekyb3d8bbwe'
      ? sampleDataUrl('uwp-icon')
      : null,
    getAppIdentity: () => null,
  })

  assert.equal(uwpIcon.source, 'uwp_manifest')
  assert.equal(uwpIcon.dataUrl, sampleDataUrl('uwp-icon'))
})

test('mac app icon resolution normalizes executable paths to the .app bundle icon', async () => {
  resetIconResolverCache()
  const seenPaths = []

  const icon = await resolveIcon({
    kind: 'app',
    bundleId: '/Applications/Dia.app/Contents/MacOS/Dia',
    appName: 'Dia',
  }, {
    cacheDir: tempCacheDir(),
    platform: 'darwin',
    getMacBundleIconDataUrl: async (bundlePath) => {
      seenPaths.push(bundlePath)
      return bundlePath === '/Applications/Dia.app' ? sampleDataUrl('dia-app-icon') : null
    },
    getFileIconDataUrl: async (filePath) => {
      seenPaths.push(filePath)
      return null
    },
    getAppIdentity: () => null,
    resolveMacBundlePath: async () => '/Applications/Dia.app',
  })

  assert.equal(icon.source, 'app_bundle')
  assert.equal(icon.dataUrl, sampleDataUrl('dia-app-icon'))
  assert.deepEqual(seenPaths, ['/Applications/Dia.app'])
})

test('concurrent app icon resolution shares the same normalized cache identity', async () => {
  resetIconResolverCache()
  const cacheDir = tempCacheDir()
  let bundleLookups = 0

  const overrides = {
    cacheDir,
    platform: 'darwin' as const,
    getMacBundleIconDataUrl: async (bundlePath: string) => {
      bundleLookups += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return bundlePath === '/Applications/Dia.app' ? sampleDataUrl('dia-app-icon') : null
    },
    getFileIconDataUrl: async () => null,
    getAppIdentity: () => null,
    resolveMacBundlePath: async () => '/Applications/Dia.app',
  }

  const [withoutCanonicalId, withCanonicalId] = await Promise.all([
    resolveIcon({
      kind: 'app',
      bundleId: '/Applications/Dia.app/Contents/MacOS/Dia',
      appName: 'Dia',
    }, overrides),
    resolveIcon({
      kind: 'app',
      bundleId: '/Applications/Dia.app/Contents/MacOS/Dia',
      canonicalAppId: 'dia',
      appName: 'Dia',
    }, overrides),
  ])

  assert.equal(withoutCanonicalId.source, 'app_bundle')
  assert.equal(withCanonicalId.source, 'app_bundle')
  assert.equal(withoutCanonicalId.dataUrl, sampleDataUrl('dia-app-icon'))
  assert.equal(withCanonicalId.dataUrl, sampleDataUrl('dia-app-icon'))
  assert.equal(bundleLookups, 1)
})

test('site icon resolution prefers browser cache, then origin, then gated fallback', async () => {
  resetIconResolverCache()

  let originCalls = 0
  let fallbackCalls = 0
  const browserHit = await resolveIcon({
    kind: 'site',
    domain: 'github.com',
    pageUrl: 'https://github.com/openai/openai',
  }, {
    cacheDir: tempCacheDir(),
    getSiteIconFromBrowserCache: async () => sampleDataUrl('browser-cache-icon'),
    fetchSiteIconFromOrigin: async () => {
      originCalls += 1
      return sampleDataUrl('origin-icon')
    },
    fetchSiteFallbackIcon: async () => {
      fallbackCalls += 1
      return sampleDataUrl('fallback-icon')
    },
  })

  assert.equal(browserHit.source, 'browser_cache')
  assert.equal(browserHit.dataUrl, sampleDataUrl('browser-cache-icon'))
  assert.equal(originCalls, 0)
  assert.equal(fallbackCalls, 0)

  resetIconResolverCache()
  const originHit = await resolveIcon({
    kind: 'site',
    domain: 'linear.app',
    pageUrl: 'https://linear.app/openai/issue/123',
  }, {
    cacheDir: tempCacheDir(),
    getSiteIconFromBrowserCache: async () => null,
    fetchSiteIconFromOrigin: async (origin) => origin === 'https://linear.app'
      ? sampleDataUrl('origin-icon')
      : null,
    fetchSiteFallbackIcon: async () => sampleDataUrl('fallback-icon'),
  })

  assert.equal(originHit.source, 'site_origin')
  assert.equal(originHit.dataUrl, sampleDataUrl('origin-icon'))

  resetIconResolverCache()
  let gatedFallbackCalls = 0
  const fallbackHit = await resolveIcon({
    kind: 'site',
    domain: 'brandnew.example',
  }, {
    cacheDir: tempCacheDir(),
    settings: { allowThirdPartyWebsiteIconFallback: true },
    getSiteIconFromBrowserCache: async () => null,
    fetchSiteIconFromOrigin: async () => null,
    fetchSiteFallbackIcon: async () => {
      gatedFallbackCalls += 1
      return sampleDataUrl('fallback-icon')
    },
  })

  assert.equal(fallbackHit.source, 'site_fallback')
  assert.equal(fallbackHit.dataUrl, sampleDataUrl('fallback-icon'))
  assert.equal(gatedFallbackCalls, 1)

  resetIconResolverCache()
  gatedFallbackCalls = 0
  const noFallback = await resolveIcon({
    kind: 'site',
    pageUrl: 'not-a-valid-url',
  }, {
    cacheDir: tempCacheDir(),
    settings: { allowThirdPartyWebsiteIconFallback: false },
    getSiteIconFromBrowserCache: async () => null,
    fetchSiteIconFromOrigin: async () => null,
    fetchSiteFallbackIcon: async () => {
      gatedFallbackCalls += 1
      return sampleDataUrl('fallback-icon')
    },
  })

  assert.equal(noFallback.source, 'miss')
  assert.equal(noFallback.dataUrl, null)
  assert.equal(gatedFallbackCalls, 0)
})

test('site icon resolution reads Chromium favicons from Dia/Comet-style local profiles', async () => {
  resetIconResolverCache()
  const cacheDir = tempCacheDir()
  const diaProfileDir = path.join(cacheDir, 'Dia', 'User Data', 'Default')
  const faviconsPath = createChromiumFaviconsDb(diaProfileDir, [{
    pageUrl: 'https://chatgpt.com/c/example',
    iconId: 1,
    imageData: samplePngBytes(),
    width: 64,
  }])
  fs.writeFileSync(path.join(diaProfileDir, 'History'), '')

  const result = await resolveIcon({
    kind: 'site',
    domain: 'chatgpt.com',
  }, {
    cacheDir,
    getBrowserEntries: () => [{
      name: 'Dia',
      bundleId: 'company.thebrowser.dia',
      historyPath: path.join(diaProfileDir, 'History'),
      type: 'chromium',
    }],
    fetchSiteFallbackIcon: async () => null,
  })

  assert.equal(path.basename(faviconsPath), 'Favicons')
  assert.equal(result.source, 'browser_cache')
  assert.match(result.dataUrl ?? '', /^data:image\/png;base64,/)
})

test('site icon resolution falls back to manifest icons and sniffs bytes when MIME is missing', async () => {
  resetIconResolverCache()
  const originalFetch = global.fetch
  const pngBytes = samplePngBytes()

  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    if (url === 'https://app.example/favicon.ico' || url === 'https://app.example/favicon.svg' || url === 'https://app.example/apple-touch-icon.png' || url === 'https://app.example/apple-touch-icon-precomposed.png') {
      return new Response('missing', { status: 404 })
    }

    if (url === 'https://app.example') {
      return new Response('<html><head><link rel="manifest" href="/manifest.webmanifest"></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (url === 'https://app.example/manifest.webmanifest') {
      return new Response(JSON.stringify({
        icons: [
          { src: '/assets/icon-no-ext', sizes: '192x192' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/manifest+json' },
      })
    }

    if (url === 'https://app.example/assets/icon-no-ext') {
      return new Response(pngBytes, {
        status: 200,
        headers: {},
      })
    }

    return new Response('not found', { status: 404 })
  }) as typeof fetch

  try {
    const result = await resolveIcon({
      kind: 'site',
      domain: 'app.example',
    }, {
      cacheDir: tempCacheDir(),
      getBrowserEntries: () => [],
      settings: { allowThirdPartyWebsiteIconFallback: false },
    })

    assert.equal(result.source, 'site_origin')
    assert.match(result.dataUrl ?? '', /^data:image\/png;base64,/)
  } finally {
    global.fetch = originalFetch
  }
})

test('artifact icon resolution uses local file paths first and otherwise inherits the owning app icon', async () => {
  resetIconResolverCache()

  const fileArtifact = await resolveIcon({
    kind: 'artifact',
    artifactType: 'document',
    path: 'C:\\Docs\\brief.docx',
    title: 'brief.docx',
  }, {
    cacheDir: tempCacheDir(),
    getFileIconDataUrl: async (filePath) => filePath.endsWith('brief.docx') ? sampleDataUrl('doc-icon') : null,
  })

  assert.equal(fileArtifact.source, 'artifact_file')
  assert.equal(fileArtifact.dataUrl, sampleDataUrl('doc-icon'))

  resetIconResolverCache()
  const inheritedArtifact = await resolveIcon({
    kind: 'artifact',
    artifactType: 'document',
    canonicalAppId: 'writer',
    title: 'Meeting Notes',
  }, {
    cacheDir: tempCacheDir(),
    getFileIconDataUrl: async () => null,
    getAppIdentity: () => ({
      appInstanceId: 'C:\\Apps\\Writer\\writer.exe',
      bundleId: 'C:\\Apps\\Writer\\writer.exe',
      rawAppName: 'Writer',
      canonicalAppId: 'writer',
      displayName: 'Writer',
      defaultCategory: 'writing',
      firstSeenAt: 100,
      lastSeenAt: 200,
      metadata: {
        activeWindowIconBase64: Buffer.from('writer-live-icon', 'utf8').toString('base64'),
        activeWindowIconMime: 'image/png',
      },
    }),
  })

  assert.equal(inheritedArtifact.source, 'artifact_app')
  assert.match(inheritedArtifact.dataUrl ?? '', /^data:image\/png;base64,/)
})

test('window artifact icon resolution uses owner app metadata instead of the window title on Windows', async () => {
  resetIconResolverCache()

  const ownerBundleId = 'C:\\Apps\\Dia\\dia.exe'
  const inheritedArtifact = await resolveIcon({
    kind: 'artifact',
    artifactType: 'window',
    canonicalAppId: 'dia',
    ownerBundleId,
    ownerAppName: 'Dia',
    ownerAppInstanceId: ownerBundleId,
    title: 'NotebookLM',
  }, {
    cacheDir: tempCacheDir(),
    platform: 'win32',
    getFileIconDataUrl: async (filePath) => filePath === ownerBundleId ? sampleDataUrl('dia-owner-icon') : null,
    getAppIdentity: () => null,
    resolveWindowsUwpIcon: async () => null,
  })

  assert.equal(inheritedArtifact.source, 'artifact_app')
  assert.equal(inheritedArtifact.dataUrl, sampleDataUrl('dia-owner-icon'))
})
