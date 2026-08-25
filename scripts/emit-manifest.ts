// Print Territory's Coworld manifest template to stdout. The committed
// `coworld_manifest_template.json` at the repo root is exactly this output — a
// test asserts they are equal, so the file is GENERATED and never hand-edited.
import { buildTerritoryManifest } from "../src/game/coworld.js";

console.log(JSON.stringify(buildTerritoryManifest(), null, 2));
