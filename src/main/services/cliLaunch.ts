const POWERSHELL_PROXY_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$rawPayload = [Console]::In.ReadToEnd()',
  'if (-not $rawPayload) { throw "Missing CLI launch payload." }',
  '$payload = $rawPayload | ConvertFrom-Json',
  '$path = [string]$payload.executablePath',
  '$argList = @()',
  'if ($payload.args -is [System.Array]) { $argList = @($payload.args) }',
  'elseif ($null -ne $payload.args) { $argList = @([string]$payload.args) }',
  '& $path @argList',
  'exit $LASTEXITCODE',
].join('; ')

export interface CLIProcessSpec {
  command: string
  args: string[]
  shell: boolean
  usesJsonStdin: boolean
}

export function buildCLIProcessSpec(
  executablePath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): CLIProcessSpec {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executablePath)) {
    return {
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        POWERSHELL_PROXY_SCRIPT,
      ],
      shell: false,
      usesJsonStdin: true,
    }
  }

  return {
    command: executablePath,
    args,
    shell: false,
    usesJsonStdin: false,
  }
}

export function buildCLIProcessPayload(executablePath: string, args: string[]): string {
  return JSON.stringify({
    executablePath,
    args,
  })
}
