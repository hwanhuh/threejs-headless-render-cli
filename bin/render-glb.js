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
  : '/three.module.js';
const loaderUrl = opts.three === 'cdn'
  ? `https://unpkg.com/three@${threeVersion}/examples/jsm/loaders/GLTFLoader.js`
  : '/examples/jsm/loaders/GLTFLoader.js';

const renderOpts = {
  width: opts.w,
  height: opts.h,
  bg: opts.bg,
  exposure: opts.exposure
};
const debugRender = process.env.DEBUG_RENDER === '1';
function debugLog(...args) {
  if (debugRender) {
    console.error('[render-debug]', ...args);
  }
}

const html = htmlTemplate
  .replace('__RENDER_OPTS__', JSON.stringify(renderOpts))
  .replace('__THREE_URL__', threeUrl)
  .replace('__LOADER_URL__', loaderUrl);

const modelBuffer = fs.readFileSync(inputPath);

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

function startLocalServer() {
  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = reqUrl.pathname;
      debugLog('http', req.method, pathname);

      if (pathname === '/') {
        debugLog('serve html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (pathname === '/model.glb') {
        debugLog('serve model');
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
        res.end(modelBuffer);
        return;
      }

      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (opts.three === 'local') {
        if (pathname === '/three.module.js') {
          debugLog('serve three.module.js');
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(patchLoaderImportsForBrowser(fs.readFileSync(localThreePath, 'utf8')));
          return;
        }

        if (pathname.startsWith('/examples/jsm/')) {
          const relative = pathname.replace('/examples/jsm/', '');
          const filePath = path.resolve(localExamplesRoot, relative);
          if (filePath.startsWith(localExamplesRoot + path.sep) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            debugLog('serve jsm', relative);
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            res.end(patchLoaderImportsForBrowser(fs.readFileSync(filePath, 'utf8')));
            return;
          }
        }

        debugLog('local 404', pathname);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      debugLog('cdn/local generic 404', pathname);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      debugLog('server error', err && err.stack ? err.stack : err);
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
        close: () => new Promise((closeResolve) => server.close(() => closeResolve()))
      });
    });
  });
}

async function run() {
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

  let browser;
  const launchErrors = [];
  for (const cfg of launchConfigs) {
    try {
      browser = await puppeteer.launch({
        ...cfg.opts,
        executablePath,
        args: launchArgs
      });
      break;
    } catch (err) {
      launchErrors.push(`${cfg.name}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  if (!browser) {
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

  let app;
  try {
    app = await startLocalServer();

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

    await page.goto(app.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      'window.__RENDER_DONE__ === true || typeof window.__RENDER_ERROR__ === "string"',
      { timeout: 30000 }
    );

    const renderError = await page.evaluate(() => window.__RENDER_ERROR__ || null);
    if (renderError) {
      throw new Error(renderError);
    }

    if (errors.length > 0) {
      throw errors[0];
    }

    const screenshotOpts = opts.bg === 'transparent'
      ? { path: outputPath, omitBackground: true }
      : { path: outputPath };

    await page.screenshot(screenshotOpts);
  } finally {
    if (app) {
      await app.close();
    }
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Render failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
