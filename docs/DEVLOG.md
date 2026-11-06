# Development log

How the piece got from a brief to a tearable curtain, kept so the project can be rebuilt or extended without the original working folder.

## The brief

A natural, refined, skeuomorphic web interaction with Van Gogh's *Almond Blossom* palette and an "aha" moment. The first screen is a hanging cloth with real folds and soft shadows. Pulling it down makes branches emerge and spread: distance controls how much opens, speed controls the rhythm (slow = gentle, fast = a brief wave). On release the cloth springs back with damping and the branches stay and sway. No sprays, no full-screen particles, no figures or UI. It must work with mouse and touch and stay smooth on phones.

## v1 — a pouch on the wall (archived in `archive/v1-pouch/`)

A linen pouch hung on two nails. Pulling the cloth dropped the hem and almond branches unfolded out of the mouth. What it established and later versions kept:

- Verlet cloth with soft anchors: the hem and seams are springs, not pins, so a hard pull can open the mouth.
- Branches as chains of headings (in-plane angle + pitch), integrated from the base each frame, with a few damped sway modes per branch.
- Emergence driven by a second-order spring whose damping depends on pull speed. Slow pulls are critically damped; fast pulls are underdamped, which makes the "flower wave".
- Front/back occlusion by tracking whether a node has cleared the cloth. Before that it is clamped behind the cloth, after that it can only hang in front.
- Procedural almond blossoms: five cupped petals, stamens, sepals, buds and young leaves, all instanced geometry with canvas textures.

## v2 — the page is the cloth

A second reference showed what mattered most: flowers appearing gradually along the edge of the opening. The cloth became the whole page.

- **Backlit linen.** Each frame the tree is rendered black into a small mipmapped render target. The linen shader samples it in screen space and dims its own emissive glow there, so branch shadows show through the weave before anything is revealed.
- **The hem follows the hand.** Clips hold the hem's height but barely hold its x, like rings sliding on a rod. Near the hand their targets move down with the pull, so the V deepens and widens with distance. Each column remembers 75% of its deepest dip, so the curtain springs back but keeps the shape you made.
- **Reveal, then bloom.** Visibility is decided in screen space: a point is projected onto the cloth plane along the camera ray before the cloth height field is queried. Each flower waits a short random delay after it is revealed, then unfurls with an ease-out-back and a quarter twist. Twigs that were pressed flat release on a spring with overshoot.
- **Petals that land.** A few petals fall on fast pulls, drift forward over the hem, and stick to the nearest cloth particle when they touch the linen.

## v3 — tearing (inspired by ripit's constraint breaking)

- `tear-topology.ts` splits the cloth for real. Vertices along a tear are duplicated per triangle fan, and the structural, shear and bending constraints crossing the cut are removed. Triangles and the height field are updated in the same step. Deleting only rendered faces, or only constraints, leaves either invisible walls or floating seams.
- A gentle pull gathers; past about 0.18 of the cloth height, a tear runs along the hem into a flap. Pulling the flap sideways detaches it. Scraps fall, leave the screen, and are recycled.
- Budgets: at most six new tears and 768 extra particles. Duplicated particles keep old indices stable.
- Torn edges get sparse loose fibres of varying length. Grabbing needs a ray hit on a visible triangle, so you cannot grab cloth through the sky.

## v4 — smooth surface without intersections

- `cloth-surface.ts` subdivides the physics mesh once (Catmull–Clark) into a smooth display surface. The torn sides are never welded back together.
- Flaps and scraps collide with the main curtain, first on the physics mesh, then again on the subdivided display surface, because smoothing can create new intersections. Normals, fibres, the height field and shadows all read that final surface.
- `scripts/verify-contact.mjs` checks this independently with a triangle depth raster on the display surface, not just the physics mesh.

## Mini-tool build

A separate build (`vite.minitool.config.ts`, `src/minitool.ts`) packages the piece for a sandboxed in-app container. It adds a minimal reset icon in the bottom-left safe area, a tighter geometry and render budget, CPU-driven quality steps, WebGL context-loss recovery, and a draggable Canvas 2D fallback.

## Verification

All checks drive a local Chrome through Playwright with real pointer input (CDP touch for phone sizes):

- `npm run verify`: initial, peek, half, fast, full, released and second-pull states at 1440×900 and 390×844.
- `scripts/verify-tearing.mjs`: a light pull does not tear, a deep pull starts a tear, a sideways tug detaches the flap, scraps are recycled, and repeated tearing stays within budget.
- `scripts/verify-contact.mjs`: 980 frames per size of folding, kneading and re-grabbing; zero penetration on both the physics mesh and the display-surface raster.

Measured on an M2 MacBook Air in Chrome: about 60 fps at DPR 1 at both sizes. This was not tested on real iPhone or Android hardware or in Safari. The collision handling covers different cloth layers touching, not general self-collision of one continuous flap.
