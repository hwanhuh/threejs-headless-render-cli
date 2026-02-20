#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const program = new Command();
program
  .option('--in <path>', 'input GLB file path')
  .option('--dir <path>', 'input directory containing GLB files')
  .option('--out-dir <path>', 'output root directory', 'renders')
  .option('--views <number>', 'number of views per model', (v) => parseInt(v, 10), 24)
  .option('--workers <number>', 'number of parallel renderer workers', (v) => parseInt(v, 10), Math.min(8, Math.max(1, Math.floor(os.cpus().length / 2))))
  .option('--seed <number>', 'random seed (integer)', (v) => parseInt(v, 10))
  .option('--w <number>', 'width in pixels', (v) => parseInt(v, 10), 1024)
  .option('--h <number>', 'height in pixels', (v) => parseInt(v, 10), 1024)
  .option('--bg <transparent|white>', 'background', 'transparent')
  .option('--exposure <number>', 'tone mapping exposure', (v) => parseFloat(v), 1.2)
  .option('--three <local|cdn>', 'three.js source', 'local')
  .option('--fov <number>', 'base camera fov', (v) => parseFloat(v), 40)
  .option('--fov-jitter <number>', 'fov random variation (+/-)', (v) => parseFloat(v), 4)
  .option('--distance <number>', 'base camera distance from origin', (v) => parseFloat(v), 4)
  .option('--distance-jitter <number>', 'distance random variation (+/-)', (v) => parseFloat(v), 0.4)
  .option('--elev-min <number>', 'minimum elevation in degrees', (v) => parseFloat(v), -15)
  .option('--elev-max <number>', 'maximum elevation in degrees', (v) => parseFloat(v), 35)
  .option('--azim-min <number>', 'minimum azimuth in degrees (0 is front)', (v) => parseFloat(v), -120)
  .option('--azim-max <number>', 'maximum azimuth in degrees (0 is front)', (v) => parseFloat(v), 120)
  .option('--gpu-mode <auto|gpu|swiftshader>', 'chrome GPU mode', 'auto')
  .option('--antialias', 'enable antialiasing (slower)', false)
  .option('--warmup-frames <number>', 'frames rendered after model load', (v) => parseInt(v, 10), 1)
  .option('--view-frames <number>', 'frames rendered before each capture', (v) => parseInt(v, 10), 1)
  .option('--profile', 'print per-model timing profile', false)
  .option('--recursive', 'scan input directory recursively', true)
  .option('--no-recursive', 'scan input directory only at top level');

program.parse(process.argv);
const opts = program.opts();

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

if (!opts.in && !opts.dir) fail('Specify one input source: --in <path> or --dir <path>');
if (opts.in && opts.dir) fail('Use only one input source: --in or --dir');
if (!Number.isFinite(opts.views) || opts.views <= 0) fail('views must be a positive number');
if (!Number.isFinite(opts.workers) || opts.workers <= 0) fail('workers must be a positive number');
if (!Number.isFinite(opts.w) || opts.w <= 0) fail('Width must be a positive number');
if (!Number.isFinite(opts.h) || opts.h <= 0) fail('Height must be a positive number');
if (!['transparent', 'white'].includes(opts.bg)) fail('bg must be transparent or white');
if (!['local', 'cdn'].includes(opts.three)) fail('three must be local or cdn');
if (!Number.isFinite(opts.exposure) || opts.exposure <= 0) fail('exposure must be positive');
if (!Number.isFinite(opts.fov) || opts.fov <= 1 || opts.fov >= 120) fail('fov must be between 1 and 120');
if (!Number.isFinite(opts.fovJitter) || opts.fovJitter < 0) fail('fov-jitter must be >= 0');
if (!Number.isFinite(opts.distance) || opts.distance <= 0) fail('distance must be positive');
if (!Number.isFinite(opts.distanceJitter) || opts.distanceJitter < 0) fail('distance-jitter must be >= 0');
if (!Number.isFinite(opts.elevMin) || !Number.isFinite(opts.elevMax) || opts.elevMin >= opts.elevMax) fail('elev-min must be less than elev-max');
if (!Number.isFinite(opts.azimMin) || !Number.isFinite(opts.azimMax) || opts.azimMin >= opts.azimMax) fail('azim-min must be less than azim-max');
if (opts.seed !== undefined && (!Number.isInteger(opts.seed) || opts.seed < 0)) fail('seed must be a non-negative integer');
if (!['auto', 'gpu', 'swiftshader'].includes(opts.gpuMode)) fail('gpu-mode must be auto, gpu, or swiftshader');
if (!Number.isFinite(opts.warmupFrames) || opts.warmupFrames <= 0) fail('warmup-frames must be a positive number');
if (!Number.isFinite(opts.viewFrames) || opts.viewFrames <= 0) fail('view-frames must be a positive number');

const outRoot = path.resolve(process.cwd(), opts.outDir);

const htmlTemplate = fs.readFileSync(path.join(projectRoot, 'src', 'render-page.html'), 'utf8');

let threeVersion = '0.161.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  if (pkg.dependencies && pkg.dependencies.three) {
    threeVersion = String(pkg.dependencies.three).replace(/^[^0-9]*/, '');
  }
} catch {}

const threeUrl = opts.three === 'cdn'
  ? `https://unpkg.com/three@${threeVersion}/build/three.module.js`
  : '/three.module.js';
const loaderUrl = opts.three === 'cdn'
  ? `https://unpkg.com/three@${threeVersion}/examples/jsm/loaders/GLTFLoader.js`
  : '/examples/jsm/loaders/GLTFLoader.js';

const renderOpts = {
  width: opts.w,
  height: opts.h,
  bg: opts.bg,
  exposure: opts.exposure,
  antialias: !!opts.antialias,
  warmupFrames: opts.warmupFrames,
  viewFrames: opts.viewFrames,
  initialView: null
};

const html = htmlTemplate
  .replace('__RENDER_OPTS__', JSON.stringify(renderOpts))
  .replace('__THREE_URL__', threeUrl)
  .replace('__LOADER_URL__', loaderUrl);

const localThreePath = path.join(projectRoot, 'node_modules', 'three', 'build', 'three.module.js');
const localExamplesRoot = path.join(projectRoot, 'node_modules', 'three', 'examples', 'jsm');
const localLoaderPath = path.join(localExamplesRoot, 'loaders', 'GLTFLoader.js');

if (opts.three === 'local') {
  if (!fs.existsSync(localThreePath) || !fs.existsSync(localExamplesRoot) || !fs.existsSync(localLoaderPath)) {
    fail('three.js not found in node_modules. Run npm install or use --three cdn');
  }
}

function patchLoaderImportsForBrowser(src) {
  return src
    .replaceAll("from 'three';", "from '/three.module.js';")
    .replaceAll('from "three";', 'from "/three.module.js";');
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBetween(rng, min, max) {
  return min + (max - min) * rng();
}

function degToRad(d) {
  return (d * Math.PI) / 180;
}

function generateViews(count, rng) {
  const views = [];
  const azimSpan = opts.azimMax - opts.azimMin;

  for (let i = 0; i < count; i += 1) {
    const t = (i + 0.5) / count;
    const azimBase = opts.azimMin + azimSpan * t;
    const azimJitter = Math.min(8, azimSpan / Math.max(1, count * 2));
    const azim = azimBase + randomBetween(rng, -azimJitter, azimJitter);

    const elev = randomBetween(rng, opts.elevMin, opts.elevMax);
    const distance = opts.distance + randomBetween(rng, -opts.distanceJitter, opts.distanceJitter);
    const fov = opts.fov + randomBetween(rng, -opts.fovJitter, opts.fovJitter);

    const elevRad = degToRad(elev);
    const azimRad = degToRad(azim);

    const planar = distance * Math.cos(elevRad);
    const y = distance * Math.sin(elevRad);
    const x = planar * Math.sin(azimRad);
    const z = planar * Math.cos(azimRad);

    views.push({ x, y, z, fov });
  }

  return views;
}

function collectGlbFiles(dir, recursive) {
  const results = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) {
          walk(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.glb')) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function safeBaseName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base.replace(/[^a-zA-Z0-9._-]/g, '_') || 'model';
}

function makeUniqueDirName(baseName, usedNames) {
  const count = usedNames.get(baseName) || 0;
  usedNames.set(baseName, count + 1);
  if (count === 0) {
    return baseName;
  }
  return `${baseName}_${String(count + 1).padStart(2, '0')}`;
}

function resolveInputModels() {
  if (opts.in) {
    const inputPath = path.resolve(process.cwd(), opts.in);
    if (!fs.existsSync(inputPath)) fail(`Input not found: ${opts.in}`);
    if (!inputPath.toLowerCase().endsWith('.glb')) fail('Input must be a .glb file');
    return [inputPath];
  }

  const inputDir = path.resolve(process.cwd(), opts.dir);
  if (!fs.existsSync(inputDir)) fail(`Input directory not found: ${opts.dir}`);
  if (!fs.statSync(inputDir).isDirectory()) fail(`Input path is not a directory: ${opts.dir}`);

  const files = collectGlbFiles(inputDir, opts.recursive);
  if (files.length === 0) fail(`No .glb files found in directory: ${opts.dir}`);
  return files;
}

function startLocalServer() {
  let currentModelBuffer = null;

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = reqUrl.pathname;

      if (pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (pathname === '/model.glb') {
        if (!currentModelBuffer) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('No model loaded');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
        res.end(currentModelBuffer);
        return;
      }

      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (opts.three === 'local') {
        if (pathname === '/three.module.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(patchLoaderImportsForBrowser(fs.readFileSync(localThreePath, 'utf8')));
          return;
        }

        if (pathname.startsWith('/examples/jsm/')) {
          const relative = pathname.replace('/examples/jsm/', '');
          const filePath = path.resolve(localExamplesRoot, relative);
          if (filePath.startsWith(localExamplesRoot + path.sep) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            res.end(patchLoaderImportsForBrowser(fs.readFileSync(filePath, 'utf8')));
            return;
          }
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Server error: ${err && err.message ? err.message : String(err)}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to bind local server')));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        setModelBuffer: (buffer) => {
          currentModelBuffer = buffer;
        },
        close: () => new Promise((closeResolve) => server.close(() => closeResolve()))
      });
    });
  });
}

async function launchBrowser() {
  const baseLaunchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage'
  ];

  baseLaunchArgs.push(
    '--disable-breakpad',
    '--disable-crash-reporter'
  );

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  const launchConfigs = [
    { name: 'chrome(headless:new)', opts: { headless: 'new' } },
    { name: 'chrome-headless-shell', opts: { headless: 'shell' } }
  ];

  function getGpuArgVariants() {
    if (opts.gpuMode === 'swiftshader') {
      return [[
        '--use-angle=swiftshader',
        '--use-gl=angle',
        '--enable-unsafe-swiftshader'
      ]];
    }
    if (opts.gpuMode === 'gpu') {
      return [
        [
          '--ignore-gpu-blocklist',
          '--enable-gpu-rasterization',
          '--enable-zero-copy',
          '--use-gl=angle',
          '--use-angle=gl-egl',
          '--disable-vulkan',
          '--disable-software-rasterizer'
        ],
        [
          '--ignore-gpu-blocklist',
          '--enable-gpu-rasterization',
          '--enable-zero-copy',
          '--use-gl=angle',
          '--use-angle=gles',
          '--disable-vulkan',
          '--disable-software-rasterizer'
        ],
        [
          '--ignore-gpu-blocklist',
          '--enable-gpu-rasterization',
          '--enable-zero-copy',
          '--disable-software-rasterizer'
        ],
        [
          '--ignore-gpu-blocklist',
          '--enable-gpu-rasterization',
          '--enable-zero-copy',
          '--use-gl=egl',
          '--disable-software-rasterizer'
        ],
        [
          '--ignore-gpu-blocklist',
          '--enable-gpu-rasterization',
          '--enable-zero-copy',
          '--use-gl=desktop',
          '--disable-software-rasterizer'
        ],
        [
          '--ignore-gpu-blocklist',
          '--enable-gpu-rasterization'
        ]
      ];
    }
    return [[]];
  }

  function buildBrowserEnv() {
    const env = { ...process.env };
    if (opts.gpuMode !== 'gpu') {
      return env;
    }

    const nvidiaEglVendor = '/usr/share/glvnd/egl_vendor.d/10_nvidia.json';
    const nvidiaVkIcd = '/usr/share/vulkan/icd.d/nvidia_icd.json';
    const nvidiaVkIcdAlt = '/usr/share/vulkan/icd.d/nvidia_icd.x86_64.json';

    if (!env.__EGL_VENDOR_LIBRARY_FILENAMES && fs.existsSync(nvidiaEglVendor)) {
      env.__EGL_VENDOR_LIBRARY_FILENAMES = nvidiaEglVendor;
    }
    if (!env.VK_ICD_FILENAMES) {
      if (fs.existsSync(nvidiaVkIcd)) {
        env.VK_ICD_FILENAMES = nvidiaVkIcd;
      } else if (fs.existsSync(nvidiaVkIcdAlt)) {
        env.VK_ICD_FILENAMES = nvidiaVkIcdAlt;
      }
    }

    return env;
  }

  const browserEnv = buildBrowserEnv();

  async function canCreateWebGL(browser) {
    const page = await browser.newPage();
    try {
      const result = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl2 = canvas.getContext('webgl2', { powerPreference: 'high-performance' });
        const gl = gl2 || canvas.getContext('webgl', { powerPreference: 'high-performance' });
        if (!gl) {
          return { ok: false, reason: 'webgl context unavailable' };
        }
        let renderer = '';
        try {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          if (dbg) {
            renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
          }
        } catch {}
        return { ok: true, renderer };
      });
      return result;
    } finally {
      await page.close();
    }
  }

  const gpuArgVariants = getGpuArgVariants();
  const launchErrors = [];
  for (const extraArgs of gpuArgVariants) {
    for (const cfg of launchConfigs) {
      const args = baseLaunchArgs.concat(extraArgs);
      try {
        const browser = await puppeteer.launch({
          ...cfg.opts,
          executablePath,
          args,
          env: browserEnv
        });

        if (opts.gpuMode === 'gpu') {
          const test = await canCreateWebGL(browser);
          if (!test.ok) {
            launchErrors.push(`${cfg.name} args=[${extraArgs.join(' ')}]: ${test.reason}`);
            await browser.close();
            continue;
          }
          if (/swiftshader/i.test(test.renderer || '')) {
            launchErrors.push(`${cfg.name} args=[${extraArgs.join(' ')}]: fell back to SwiftShader (${test.renderer || 'unknown renderer'})`);
            await browser.close();
            continue;
          }
        }

        return browser;
      } catch (err) {
        launchErrors.push(`${cfg.name} args=[${extraArgs.join(' ')}]: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  const details = launchErrors.join('\n\n');
  if (/Operation not permitted|sandbox_host_linux\.cc|crashpad/i.test(details)) {
    fail(
      `Failed to launch Chromium in this environment (Linux sandbox restriction).\n` +
      `Try one of the following:\n` +
      `- If running in Docker/Podman, add --security-opt seccomp=unconfined (or --cap-add=SYS_ADMIN).\n` +
      `- Run the CLI outside a restricted container.\n` +
      `- Set PUPPETEER_EXECUTABLE_PATH to a system Chrome/Chromium binary.\n\n` +
      `Launch attempts:\n${details}`
    );
  }

  if (opts.gpuMode === 'gpu') {
    fail(
      `Failed to create a real GPU WebGL context in --gpu-mode gpu.\n` +
      `Tried multiple Chrome GPU flag combinations but all failed or fell back to SwiftShader.\n` +
      `Check NVIDIA driver/container runtime and EGL libraries on this host.\n\n` +
      `Attempts:\n${details}`
    );
  }

  fail(`Failed to launch Chromium. Launch attempts:\n${details}`);
}

async function waitRenderReady(page) {
  await page.waitForFunction(
    'window.__RENDER_DONE__ === true || typeof window.__RENDER_ERROR__ === "string"',
    { timeout: 30000 }
  );

  const renderError = await page.evaluate(() => window.__RENDER_ERROR__ || null);
  if (renderError) {
    throw new Error(renderError);
  }
}

async function renderOneModel({ worker, modelPath, outputDir, views }) {
  const { page, app } = worker;
  const t0 = performance.now();
  const modelBuffer = fs.readFileSync(modelPath);
  app.setModelBuffer(modelBuffer);
  const t1 = performance.now();

  if (!worker.initialized) {
    await page.goto(`${app.baseUrl}/?m=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await waitRenderReady(page);
    worker.initialized = true;
  } else {
    await page.evaluate(async (token) => {
      if (typeof window.__LOAD_MODEL__ !== 'function') {
        throw new Error('__LOAD_MODEL__ is not available');
      }
      await window.__LOAD_MODEL__(`model.glb?m=${token}`);
    }, Date.now());
  }
  const t2 = performance.now();

  fs.mkdirSync(outputDir, { recursive: true });

  let setViewMs = 0;
  let screenshotMs = 0;
  for (let i = 0; i < views.length; i += 1) {
    const view = views[i];
    const tv0 = performance.now();
    await page.evaluate(async (v) => {
      if (typeof window.__SET_VIEW__ !== 'function') {
        throw new Error('__SET_VIEW__ is not available');
      }
      await window.__SET_VIEW__(v);
    }, view);
    const tv1 = performance.now();
    setViewMs += (tv1 - tv0);

    const outputPath = path.join(outputDir, `${String(i + 1).padStart(3, '0')}.png`);
    const screenshotOpts = opts.bg === 'transparent'
      ? { path: outputPath, omitBackground: true, captureBeyondViewport: false }
      : { path: outputPath, captureBeyondViewport: false };
    const ts0 = performance.now();
    await page.screenshot(screenshotOpts);
    const ts1 = performance.now();
    screenshotMs += (ts1 - ts0);
  }

  const t3 = performance.now();
  return {
    loadBufferMs: t1 - t0,
    pageLoadMs: t2 - t1,
    setViewMs,
    screenshotMs,
    totalMs: t3 - t0
  };
}

async function createRenderWorker() {
  const browser = await launchBrowser();
  const app = await startLocalServer();
  const page = await browser.newPage();
  await page.setViewport({ width: opts.w, height: opts.h, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/favicon\\.ico/i.test(text) && /404/i.test(text)) {
        return;
      }
      errors.push(new Error(text));
    }
  });

  return {
    page,
    app,
    errors,
    renderInfo: null,
    initialized: false,
    close: async () => {
      await app.close();
      await browser.close();
    }
  };
}

async function run() {
  const modelPaths = resolveInputModels();
  fs.mkdirSync(outRoot, { recursive: true });

  const usedNames = new Map();
  const modelJobs = modelPaths.map((modelPath) => {
    const uniqueName = makeUniqueDirName(safeBaseName(modelPath), usedNames);
    return {
      modelPath,
      outputDir: path.join(outRoot, uniqueName)
    };
  });

  const workerCount = Math.min(opts.workers, modelJobs.length);
  const workers = [];

  try {
    for (let i = 0; i < workerCount; i += 1) {
      workers.push(await createRenderWorker());
    }

    let nextIndex = 0;
    let completed = 0;
    let fatalError = null;
    const globalProfile = {
      loadBufferMs: 0,
      pageLoadMs: 0,
      setViewMs: 0,
      screenshotMs: 0,
      totalMs: 0
    };

    const runWorkerLoop = async (worker, workerId) => {
      while (true) {
        if (fatalError) {
          return;
        }
        const jobIndex = nextIndex;
        nextIndex += 1;
        if (jobIndex >= modelJobs.length) {
          return;
        }

        const { modelPath, outputDir } = modelJobs[jobIndex];
        const modelSeed = opts.seed !== undefined
          ? ((opts.seed >>> 0) + ((jobIndex + 1) * 2654435761 >>> 0)) >>> 0
          : (Date.now() + jobIndex * 7919) >>> 0;
        const rng = mulberry32(modelSeed);
        const views = generateViews(opts.views, rng);

        if (worker.errors.length > 0) {
          throw worker.errors[0];
        }

        const modelProfile = await renderOneModel({ worker, modelPath, outputDir, views });

        if (!worker.renderInfo) {
          worker.renderInfo = await worker.page.evaluate(() => window.__RENDER_INFO__ || null);
          if (opts.profile && worker.renderInfo) {
            console.log(`[worker ${workerId}] renderer=${worker.renderInfo.glRenderer || 'unknown'} vendor=${worker.renderInfo.glVendor || 'unknown'} antialias=${worker.renderInfo.antialias} warmupFrames=${worker.renderInfo.warmupFrames} viewFrames=${worker.renderInfo.viewFrames}`);
          }
          if (worker.renderInfo && /swiftshader/i.test(worker.renderInfo.glRenderer || '') && opts.gpuMode !== 'swiftshader') {
            console.warn(`[worker ${workerId}] warning: Chrome is using SwiftShader software rendering. Check NVIDIA/EGL runtime setup for real GPU acceleration.`);
          }
        }

        if (worker.errors.length > 0) {
          throw worker.errors[0];
        }

        globalProfile.loadBufferMs += modelProfile.loadBufferMs;
        globalProfile.pageLoadMs += modelProfile.pageLoadMs;
        globalProfile.setViewMs += modelProfile.setViewMs;
        globalProfile.screenshotMs += modelProfile.screenshotMs;
        globalProfile.totalMs += modelProfile.totalMs;

        completed += 1;
        console.log(`[${completed}/${modelJobs.length}] [worker ${workerId}] rendered ${modelPath} -> ${outputDir}`);
        if (opts.profile) {
          console.log(`[profile] model=${path.basename(modelPath)} total=${modelProfile.totalMs.toFixed(1)}ms loadBuffer=${modelProfile.loadBufferMs.toFixed(1)}ms pageLoad=${modelProfile.pageLoadMs.toFixed(1)}ms setView=${modelProfile.setViewMs.toFixed(1)}ms screenshot=${modelProfile.screenshotMs.toFixed(1)}ms`);
        }
      }
    };

    await Promise.all(
      workers.map((worker, i) =>
        runWorkerLoop(worker, i + 1).catch((err) => {
          fatalError = err;
          throw err;
        })
      )
    );

    if (opts.profile) {
      const n = modelJobs.length || 1;
      console.log(`[profile-summary] models=${modelJobs.length} workers=${workerCount} avg_total=${(globalProfile.totalMs / n).toFixed(1)}ms avg_pageLoad=${(globalProfile.pageLoadMs / n).toFixed(1)}ms avg_setView=${(globalProfile.setViewMs / n).toFixed(1)}ms avg_screenshot=${(globalProfile.screenshotMs / n).toFixed(1)}ms`);
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.close().catch(() => {})));
  }
}

run().catch((err) => {
  console.error('Render failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
