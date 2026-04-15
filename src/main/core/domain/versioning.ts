import type { DerivedStateComponent } from '@shared/core'

export const DERIVED_STATE_COMPONENT_VERSIONS: Record<DerivedStateComponent, string> = {
  app_normalization: 'app-normalization.v2',
  inference_pipeline: 'daylens-inference.v1',
  projection_contracts: 'daylens-projections.v1',
  assistant_context: 'daylens-assistant.v1',
}

export const DERIVED_STATE_RESET_COMPONENTS: ReadonlySet<DerivedStateComponent> = new Set([
  'app_normalization',
  'inference_pipeline',
  'projection_contracts',
])
