#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--disable-breakpad',
    '--disable-crash-reporter'
  ];

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  const launchConfigs = [
    { name: 'chrome(headless:new)', opts: { headless: 'new' } },
    { name: 'chrome-headless-shell', opts: { headless: 'shell' } }
  ];

  const launchErrors = [];
  for (const cfg of launchConfigs) {
    try {
      return await puppeteer.launch({
        ...cfg.opts,
        executablePath,
        args: launchArgs
      });
    } catch (err) {
      launchErrors.push(`${cfg.name}: ${err && err.message ? err.message : String(err)}`);
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

async function renderOneModel({ page, app, modelPath, outputDir, views }) {
  const modelBuffer = fs.readFileSync(modelPath);
  app.setModelBuffer(modelBuffer);

  await page.goto(`${app.baseUrl}/?m=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await waitRenderReady(page);

  fs.mkdirSync(outputDir, { recursive: true });

  for (let i = 0; i < views.length; i += 1) {
    const view = views[i];
    await page.evaluate(async (v) => {
      if (typeof window.__SET_VIEW__ !== 'function') {
        throw new Error('__SET_VIEW__ is not available');
      }
      await window.__SET_VIEW__(v);
    }, view);

    const outputPath = path.join(outputDir, `${String(i + 1).padStart(3, '0')}.png`);
    const screenshotOpts = opts.bg === 'transparent'
      ? { path: outputPath, omitBackground: true }
      : { path: outputPath };
    await page.screenshot(screenshotOpts);
  }
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

  const browser = await launchBrowser();
  let app;
  let page;

  try {
    app = await startLocalServer();
    page = await browser.newPage();
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

    for (let i = 0; i < modelJobs.length; i += 1) {
      const { modelPath, outputDir } = modelJobs[i];
      const modelSeed = opts.seed !== undefined
        ? ((opts.seed >>> 0) + ((i + 1) * 2654435761 >>> 0)) >>> 0
        : (Date.now() + i * 7919) >>> 0;
      const rng = mulberry32(modelSeed);
      const views = generateViews(opts.views, rng);

      await renderOneModel({ page, app, modelPath, outputDir, views });
      console.log(`[${i + 1}/${modelJobs.length}] rendered ${modelPath} -> ${outputDir}`);
    }

    if (errors.length > 0) {
      throw errors[0];
    }
  } finally {
    if (app) {
      await app.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

run().catch((err) => {
  console.error('Render failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
