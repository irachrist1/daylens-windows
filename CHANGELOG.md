# Changelog

## v1.0.27 - 2026-04-19

### Added
- Snapshot v2 exports now include recap summaries, focus score v2 breakdowns, work blocks, standout artifacts, entity rollups, and Linux as a first-class snapshot platform for downstream Daylens surfaces
- AI thread naming now uses deterministic intent heuristics for reports, focus flows, and entity questions instead of defaulting to generic prompt fragments

### Changed
- Monthly recap comparisons now use matched elapsed-day windows so longer months do not invent a gain over shorter previous months
- Recap workstream rankings now keep dominant unnamed work visible when attribution is still weak instead of overstating named coverage

### Fixed
- Weak AI thread titles now upgrade after the first grounded answer resolves intent, so chats do not stay stuck on `New chat` or filler-led snippets

## v1.0.26 - 2026-04-19

### Added
- Persistent AI threads and artifact storage inside the AI surface
- A deterministic daily, weekly, and monthly recap card inside the AI surface
- Install-flow, onboarding, and shell polish across the shared desktop app

### Changed
- Cross-platform parity guidance now reflects the unified desktop repo more honestly across macOS, Windows, and Linux

### Fixed
- Shared release notes now keep updater metadata filenames consistent across platform downloads
