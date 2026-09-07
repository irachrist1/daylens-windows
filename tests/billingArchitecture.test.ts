import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('billing backend stores usage metadata, not prompts or answers', () => {
  const schema = fs.readFileSync(path.join(root, 'services/billing/schema.sql'), 'utf8')
  const usageTable = schema.match(/CREATE TABLE IF NOT EXISTS billing_usage \(([\s\S]*?)\);/)?.[1] ?? ''
  assert.match(schema, /installation_hash TEXT NOT NULL UNIQUE/)
  assert.match(usageTable, /input_tokens BIGINT/)
  assert.match(usageTable, /cost_micros BIGINT NOT NULL/)
  assert.doesNotMatch(usageTable, /\b(prompt|answer|content|message)\b/i)
})

test('LiteLLM is configured not to retain message content', () => {
  const config = fs.readFileSync(path.join(root, 'services/billing/litellm-config.yaml'), 'utf8')
  assert.match(config, /turn_off_message_logging:\s*true/)
  assert.match(config, /redact_user_api_key_info:\s*true/)
})

test('billing service source is valid JavaScript and includes both Rwanda payment rails', () => {
  const serverPath = path.join(root, 'services/billing/src/server.mjs')
  const checked = spawnSync(process.execPath, ['--check', serverPath], { encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stderr)
  const source = fs.readFileSync(serverPath, 'utf8')
  assert.match(source, /POLAR_API_BASE_URL/)
  assert.match(source, /FLUTTERWAVE_API_BASE_URL/)
  assert.match(source, /payment_options:\s*'mobilemoneyrwanda'/)
  assert.match(source, /verifyFlutterwaveTransaction/)
  assert.match(source, /customer-sessions/)
})

test('billing backend records payment intents and retryable webhook processing', () => {
  const schema = fs.readFileSync(path.join(root, 'services/billing/schema.sql'), 'utf8')
  const server = fs.readFileSync(path.join(root, 'services/billing/src/server.mjs'), 'utf8')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS billing_payment_intents/)
  assert.match(schema, /processed_at TIMESTAMPTZ/)
  assert.match(server, /rememberPaymentEvent/)
  assert.match(server, /processed_at FROM billing_payment_events/)
})

test('managed billing reserves spend before provider I/O and settles it atomically', () => {
  const schema = fs.readFileSync(path.join(root, 'services/billing/schema.sql'), 'utf8')
  const server = fs.readFileSync(path.join(root, 'services/billing/src/server.mjs'), 'utf8')
  assert.match(schema, /spend_reserved_micros BIGINT NOT NULL DEFAULT 0/)
  assert.match(schema, /spend_reserved_until TIMESTAMPTZ/)
  const reserve = server.indexOf('async function reserveManagedSpend')
  const reserveCommit = server.indexOf("await client.query('COMMIT')", reserve)
  const provider = server.indexOf("fetch(`${litellmUrl}/chat/completions`")
  assert.ok(reserve >= 0 && reserveCommit > reserve && provider > reserveCommit)
  assert.match(server, /costMicros > amountMicros/)
})

test('Intercom identity is derived by the billing server, never chosen by the desktop', () => {
  const server = fs.readFileSync(path.join(root, 'services/billing/src/server.mjs'), 'utf8')
  const desktop = fs.readFileSync(path.join(root, 'src/main/services/billing.ts'), 'utf8')
  const handler = server.match(/async function intercomUserHash[\s\S]*?\n}/)?.[0] ?? ''
  assert.match(handler, /const userId = account\.id/)
  assert.doesNotMatch(handler, /payload\.userId|intercom_user_id/)
  assert.match(desktop, /body: '\{\}'/)
})

test('desktop keeps own-key access ahead of managed access', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/services/billing.ts'), 'utf8')
  const ownKeyCheck = source.indexOf('selectedOwnKeyProvider')
  const managedSession = source.indexOf("'/v1/ai/session'")
  assert.ok(ownKeyCheck >= 0)
  assert.ok(managedSession > ownKeyCheck)
  assert.match(source, /Calls go straight to your provider/)
})

test('release builds inject DAYLENS_BILLING_API_URL into the main bundle', () => {
  const viteConfig = fs.readFileSync(path.join(root, 'vite.main.config.ts'), 'utf8')
  assert.match(viteConfig, /env\('DAYLENS_BILLING_API_URL'\)/)
  assert.match(viteConfig, /__DAYLENS_BILLING_API_URL__:\s*billingApiUrl/)

  for (const workflow of ['release-macos.yml', 'release-linux.yml', 'release-windows.yml', 'release-windows-store.yml']) {
    const source = fs.readFileSync(path.join(root, '.github/workflows', workflow), 'utf8')
    assert.match(source, /DAYLENS_BILLING_API_URL:\s*\$\{\{ secrets\.DAYLENS_BILLING_API_URL \}\}/, workflow)
  }
})

test('subscribe affordances are gated by real managed billing availability', () => {
  const onboarding = fs.readFileSync(path.join(root, 'src/renderer/views/Onboarding.tsx'), 'utf8')
  const settings = fs.readFileSync(path.join(root, 'src/renderer/views/Settings.tsx'), 'utf8')
  assert.match(onboarding, /billing\.mode !== 'unavailable'/)
  assert.match(onboarding, /openCheckout\(\)/)
  assert.doesNotMatch(onboarding, /\$5 \/ month/)
  assert.match(onboarding, /\$5 once/)
  assert.match(settings, /access\?\.checkoutAvailable/)
  assert.match(settings, /createPolarCheckout\('settings'\)/)
})

test('BYOK CLI providers include Claude, ChatGPT, and Gemini local tools', () => {
  const catalog = fs.readFileSync(path.join(root, 'src/renderer/lib/aiProvider.ts'), 'utf8')
  const connector = fs.readFileSync(path.join(root, 'src/renderer/components/ConnectAI.tsx'), 'utf8')
  const service = fs.readFileSync(path.join(root, 'src/main/jobs/aiService.ts'), 'utf8')

  assert.match(catalog, /'claude-cli'/)
  assert.match(catalog, /'chatgpt-cli'/)
  assert.match(catalog, /'gemini-cli'/)
  assert.match(connector, /CLI_PROVIDERS/)
  assert.match(connector, /from '@shared\/aiProviderState'/)
  const shared = fs.readFileSync(path.join(root, 'src/shared/aiProviderState.ts'), 'utf8')
  assert.match(shared, /'claude-cli'/)
  assert.match(shared, /'chatgpt-cli'/)
  assert.match(shared, /'gemini-cli'/)
  assert.match(shared, /'codex-cli'/)
  assert.match(service, /resolveCLIToolPath\('claude'\)/)
  assert.match(service, /resolveCLIToolPath\('chatgpt'\)/)
  assert.match(service, /resolveCLIToolPath\('gemini'\)/)
  assert.match(service, /child\.stdin\?\.end\(prompt\)/)
})

test('billing service ships Railway deployment config', () => {
  const billingDockerfile = fs.readFileSync(path.join(root, 'services/billing/Dockerfile'), 'utf8')
  const billingRailway = fs.readFileSync(path.join(root, 'services/billing/railway.json'), 'utf8')
  const litellmDockerfile = fs.readFileSync(path.join(root, 'services/billing/litellm/Dockerfile'), 'utf8')
  const litellmRailway = fs.readFileSync(path.join(root, 'services/billing/litellm/railway.json'), 'utf8')
  assert.match(billingDockerfile, /CMD \["node", "src\/server\.mjs"\]/)
  assert.match(billingRailway, /"healthcheckPath": "\/health"/)
  assert.match(litellmDockerfile, /ghcr\.io\/berriai\/litellm/)
  assert.match(litellmRailway, /"builder": "DOCKERFILE"/)
})
