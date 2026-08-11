import { defineConfig, loadEnv } from 'vite'
import path from 'node:path'

const isStandalone = process.env.STANDALONE_BUILD === '1'
// Local .env supplies the analytics/crash keys for dev and local dist builds;
// CI sets them as real env vars, which win over the file.
const fileEnv = loadEnv(process.env.NODE_ENV || 'development', __dirname, '')
const env = (name: string): string => process.env[name] || fileEnv[name] || ''
const convexSiteUrl = JSON.stringify(
  env('DAYLENS_CONVEX_SITE_URL') || 'https://decisive-aardvark-847.convex.site',
)
// No hardcoded fallback keys — analytics requires an explicit POSTHOG_KEY env var.
// When the key is absent the analytics module is a no-op.
const posthogKey = JSON.stringify(env('POSTHOG_PROJECT_TOKEN') || env('POSTHOG_KEY'))
const posthogHost = JSON.stringify(env('POSTHOG_HOST'))
const sentryDsn = JSON.stringify(env('SENTRY_DSN'))
const billingApiUrl = JSON.stringify(env('DAYLENS_BILLING_API_URL'))
// JSON map of kid → base64 raw Ed25519 public key for entitlement-snapshot
// verification. Empty until a signing key is minted for the billing service;
// while empty the entitlement gate stays unarmed and legacy /v1/billing
// access governs.
const entitlementPublicKeys = JSON.stringify(env('DAYLENS_ENTITLEMENT_PUBLIC_KEYS') || '{}')

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@daylens/remote-contract': path.resolve(__dirname, 'packages/remote-contract/index.ts'),
    },
  },
  define: isStandalone
    ? {
        MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined',
        MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
        __DAYLENS_CONVEX_SITE_URL__: convexSiteUrl,
        __POSTHOG_KEY__: posthogKey,
        __POSTHOG_HOST__: posthogHost,
        __SENTRY_DSN__: sentryDsn,
        __DAYLENS_BILLING_API_URL__: billingApiUrl,
        __DAYLENS_ENTITLEMENT_PUBLIC_KEYS__: entitlementPublicKeys,
      }
    : {
        __DAYLENS_CONVEX_SITE_URL__: convexSiteUrl,
        __POSTHOG_KEY__: posthogKey,
        __POSTHOG_HOST__: posthogHost,
        __SENTRY_DSN__: sentryDsn,
        __DAYLENS_BILLING_API_URL__: billingApiUrl,
        __DAYLENS_ENTITLEMENT_PUBLIC_KEYS__: entitlementPublicKeys,
      },
  build: {
    // Build as Node (not browser) so node: builtins are not externalized
    ...(isStandalone && {
      outDir: path.resolve(__dirname, 'dist/main'),
      emptyOutDir: true,
      ssr: true,
    }),
    rollupOptions: {
      input: path.resolve(__dirname, 'src/main/index.ts'),
      // Native addons and electron itself must not be bundled.
      external: [
        'electron',
        'better-sqlite3',
        '@paymoapp/active-window',
        'keytar',
        'electron-updater',
        'ai',
        /^@ai-sdk\//,
        'exceljs',
        '@anthropic-ai/sdk',
        '@google/genai',
        'openai',
        'ws',
        'bufferutil',
        'utf-8-validate',
      ],
      output: {
        format: 'cjs',
        inlineDynamicImports: true,
        entryFileNames: 'main.js',
      },
    },
  },
})
