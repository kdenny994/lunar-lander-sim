"""Re-pack binary assets into web-served types: int16 heightfields -> lossless RGB PNG
(R = high byte, G = low byte of value+32768), and the GLB -> self-contained glTF JSON."""
import json, os, struct, base64, numpy as np
from PIL import Image
for n in ["corridor", "site"]:
    m = json.load(open(f"public/data/terrain/{n}.json"))
    a = np.fromfile(f"public/data/terrain/{n}.bin", dtype="<i2").reshape(m["height"], m["width"]).astype(np.int32) + 32768
    rgb = np.zeros((m["height"], m["width"], 3), np.uint8)
    rgb[..., 0] = a >> 8; rgb[..., 1] = a & 255
    Image.fromarray(rgb, "RGB").save(f"public/data/terrain/{n}_h.png", optimize=True)
    os.makedirs("data-raw/terrain", exist_ok=True)
    os.replace(f"public/data/terrain/{n}.bin", f"data-raw/terrain/{n}.bin")  # kept for the Node tests
d = open("data-raw/apollo_lm.glb", "rb").read()
jl = struct.unpack("<I", d[12:16])[0]
j = json.loads(d[20:20 + jl])
off = 20 + jl
bl = struct.unpack("<I", d[off:off + 4])[0]
binc = d[off + 8: off + 8 + bl]
j["buffers"][0]["uri"] = "data:application/octet-stream;base64," + base64.b64encode(binc).decode()
json.dump(j, open("public/models/apollo_lm.gltf.json", "w"), separators=(",", ":"))
print("ok")
