# GLB Render CLI

Headless GLB renderer using Three.js and Puppeteer. Loads a local GLB via request interception and outputs a PNG.

## Install

```bash
npm install
```

## Usage

```bash
node bin/render-glb.js --in ./model.glb
```

Options:
- `--in <path>` (required)
- `--out <path>` default `out.png`
- `--w <number>` default `1024`
- `--h <number>` default `1024`
- `--bg <transparent|white>` default `transparent`
- `--exposure <number>` default `1.2`
- `--three <local|cdn>` default `local`

Examples:

```bash
node bin/render-glb.js --in ./model.glb --out ./out.png --w 1024 --h 1024 --bg transparent
node bin/render-glb.js --in ./model.glb --bg white --three cdn
```

## Notes
- Rendering is stabilized by rendering 3 frames before capture.
- Transparent background keeps alpha (uses `omitBackground: true`).
- Offline mode serves Three.js from `node_modules` (default).
- CDN mode loads from unpkg; requires network access.

## Troubleshooting
- `Failed to launch the browser process` with `Operation not permitted` usually means Linux container sandbox restrictions.
- For Docker/Podman, try running the container with `--security-opt seccomp=unconfined` (or `--cap-add=SYS_ADMIN`).
- You can also point Puppeteer to an existing browser binary via `PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`.
