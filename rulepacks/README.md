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

A fitting in `ships.json` says how it is sized and what it costs; the design engine does the rest.
The sizes are `unit` (so many of a fixed size), `tons` (a tonnage you choose), `hull` (a share of
the hull), `docking` and `capacity` (sized from what it serves: a craft, a cargo, a drop tank) and
`plant` (a share of the power plant). Fittings can also take hardpoints, need gunners, add
protection, generate or store power, exclude one another and be limited to hulls of a certain size. For example, a supplement could add:

```json
{
  "fittings": [
    { "id": "briefingRoom", "name": "Briefing room", "group": "systems", "size": "unit", "unitTons": 4, "unitCost": 500000, "note": "DM+1 to Tactics checks made with planning time." }
  ]
}
```

A supplement pack can go a good deal further without any change to the app: new hull forms
(with armour multipliers, or only part of their tonnage usable), hull types, armour priced per ton,
reaction drives, drive and fuel-tank options, power plants with their own fuel appetite, computer
cores, bridge, sensor and mount options, bays and spinal mounts, grades of build quality with
advantages and drawbacks, and a fuller crew table for large and military ships. All of it is
described field by field in `src/shared/rulepack.ts`.

Stock designs are lists of parts in the same form the yard uses, so a design saved from the app
can be turned into a stock design by copying its parts.
