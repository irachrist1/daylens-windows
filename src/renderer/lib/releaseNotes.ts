function cleanReleaseLine(line: string): string {
  return line
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim()
}

export function extractReleaseHighlights(releaseNotesText: string | null, limit = 4): string[] {
  if (!releaseNotesText) return []

  const lines = releaseNotesText
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const bullets = lines
    .filter((line) => /^[-*]\s+/.test(line))
    .map(cleanReleaseLine)
    .filter(Boolean)

  if (bullets.length > 0) return bullets.slice(0, limit)

  return lines
    .filter((line) => !line.startsWith('#'))
    .filter((line) => !/^compare changes:/i.test(line))
    .map(cleanReleaseLine)
    .filter(Boolean)
    .slice(0, limit)
}
