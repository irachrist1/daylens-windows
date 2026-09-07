export function claudeDesktopConfigDisplayPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') return '%APPDATA%\\Claude\\claude_desktop_config.json'
  if (platform === 'linux') return '~/.config/Claude/claude_desktop_config.json'
  return '~/Library/Application Support/Claude/claude_desktop_config.json'
}

export function claudeCodeConfigDisplayPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') return '%USERPROFILE%\\.claude.json'
  return '~/.claude.json'
}

export function cursorMcpConfigDisplayPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') return '%USERPROFILE%\\.cursor\\mcp.json'
  return '~/.cursor/mcp.json'
}
