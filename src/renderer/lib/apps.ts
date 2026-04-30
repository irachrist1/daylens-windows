type AppIdentity = {
  bundleId: string
  appName: string
}

const APP_NAME_ALIASES: Record<string, string> = {
  snippingtool: 'Snipping Tool',
  fileexplorer: 'File Explorer',
  explorer: 'File Explorer',
  microsoftedge: 'Microsoft Edge',
  microsoftteams: 'Microsoft Teams',
  microsoftoutlook: 'Microsoft Outlook',
  microsoftexcel: 'Microsoft Excel',
  microsoftword: 'Microsoft Word',
  microsoftpowerpoint: 'Microsoft PowerPoint',
  excel: 'Microsoft Excel',
  word: 'Microsoft Word',
  powerpoint: 'Microsoft PowerPoint',
  outlook: 'Microsoft Outlook',
  teams: 'Microsoft Teams',
  winword: 'Microsoft Word',
  powerpnt: 'Microsoft PowerPoint',
  windowsterminal: 'Windows Terminal',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  cmd: 'Command Prompt',
  windowsshellexperiencehost: 'Windows Shell Experience Host',
  code: 'VS Code',
  visualstudiocode: 'VS Code',
  claude: 'Claude',
  whatsapp: 'WhatsApp',
  github: 'GitHub',
  githubdesktop: 'GitHub Desktop',
  chatgptatlas: 'ChatGPT',
  chatgptdesktop: 'ChatGPT',
  chatgpt: 'ChatGPT',
  onedrive: 'OneDrive',
  linkedin: 'LinkedIn',
  facetime: 'FaceTime',
  ticktick: 'TickTick',
  systemsettings: 'System Settings',
  daylenswindows: 'Daylens',
  daylens: 'Daylens',
  comet: 'Comet',
}

export interface BrandedAppIconSpec {
  label: string
  background: string
  foreground: string
}

function toTitleCase(value: string): string {
  return value
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

export function normalizeAppNameKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function formatDisplayAppName(rawName: string): string {
  const baseName = (rawName.split(/[\\/]/).pop() ?? rawName).trim()
  const stripped = baseName.replace(/\.(exe|app|lnk)$/i, '')
  const spaced = stripped
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const alias = APP_NAME_ALIASES[normalizeAppNameKey(spaced)]
  if (alias) return alias
  if (!spaced) return rawName
  return toTitleCase(spaced)
}

export function appInitials(rawName: string): string {
  return formatDisplayAppName(rawName)
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

export function brandedAppIconSpec(rawName: string, canonicalAppId?: string | null): BrandedAppIconSpec | null {
  const key = normalizeAppNameKey(`${canonicalAppId ?? ''} ${formatDisplayAppName(rawName)} ${rawName}`)
  if (key.includes('excel')) return { label: 'X', background: '#1f8f4d', foreground: '#ffffff' }
  if (key.includes('word') || key.includes('winword')) return { label: 'W', background: '#2b579a', foreground: '#ffffff' }
  if (key.includes('powerpoint') || key.includes('powerpnt')) return { label: 'P', background: '#c43e1c', foreground: '#ffffff' }
  if (key.includes('outlook')) return { label: 'O', background: '#0f6cbd', foreground: '#ffffff' }
  if (key.includes('teams')) return { label: 'T', background: '#5b5fc7', foreground: '#ffffff' }
  return null
}

export function buildAppBundleLookup(
  groups: Array<Array<AppIdentity | null | undefined>>,
): Map<string, string> {
  const lookup = new Map<string, string>()
  for (const group of groups) {
    for (const item of group) {
      if (!item?.bundleId || !item.appName) continue
      const key = normalizeAppNameKey(item.appName)
      if (key && !lookup.has(key)) lookup.set(key, item.bundleId)
    }
  }
  return lookup
}

export function resolveBundleIdForName(
  lookup: Map<string, string>,
  appName: string,
): string | null {
  return lookup.get(normalizeAppNameKey(appName)) ?? null
}
