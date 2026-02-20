# GLB Render CLI

Headless GLB renderer using Three.js and Puppeteer. Supports single-model and directory batch rendering to multi-view PNGs.

## Install

```bash
npm install
```

## Usage

```bash
node bin/render-glb.js --in ./model.glb
```

Batch render all GLBs in a directory:

```bash
node bin/render-glb.js --dir ./dataset/models
```

Options:
- `--in <path>` single GLB input
- `--dir <path>` directory input (batch mode)
- `--out-dir <path>` output root directory, default `renders`
- `--views <number>` number of views per model, default `24`
- `--workers <number>` parallel renderer workers, default `min(8, cpu_cores/2)`
- `--seed <number>` optional deterministic seed
- `--w <number>` default `1024`
- `--h <number>` default `1024`
- `--bg <transparent|white>` default `transparent`
- `--exposure <number>` default `1.2`
- `--three <local|cdn>` default `local`
- `--fov <number>` base camera FOV, default `40`
- `--fov-jitter <number>` FOV jitter (+/-), default `4`
- `--distance <number>` base camera distance, default `4`
- `--distance-jitter <number>` distance jitter (+/-), default `0.4`
- `--elev-min <number>` min elevation degrees, default `-15`
- `--elev-max <number>` max elevation degrees, default `35`
- `--azim-min <number>` min azimuth degrees, default `-120`
- `--azim-max <number>` max azimuth degrees, default `120`
- `--gpu-mode <auto|gpu|swiftshader>` Chrome GPU mode, default `auto`
- `--antialias` enable antialiasing (slower), default off
- `--warmup-frames <number>` frames after load, default `1`
- `--view-frames <number>` frames before each capture, default `1`
- `--profile` print timing profile
- `--recursive` / `--no-recursive` directory scan mode (default recursive)

Examples:

```bash
node bin/render-glb.js --in ./model.glb --out-dir ./renders --views 24
node bin/render-glb.js --dir ./dataset/models --out-dir ./renders --views 24 --seed 42
node bin/render-glb.js --dir /data/HHHH/texverse/extracted --out-dir ./renders --views 24 --workers 8 --gpu-mode gpu --profile --seed 42
node bin/render-glb.js --in ./model.glb --bg white --three cdn --fov 40 --fov-jitter 3
```

H100 server example (all texverse parts under one root):

```bash
node bin/render-glb.js \
  --dir /data/HHHH/texverse/extracted \
  --out-dir /data/HHHH/texverse/renders \
  --views 24 \
  --workers 8 \
  --gpu-mode gpu \
  --profile \
  --seed 42
```

## Notes
- Output layout: `renders/<model_name>/001.png ... 024.png` (name collisions auto-suffixed).
- Views are sampled on a front-biased spherical region (less top/back), with small random FOV variation.
- Rendering is stabilized by rendering extra frames before capture.
- Speed-first defaults: antialias off, warmup/view frames set to 1, and GPU mode set to `auto`.
- Use `--gpu-mode gpu --profile` to verify renderer string and per-stage timing.
- If profile logs still show `SwiftShader`, Chrome is not using your real GPU. In that case throughput is mostly CPU-bound (PNG capture/encoding).
- Transparent background keeps alpha (uses `omitBackground: true`).
- Offline mode serves Three.js from `node_modules` (default).
- CDN mode loads from unpkg; requires network access.

## Troubleshooting
- `Failed to launch the browser process` with `Operation not permitted` usually means Linux container sandbox restrictions.
- For Docker/Podman, try running the container with `--security-opt seccomp=unconfined` (or `--cap-add=SYS_ADMIN`).
- You can also point Puppeteer to an existing browser binary via `PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`.
