// Cut the upper stage (Ship) out of "SpaceX Starship Ship 24 & Booster 7 V4" by clarence365 (Sketchfab, CC-BY-4.0),
// drop Super Heavy, merge by material, simplify to ~100k triangles and quantize for the web.
//   node tools/build_starship_model.mjs <source.glb>  ->  public/models/starship_ship.gltf.json
// (a single-file glTF with embedded buffers: the artifact host serves .json but not .glb)
// The model stays in its own units (Y up, nose +Y). starshipModel.ts scales and places it:
// hull axis at (x, z) = (0.037, 0.031), hull radius 0.86 units (= 4.5 m), base (leg feet) at y = 12.32.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, simplify, flatten, join, quantize, getBounds } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
for (const n of root.listNodes()) {
  if ((n.getName() || '').startsWith('Superheavy')) { const rm = (x) => { x.listChildren().forEach(rm); x.dispose(); }; rm(n); }
}
await doc.transform(prune());
const b = getBounds(root.listScenes()[0]);
console.log('ship bounds', b.min, b.max);
await MeshoptSimplifier.ready;
await doc.transform(
  dedup(), flatten(), join(), weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.0008 }),
  prune(), dedup(),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
);
const { json, resources } = await io.writeJSON(doc, { format: 'json' });
const mime = (uri) => uri.endsWith('.png') ? 'image/png' : uri.endsWith('.jpg') || uri.endsWith('.jpeg') ? 'image/jpeg' : uri.endsWith('.webp') ? 'image/webp' : 'application/octet-stream';
for (const list of [json.buffers ?? [], json.images ?? []]) for (const e of list) {
  if (e.uri && resources[e.uri]) e.uri = `data:${mime(e.uri)};base64,${Buffer.from(resources[e.uri]).toString('base64')}`;
}
(await import('node:fs')).writeFileSync('public/models/starship_ship.gltf.json', JSON.stringify(json));
