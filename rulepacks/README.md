# Rules packs

The app's engines are generic. Every table, price and threshold that comes from a rulebook is
kept in JSON "rules packs" and loaded when the server starts.

**This folder is deliberately empty in the public repository.** Tables transcribed from a rulebook
belong somewhere private: either drop pack folders in here on the machine that runs the server
(`.gitignore` keeps them out of commits), or keep them in your wiki vault under
`.traveller-ui/rulepacks/`, which the server reads as well.

## Layout

- Each sub-folder is one pack. `pack.json` names it (`id`, `name`, optional `version` and `note`);
  every other `*.json` file contributes one section, named after the file.
- Packs are layered: first the folders here in alphabetical order, then those in the wiki vault.
  A later pack only needs to list what it adds or changes. Lists whose rows carry an `id` or a
  `code` are merged row by row on that key; other lists are replaced whole.
- To add house rules or a supplement, create a new folder (for example `zz-house-rules`) with a
  `pack.json` and only the sections you want to override.

## Sections

| File | Section | Used for |
| --- | --- | --- |
| `world.json` | `world` | World profile digits, starports, bases, trade codes, world and star generation |
| `tasks.json` | `tasks` | Difficulties, effect bands, characteristic modifiers |
| `characters.json` | `characters` | Characteristics, skills and specialities, species, careers |
| `gear.json` | `gear` | Personal weapons, armour and weapon traits |
| `combat.json` | `combat` | Personal combat: actions, range bands, modifiers, cover, damage |
| `trade.json` | `trade` | Trade goods, price table, passengers, freight |
| `ships.json` | `ships` | Hulls, armour, drives, power plants, bridges, computers, sensors, software, weapons and mounts, fittings, crew, shipyards and stock designs |
| `space.json` | `space` | Space combat: range bands, crew duties and their actions, attack modifiers, critical hit locations and effects, missiles |

The exact shape of every section is documented by the TypeScript types in
`src/shared/rulepack.ts`. A section that is missing simply switches off the features that need it.

## Adding a ship part or a stock design

A fitting in `ships.json` says how it is sized (`unit`, `tons`, `hull` or `docking`) and what it
costs; the design engine does the rest. For example, a supplement could add:

```json
{
  "fittings": [
    { "id": "briefingRoom", "name": "Briefing room", "group": "systems", "size": "unit", "unitTons": 4, "unitCost": 500000, "note": "DM+1 to Tactics checks made with planning time." }
  ]
}
```

Stock designs are lists of parts in the same form the yard uses, so a design saved from the app
can be turned into a stock design by copying its parts.
