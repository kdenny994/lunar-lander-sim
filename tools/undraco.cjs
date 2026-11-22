// Decode the model's Draco-compressed meshes offline so browsers never need a Draco decoder.
// Usage: node tools/undraco.cjs data-raw/apollo_lm.glb public/models/apollo_lm.gltf.json
const fs = require('fs');
const path = require('path');
const os = require('os');
// three's package is "type": "module", so copy the UMD decoder to a .cjs file before requiring it.
const tmpDecoder = path.join(os.tmpdir(), 'draco_decoder_' + process.pid + '.cjs');
fs.copyFileSync(path.join(__dirname, '../node_modules/three/examples/jsm/libs/draco/draco_decoder.js'), tmpDecoder);
const DracoDecoderModule = require(tmpDecoder);
(async () => {
  const [inp, out] = process.argv.slice(2);
  const d = fs.readFileSync(inp);
  const jl = d.readUInt32LE(12);
  const j = JSON.parse(d.subarray(20, 20 + jl).toString());
  const off = 20 + jl, bl = d.readUInt32LE(off);
  const bin = d.subarray(off + 8, off + 8 + bl);
  const draco = await DracoDecoderModule();
  const chunks = [Buffer.from(bin)];
  let len = bin.length;
  const push = (buf) => { const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); len += pad; } const o = len; chunks.push(buf); len += buf.length; return o; };
  const views = j.bufferViews;
  for (const mesh of j.meshes) for (const prim of mesh.primitives) {
    const ext = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
    if (!ext) continue;
    const bv = views[ext.bufferView];
    const src = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const decoder = new draco.Decoder();
    const m = new draco.Mesh();
    const status = decoder.DecodeArrayToMesh(new Int8Array(src.buffer, src.byteOffset, src.byteLength), src.byteLength, m);
    if (!status.ok()) throw new Error(status.error_msg());
    const np = m.num_points();
    for (const [name, uid] of Object.entries(ext.attributes)) {
      const attr = decoder.GetAttributeByUniqueId(m, uid);
      const nc = attr.num_components();
      const n = np * nc, bytes = n * 4;
      const ptr = draco._malloc(bytes);
      decoder.GetAttributeDataArrayForAllPoints(m, attr, draco.DT_FLOAT32, bytes, ptr);
      const arr = new Float32Array(draco.HEAPF32.buffer, ptr, n).slice();
      draco._free(ptr);
      const acc = j.accessors[prim.attributes[name]];
      views.push({ buffer: 0, byteOffset: push(Buffer.from(arr.buffer)), byteLength: bytes });
      Object.assign(acc, { bufferView: views.length - 1, byteOffset: 0, componentType: 5126, count: np });
    }
    const nf = m.num_faces(), ni = nf * 3, ib = ni * 4;
    const ptr = draco._malloc(ib);
    decoder.GetTrianglesUInt32Array(m, ib, ptr);
    const idx = new Uint32Array(draco.HEAPU32.buffer, ptr, ni).slice();
    draco._free(ptr);
    views.push({ buffer: 0, byteOffset: push(Buffer.from(idx.buffer)), byteLength: ib });
    Object.assign(j.accessors[prim.indices], { bufferView: views.length - 1, byteOffset: 0, componentType: 5125, count: ni });
    delete prim.extensions.KHR_draco_mesh_compression;
    if (!Object.keys(prim.extensions).length) delete prim.extensions;
    draco.destroy(m); draco.destroy(decoder);
  }
  const strip = (a) => a && a.filter((e) => e !== 'KHR_draco_mesh_compression');
  j.extensionsUsed = strip(j.extensionsUsed); j.extensionsRequired = strip(j.extensionsRequired);
  if (j.extensionsRequired && !j.extensionsRequired.length) delete j.extensionsRequired;
  const all = Buffer.concat(chunks);
  j.buffers = [{ byteLength: all.length, uri: 'data:application/octet-stream;base64,' + all.toString('base64') }];
  fs.writeFileSync(out, JSON.stringify(j));
  console.log('meshes decoded; buffer', all.length, 'bytes');
})();
