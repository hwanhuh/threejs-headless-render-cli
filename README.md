# GLB Render CLI

Headless GLB renderer using Three.js and Puppeteer. Supports single-model and directory batch rendering to multi-view PNGs.

## Prerequisites

Base (all servers):
- Node.js 20+ and npm
- Linux libraries required by Chromium/Puppeteer:
```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates fonts-liberation libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 \
  libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
  libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
  libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
  libxshmfence1 libxss1 libxtst6 xdg-utils wget
```

For GPU rendering (`--gpu-mode gpu`):
- NVIDIA driver installed on host (`nvidia-smi` must work)
- NVIDIA Container Toolkit if running in Docker
- EGL/OpenGL runtime libraries:
```bash
sudo apt-get install -y libegl1 libgles2 libgl1 libglvnd0
```

Docker runtime requirements (GPU):
- Start container with `--gpus all`
- NVIDIA runtime must be visible inside container (`nvidia-smi`)

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
- `--list <path>` text file with one GLB path per line
- `--list-jsonl <path>` JSONL file containing GLB paths
- `--list-key <key>` JSONL key to read from (default: `path` or `glb_path`)
- `--out-dir <path>` output root directory, default `renders`
- `--views <number>` number of views per model, default `24`
- `--workers <number>` parallel renderer workers, default `min(8, cpu_cores/2)`
- `--seed <number>` optional deterministic seed
- `--w <number>` default `1024`
- `--h <number>` default `1024`
- `--bg <transparent|white>` default `transparent`
- `--material <color|geometry|normal|wireframe>` material override, default `color`
- `--exposure <number>` default `1.35`
- `--env <path>` optional environment map (.hdr or .exr) for lighting only
- `--env-intensity <number>` default `1`
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
node bin/render-glb.js --in ./model.glb --env ./studio.hdr --env-intensity 1.0
node bin/render-glb.js --list ./glbs.txt --out-dir ./renders --views 24
node bin/render-glb.js --list-jsonl ./transparent_renders.jsonl --list-key glb_path --out-dir ./renders --material geometry
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
- When `--gpu-mode gpu` and `--profile` are set, the CLI prints `[gpu-diag]` lines with device/env visibility and the WebGL renderer Chrome actually created.
- If profile logs still show `SwiftShader`, Chrome is not using your real GPU. In that case throughput is mostly CPU-bound (PNG capture/encoding).
- Transparent background keeps alpha (uses `omitBackground: true`).
- Offline mode serves Three.js from `node_modules` (default).
- CDN mode loads from unpkg; requires network access.

## Troubleshooting
- `Failed to launch the browser process` with `Operation not permitted` usually means Linux container sandbox restrictions.
- For Docker/Podman, try running the container with `--security-opt seccomp=unconfined` (or `--cap-add=SYS_ADMIN`).
- You can also point Puppeteer to an existing browser binary via `PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`.

GPU not being used (SwiftShader or CPU-bound):
- Run with `--gpu-mode gpu --profile` and inspect the `[gpu-diag]` output. If it shows `dev_nodes=none` or missing EGL/GL libs, the container cannot see GPU devices or graphics libs.
- In Docker, ensure `--gpus all` and `NVIDIA_DRIVER_CAPABILITIES=graphics,utility,compute` are set, and that `nvidia-smi` works inside the container.
- Make sure EGL/OpenGL libs are installed (`libegl1`, `libgles2`, `libgl1`, `libglvnd0`) and that `/usr/share/glvnd/egl_vendor.d/10_nvidia.json` exists.
- If `/usr/share/glvnd/egl_vendor.d/10_nvidia.json` is missing but `libEGL_nvidia.so.0` exists, the CLI will generate a temporary EGL vendor file and set `__EGL_VENDOR_LIBRARY_FILENAMES` automatically.
- If `libEGL_nvidia.so.0` is missing, install the NVIDIA EGL package that matches your driver (e.g., `libnvidia-egl-<driver-version>` or install the full `nvidia-driver-<version>` package inside the image).
- If `renderer=SwiftShader` persists, set `PUPPETEER_EXECUTABLE_PATH` to a system Chrome/Chromium with proper GPU support, or run outside the container.
