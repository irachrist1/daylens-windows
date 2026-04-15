import type { ArtifactRef, OpenTarget } from '@shared/types'
import { ipc } from './ipc'

export async function openTarget(target: OpenTarget): Promise<void> {
  if (target.kind === 'external_url' && target.value) {
    ipc.shell.openExternal(target.value)
    return
  }

  if (target.kind === 'local_path' && target.value) {
    await ipc.shell.openPath(target.value)
  }
}

export async function openArtifact(artifact: Pick<ArtifactRef, 'openTarget'>): Promise<void> {
  await openTarget(artifact.openTarget)
}
