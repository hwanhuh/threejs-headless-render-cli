#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const program = new Command();
program
  .requiredOption('--in <path>', 'input GLB file path')
  .option('--out <path>', 'output PNG path', 'out.png')
  .option('--w <number>', 'width in pixels', (v) => parseInt(v, 10), 1024)
  .option('--h <number>', 'height in pixels', (v) => parseInt(v, 10), 1024)
  .option('--bg <transparent|white>', 'background', 'transparent')
  .option('--exposure <number>', 'tone mapping exposure', (v) => parseFloat(v), 1.2)
  .option('--three <local|cdn>', 'three.js source', 'local');

program.parse(process.argv);
const opts = program.opts();

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(opts.in)) fail(`Input not found: ${opts.in}`);
if (!opts.in.toLowerCase().endsWith('.glb')) fail('Input must be a .glb file');
if (!Number.isFinite(opts.w) || opts.w <= 0) fail('Width must be a positive number');
if (!Number.isFinite(opts.h) || opts.h <= 0) fail('Height must be a positive number');
if (!['transparent', 'white'].includes(opts.bg)) fail('bg must be transparent or white');
if (!['local', 'cdn'].includes(opts.three)) fail('three must be local or cdn');
if (!Number.isFinite(opts.exposure) || opts.exposure <= 0) fail('exposure must be positive');

const inputPath = path.resolve(process.cwd(), opts.in);
const outputPath = path.resolve(process.cwd(), opts.out);

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
  : 'three.module.js';
const loaderUrl = opts.three === 'cdn'
  ? `https://unpkg.com/three@${threeVersion}/examples/jsm/loaders/GLTFLoader.js`
  : 'GLTFLoader.js';

const renderOpts = {
  width: opts.w,
  height: opts.h,
  bg: opts.bg,
  exposure: opts.exposure
};

const html = htmlTemplate
  .replace('__RENDER_OPTS__', JSON.stringify(renderOpts))
  .replace('__THREE_URL__', threeUrl)
  .replace('__LOADER_URL__', loaderUrl);

const modelBuffer = fs.readFileSync(inputPath);

const serverHost = 'http://render.local';

const localThreePath = path.join(projectRoot, 'node_modules', 'three', 'build', 'three.module.js');
const localLoaderPath = path.join(projectRoot, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js');

if (opts.three === 'local') {
  if (!fs.existsSync(localThreePath) || !fs.existsSync(localLoaderPath)) {
    fail('three.js not found in node_modules. Run npm install or use --three cdn');
  }
}

async function run() {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: opts.w, height: opts.h, deviceScaleFactor: 1 });

    const errors = [];
    page.on('pageerror', (err) => errors.push(err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(new Error(msg.text()));
      }
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();

      if (url === `${serverHost}/model.glb`) {
        req.respond({
          status: 200,
          headers: { 'Content-Type': 'model/gltf-binary' },
          body: modelBuffer
        });
        return;
      }

      if (opts.three === 'local') {
        if (url === `${serverHost}/three.module.js`) {
          req.respond({
            status: 200,
            headers: { 'Content-Type': 'application/javascript' },
            body: fs.readFileSync(localThreePath)
          });
          return;
        }
        if (url === `${serverHost}/GLTFLoader.js`) {
          req.respond({
            status: 200,
            headers: { 'Content-Type': 'application/javascript' },
            body: fs.readFileSync(localLoaderPath)
          });
          return;
        }

        // Block all other external requests in offline mode.
        if (!url.startsWith(serverHost)) {
          req.abort();
          return;
        }
      }

      req.continue();
    });

    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__RENDER_DONE__ === true', { timeout: 30000 });

    if (errors.length > 0) {
      throw errors[0];
    }

    const screenshotOpts = opts.bg === 'transparent'
      ? { path: outputPath, omitBackground: true }
      : { path: outputPath };

    await page.screenshot(screenshotOpts);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Render failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
