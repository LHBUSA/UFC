# Atmosphere media

Original, re-encoded derivatives of permissively licensed photographs. No UFC,
Zuffa, TKO, ESPN or sportsbook marks are legible at the opacities used.

| File | Use | Source | Author | License |
|---|---|---|---|---|
| `ufc-cage-bg-1600.webp`, `ufc-cage-bg-960.webp` | global viewport-locked cage/arena atmosphere (`body::before`) | https://commons.wikimedia.org/wiki/File:BRAVE_Darius-7.jpg | Haribhagirath (2024) | CC0 1.0 (public domain dedication) |
| `ufc-fence-1400.webp` | fence texture behind fighter / event hero stages | https://commons.wikimedia.org/wiki/File:Mixed-martial_arts_fights_heat_up_Combat_Center_140620-M-ZM882-066.jpg | Lance Cpl. Paul S. Martinez, U.S. Marine Corps | Public domain (U.S. federal government work) |
| `voices/joe-rogan-660.webp` | Notable Voices homepage card (Joe Rogan) | https://commons.wikimedia.org/wiki/File:2026_Joe_Rogan_with_Donald_Trump_at_the_White_House_(cropped).jpg | The White House (2026) | Public domain (U.S. federal government work); derivative cropped to Joe Rogan alone |
| `voices/daniel-cormier-660.webp` | Notable Voices homepage card (Daniel Cormier) | https://commons.wikimedia.org/wiki/File:Daniel_Cormier_promoting_EA_UFC_5.jpg | Esfand (2023) | CC BY 3.0 — attribution printed on the card |
| `voices/dana-white-900.webp`, `voices/dana-white-660.webp` | Notable Voices card + profile hero (Dana White) | https://commons.wikimedia.org/wiki/File:U.S._Park_Police_Officers_meet_Dana_White_at_the_UFC_Freedom_250_Press_Conference_(27)_(cropped).jpg | Sgt. Christian Brown, U.S. Park Police (2026) | Public domain (U.S. federal government work); resized, no additional crop |

Derivatives were produced with sharp (`scripts/qa` has no build step for them;
regenerate from the originals if the crop changes): saturation reduced to
neutralise the stage lighting cast so PropBetEdge gold stays the only accent,
resized to 1600 / 960 / 1400 px wide, WebP q58–62.

Fighter portraits are a separate library (`ufc_images`, see `docs/images.md`).
