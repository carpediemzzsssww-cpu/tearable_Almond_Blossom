# Cloth interaction references

[ripit](https://github.com/javeke/ripit) inspired the tension-and-release interaction in this iteration. Its [Verlet constraints](https://github.com/javeke/ripit/blob/master/src/sim/Constraint.ts) break when stretched past a threshold; its renderer draws a two-dimensional line mesh. The project is MIT licensed.

The almond curtain keeps its own three-dimensional cloth, linen material, lighting, and procedural blossoms. Its surface topology and occlusion must change together as fabric separates, and a torn edge must also release the shear and bending constraints that cross it. No ripit source code or assets are included.

The palette and painted surface were compared with the [Van Gogh Museum's Almond Blossom (1890)](https://www.vangoghmuseum.nl/en/collection/s0176V1962): layered blue-green, restrained grey-green and ochre branches, and warm white blossoms. The website uses procedural textures and geometry; the painting itself is not used as a background image.
