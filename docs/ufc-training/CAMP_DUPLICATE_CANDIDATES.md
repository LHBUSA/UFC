# Camp duplicate candidates (generated 2026-09-26)

365 camps. Nothing is merged by name automatically; this is the review list.

## Tier 1: same normalized name, different ESPN ids (1)

- `10th Planet Jiu Jitsu` (espn 8147, 2 fighters) / `10th Planet Jiu-Jitsu` (espn 3448, 3 fighters)

## Tier 2: same name after dropping generic words (MMA, Team, Academy, Gym, FC, ...) (6)

- **ludus**: `Team Ludus` (espn 13290, 1 fighters) / `Ludus MMA` (espn 14093, 1 fighters)
- **victory**: `Victory MMA` (espn 123, 1 fighters) / `Team Victory` (espn 14033, 1 fighters)
- **renegade**: `Renegade MMA` (espn 6867, 2 fighters) / `Renegade Jiu-Jitsu` (espn 6967, 1 fighters)
- **akhmat**: `Akhmat Fight Team` (espn 5782, 1 fighters) / `Fight Club Akhmat` (espn 3366, 1 fighters)
- **cobra**: `Team Cobra MMA` (espn 14715, 1 fighters) / `Cobra Team MMA` (espn 14805, 1 fighters)
- **tiger**: `Tiger Muay Thai` (espn 966, 3 fighters) / `Tiger Gym` (espn 13868, 1 fighters)

## Decisions (2026-09-26)

- **Merged:** `10th Planet Jiu Jitsu` (espn 8147) -> `10th Planet Jiu-Jitsu` (espn 3448). Identical name, no branch qualifier. Merged with `enrich.mjs merge-camp` (migration 033 canonical pointer); both ESPN ids are kept, and 5 fighters now resolve to one camp.
- **Not merged. Different gyms:** Tiger Muay Thai vs Tiger Gym; Victory MMA vs Team Victory; Renegade MMA vs Renegade Jiu-Jitsu (MMA vs BJJ school).
- **Not merged. Plausible but unproven:** Akhmat Fight Team vs Fight Club Akhmat; Team Cobra MMA vs Cobra Team MMA; Team Ludus vs Ludus MMA. These need a source that shows they are one gym before merging.

Regenerate the candidate list with `node scripts/training/camp_duplicates.mjs`.
