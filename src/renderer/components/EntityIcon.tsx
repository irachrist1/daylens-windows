import type { ArtifactRef } from '@shared/types'
import { useEffect, useState } from 'react'
import AppIcon from './AppIcon'
import { normalizeAppNameKey } from '../lib/apps'
import { useResolvedIcon } from '../hooks/useResolvedIcon'

type TileSpec = {
  label: string
  background: string
  color: string
}

const DOMAIN_SPECS: Array<{ pattern: RegExp; spec: TileSpec }> = [
  { pattern: /github\./i, spec: { label: 'GH', background: '#111827', color: '#f9fafb' } },
  { pattern: /(chatgpt|openai)\./i, spec: { label: 'AI', background: '#0f172a', color: '#7dd3fc' } },
  { pattern: /(claude|anthropic)\./i, spec: { label: 'CL', background: '#3f2d21', color: '#fcd34d' } },
  { pattern: /docs\.google\./i, spec: { label: 'GD', background: '#1d4ed8', color: '#eff6ff' } },
  { pattern: /drive\.google\./i, spec: { label: 'DR', background: '#0f766e', color: '#ecfeff' } },
  { pattern: /figma\./i, spec: { label: 'FG', background: '#111827', color: '#f472b6' } },
  { pattern: /notion\./i, spec: { label: 'N', background: '#111827', color: '#f8fafc' } },
  { pattern: /linear\./i, spec: { label: 'L', background: '#312e81', color: '#e0e7ff' } },
  { pattern: /slack\./i, spec: { label: 'SL', background: '#4a154b', color: '#f5d0fe' } },
  { pattern: /youtube\./i, spec: { label: 'YT', background: '#991b1b', color: '#fee2e2' } },
  { pattern: /x\.com|twitter\./i, spec: { label: 'X', background: '#111827', color: '#f3f4f6' } },
]

const EXTENSION_SPECS: Record<string, TileSpec> = {
  md: { label: 'MD', background: '#1f2937', color: '#e5e7eb' },
  txt: { label: 'TXT', background: '#334155', color: '#e2e8f0' },
  pdf: { label: 'PDF', background: '#7f1d1d', color: '#fee2e2' },
  doc: { label: 'DOC', background: '#1d4ed8', color: '#dbeafe' },
  docx: { label: 'DOC', background: '#1d4ed8', color: '#dbeafe' },
  xls: { label: 'XLS', background: '#166534', color: '#dcfce7' },
  xlsx: { label: 'XLS', background: '#166534', color: '#dcfce7' },
  ppt: { label: 'PPT', background: '#9a3412', color: '#ffedd5' },
  pptx: { label: 'PPT', background: '#9a3412', color: '#ffedd5' },
  ts: { label: 'TS', background: '#1e3a8a', color: '#dbeafe' },
  tsx: { label: 'TS', background: '#1e3a8a', color: '#dbeafe' },
  js: { label: 'JS', background: '#713f12', color: '#fef3c7' },
  jsx: { label: 'JS', background: '#713f12', color: '#fef3c7' },
  json: { label: '{}', background: '#374151', color: '#e5e7eb' },
  csv: { label: 'CSV', background: '#14532d', color: '#dcfce7' },
  png: { label: 'IMG', background: '#7c2d12', color: '#ffedd5' },
  jpg: { label: 'IMG', background: '#7c2d12', color: '#ffedd5' },
  jpeg: { label: 'IMG', background: '#7c2d12', color: '#ffedd5' },
}

function domainTile(domain: string | null | undefined): TileSpec {
  const value = (domain ?? '').trim()
  if (!value) return { label: 'WB', background: '#334155', color: '#e2e8f0' }

  for (const entry of DOMAIN_SPECS) {
    if (entry.pattern.test(value)) return entry.spec
  }

  const clean = value.replace(/^www\./i, '')
  return {
    label: clean.slice(0, 2).toUpperCase(),
    background: '#334155',
    color: '#e2e8f0',
  }
}

function extensionFromPath(pathValue: string | null | undefined): string | null {
  if (!pathValue) return null
  const match = pathValue.toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] ?? null
}

function artifactTile(
  artifactType: ArtifactRef['artifactType'] | undefined,
  title: string | null | undefined,
  pathValue?: string | null,
  domain?: string | null,
): TileSpec {
  const extension = extensionFromPath(pathValue)
  if (extension && EXTENSION_SPECS[extension]) return EXTENSION_SPECS[extension]

  if (artifactType === 'page') return domainTile(domain)
  if (artifactType === 'repo') return { label: 'GH', background: '#111827', color: '#f9fafb' }
  if (artifactType === 'project') return { label: 'PR', background: '#1e3a8a', color: '#dbeafe' }
  if (artifactType === 'document') return { label: 'DOC', background: '#1d4ed8', color: '#dbeafe' }
  if (artifactType === 'window') return { label: 'WN', background: '#374151', color: '#f3f4f6' }
  if (artifactType === 'domain') return domainTile(domain)

  const fallback = (title ?? '').trim()
  return {
    label: fallback ? fallback.slice(0, 2).toUpperCase() : 'IT',
    background: '#334155',
    color: '#e2e8f0',
  }
}

function tile(spec: TileSpec, size: number, title: string) {
  return (
    <div
      title={title}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(8, Math.round(size * 0.28)),
        background: spec.background,
        color: spec.color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size <= 20 ? 9 : size <= 28 ? 10 : 11,
        fontWeight: 800,
        letterSpacing: '-0.02em',
        flexShrink: 0,
      }}
    >
      {spec.label}
    </div>
  )
}

export default function EntityIcon({
  appName,
  appInstanceId,
  bundleId,
  canonicalAppId,
  domain,
  url,
  artifactType,
  title,
  path,
  ownerBundleId,
  ownerAppName,
  ownerAppInstanceId,
  size = 28,
}: {
  appName?: string | null
  appInstanceId?: string | null
  bundleId?: string | null
  canonicalAppId?: string | null
  domain?: string | null
  url?: string | null
  artifactType?: ArtifactRef['artifactType']
  title?: string | null
  path?: string | null
  ownerBundleId?: string | null
  ownerAppName?: string | null
  ownerAppInstanceId?: string | null
  size?: number
}) {
  const [didError, setDidError] = useState(false)
  const resolvedArtifactIcon = useResolvedIcon(
    appName
      ? null
      : (artifactType || path || domain || canonicalAppId)
        ? {
            kind: 'artifact',
            artifactType,
            canonicalAppId,
            ownerBundleId,
            ownerAppName,
            ownerAppInstanceId,
            path,
            url,
            host: domain,
            title,
          }
        : null,
  )

  useEffect(() => {
    setDidError(false)
  }, [artifactType, canonicalAppId, domain, ownerAppInstanceId, ownerAppName, ownerBundleId, path, title, url])

  if (appName) {
    const key = normalizeAppNameKey(appName)
    const color = key.includes('claude') || key.includes('dia')
      ? '#f59e0b'
      : key.includes('codex') || key.includes('chatgpt')
        ? '#38bdf8'
        : key.includes('code') || key.includes('cursor') || key.includes('ghostty')
          ? '#5b8cff'
          : 'var(--color-primary)'

    return (
      <AppIcon
        appInstanceId={appInstanceId}
        bundleId={bundleId}
        canonicalAppId={canonicalAppId}
        appName={appName}
        size={size}
        fontSize={size <= 22 ? 9 : 10}
        color={color}
      />
    )
  }

  if (artifactType || path || domain || canonicalAppId) {
    const fallbackTile = tile(
      artifactTile(artifactType, title, path, domain),
      size,
      title ?? domain ?? 'Artifact',
    )
    const iconUrl = didError ? null : resolvedArtifactIcon?.dataUrl ?? null

    if (iconUrl) {
      return (
        <img
          src={iconUrl}
          alt={title ?? domain ?? 'Artifact'}
          width={size}
          height={size}
          style={{
            width: size,
            height: size,
            display: 'block',
            objectFit: 'cover',
            borderRadius: Math.max(8, Math.round(size * 0.28)),
            flexShrink: 0,
          }}
          onError={() => {
            console.warn('[icons] artifact icon failed to render', {
              artifactType: artifactType ?? null,
              canonicalAppId: canonicalAppId ?? null,
              path: path ?? null,
              domain: domain ?? null,
              url: url ?? null,
              title: title ?? null,
              source: resolvedArtifactIcon?.source ?? 'miss',
              cacheKey: resolvedArtifactIcon?.cacheKey ?? null,
            })
            setDidError(true)
          }}
        />
      )
    }

    return fallbackTile
  }

  return tile({ label: 'DL', background: '#334155', color: '#e2e8f0' }, size, 'Daylens')
}
