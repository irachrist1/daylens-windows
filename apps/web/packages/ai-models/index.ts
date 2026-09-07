export const MODEL_IDS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

export const DEFAULT_MODEL_ID: ModelId = "claude-haiku-4-5-20251001";

export const MODEL_OPTIONS: ReadonlyArray<{
  id: ModelId;
  label: string;
  hint: string;
}> = [
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    hint: "Most capable — slowest + most expensive",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "Strong quality, fast",
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    hint: "Default — fastest + cheapest for typical Daylens questions",
  },
];

export function isAllowedModel(candidate: unknown): candidate is ModelId {
  return (
    typeof candidate === "string" &&
    (MODEL_IDS as readonly string[]).includes(candidate)
  );
}
