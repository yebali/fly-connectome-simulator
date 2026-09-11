# fly-connectome-simulator

Three fruit flies navigate a desk, steered by a visual circuit wired from the *Drosophila*
male CNS connectome. Their wiring is real; their flight is a model. This page is careful
about which is which.

**Live demo → https://yebali.github.io/fly-connectome-simulator/**

Left half: the desk, in millimetres, with three flies. Right half: the same 397-neuron
circuit rendered three times — one per fly — each lit by what that fly is seeing right now.

---

## What comes from the connectome, and what does not

This is the point of the project, so it is stated plainly both here and in the page footer.

**From the connectome** (neuPrint `male-cns:v1.0`, 397 neurons / 13,331 weighted connections):

| | |
|---|---|
| Wiring | which cell connects to which descending neuron |
| Synapse weights | connection strengths, used as-is |
| Receptive fields | the visual columns each cell's dendrites cover |
| Excitatory / inhibitory sign | from predicted neurotransmitter |
| Laterality | which eye each descending neuron actually listens to — computed from input weights, not assumed from soma side |
| Morphology | the skeletons drawn in the neuron map |

**Modeled** — values the connectome does not contain, all collected in one `M` object at the
top of the script so the boundary stays visible:

| | |
|---|---|
| Neuron time constant | 45 ms leaky integration |
| Optic flow | how retinal motion is computed from geometry |
| Flight dynamics | thrust, yaw damping, spontaneous saccades |
| Torque gains | how descending activity becomes turning |

Cell populations: 42 LPTC (HS/VS wide-field motion), 311 looming detectors (185 LPLC2,
126 LC4), 44 descending neurons (DNa02 steering, DNp01–04/DNp103 escape).

## Does the wiring actually do the work?

A simulation that flies well proves nothing on its own — the model constants could be doing
everything. So the page ships perturbation controls that **damage only connectome-derived
values** while holding cell count, total synaptic weight, receptive-field size, and every
model constant fixed:

- **Half mirror** — half the cells read the opposite eye. (Flipping *all* of them is just a
  mirror-image relabeling, and the fly flies fine; only breaking half destroys laterality.)
- **Shuffle receptive fields** — same field sizes, randomized "who looks where".
- **Rewire descending neurons** — same connection count and weight distribution, randomized
  specificity.

If flight quality survives all three, the connectome is decoration. It does not.

## Controls

| | |
|---|---|
| Drag | orbit |
| Space + drag | pan |
| Scroll | zoom |
| `R` | recenter |
| `P` | pause |
| `N` or drag the divider | show/hide the neuron map |

Each fly's neuron map has its own camera — rotating one does not move the other two.

The panel on the right toggles circuit lesions (steering / looming / posture) and the
perturbation experiments above. The brightness slider drives tone-mapping exposure.

## Running locally

```sh
git clone https://github.com/yebali/fly-connectome-simulator.git
cd fly-connectome-simulator
python3 -m http.server 8000
# open http://localhost:8000
```

**Do not open `index.html` via `file://`.** It is an ES module page, and browsers block
module loading over `file://` with a CORS error — you get a blank screen and a console
message, not a fly. Any static server works.

## Self-test

Append `?selftest` to the URL. Four checks run headlessly and print to the console, the
page title, and the masthead:

1. **Optomotor sign** — turning left must drive the right eye's HS cells and produce a
   corrective right-turning torque.
2. **Looming locality** — flying at the monitor should light frontal looming cells, not
   rear ones.
3. **Perturbation control** — the escape signal must correctly separate "obstacle on the
   left" from "obstacle on the right", and at least 2 of the 3 perturbations must collapse
   that separation.
4. **Monitor sight line** — no desk object may intrude into the corridor in front of the
   screen. (Guards against future layout edits re-occluding the monitor.)

## Implementation notes

- Single self-contained HTML file. three.js 0.163 is pulled from jsDelivr via an import map;
  there is no build step and no bundler.
- The connectome lives in a `<script type="application/json">` block, which is most of the
  file's 2.9 MB.
- Ray casting against the desk is hand-rolled (slab test for boxes, quadratic for cylinders)
  rather than `THREE.Raycaster` — 512 rays per fly per frame makes the general-purpose path
  too slow.
- All 397 neurons draw in a single draw call: one merged geometry, with per-cell activity
  passed in as a 397×1 float texture that is swapped per viewport.
- The physics proxies in `OBJECTS` and the decorative meshes are kept at matching
  coordinates, so what the flies "see" is what you see.

## Data

Connectome data from **neuPrint** `male-cns:v1.0` — HHMI Janelia FlyEM and Google Research.
All neuron identities, wiring, weights, and morphology originate there; please refer to the
source for its own terms of use.
