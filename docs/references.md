# Cloth interaction references

[ripit](https://github.com/javeke/ripit) inspired the tension-and-release interaction in this iteration. Its [Verlet constraints](https://github.com/javeke/ripit/blob/master/src/sim/Constraint.ts) break when stretched past a threshold; its renderer draws a two-dimensional line mesh. The project is MIT licensed.

The almond curtain keeps its own three-dimensional cloth, linen material, lighting, and procedural blossoms. Its surface topology and occlusion must change together as fabric separates, and a torn edge must also release the shear and bending constraints that cross it. No ripit source code or assets are included.
