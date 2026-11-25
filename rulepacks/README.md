# Rules packs

The app's engines are generic. Every table, price and threshold that comes from a rulebook is
kept in JSON "rules packs" in this folder and loaded when the server starts.

- Each sub-folder is one pack. `pack.json` names it; every other `*.json` file contributes one
  section (`world.json` → `world`, `trade.json` → `trade`, …).
- Packs are layered in alphabetical order of folder name, so a later pack only needs to list what
  it adds or changes. Rows that carry a `code` or `id` are merged by that key.
- To add house rules or a supplement, create a new folder (for example `zz-house-rules`) with a
  `pack.json` and only the sections you want to override.

The shapes are documented in `src/shared/rulepack.ts`.
