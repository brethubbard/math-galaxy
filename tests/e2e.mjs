// e2e.mjs — headless smoke test of the full solo flow across all three galaxies.
//
// Serves the static app from a tiny in-process server, drives it with Playwright,
// and asserts that each operation renders the right symbol, scores a correct
// answer, and (for subtraction) never produces a negative answer. Also checks the
// galaxy chooser and the per-galaxy stats heatmap.
//
// Run with:  npm run test:e2e
//
// This is a plain script (not a *.test.js file) so vitest does not pick it up.
import pw from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = pw;
const ROOT = path.dirname(new URL('.', import.meta.url).pathname.replace(/\/$/, ''));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

// --- tiny static file server (repo root) ---
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

// --- locate the browser (this environment ships one under PLAYWRIGHT_BROWSERS_PATH) ---
function chromiumExe() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    const dir = fs.readdirSync(base).find((d) => d.startsWith('chromium-'));
    const p = dir && path.join(base, dir, 'chrome-linux', 'chrome');
    if (p && fs.existsSync(p)) return p;
  }
  return undefined; // fall back to Playwright's bundled browser
}

const browser = await chromium.launch({ executablePath: chromiumExe(), args: ['--no-sandbox'] });
const page = await browser.newPage();
const fatal = [];
page.on('pageerror', (e) => fatal.push('PAGEERROR: ' + e.message)); // uncaught JS only

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

try {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  // bypass the (network-dependent) voice-model boot overlay
  await page.evaluate(() => document.querySelector('#boot-loader')?.remove());

  // new pilot -> galaxy chooser
  await page.fill('#pilot-name', 'Tester');
  await page.click('#btn-start');
  await page.waitForSelector('#screen-galaxy.active');
  const cards = await page.$$eval('#galaxy-cards .galaxy-card', (els) => els.length);
  assert(cards === 3, `expected 3 galaxy cards, got ${cards}`);

  for (const [name, symbol] of [['Subtraction', '−'], ['Addition', '+'], ['Multiplication', '×']]) {
    await page.click('#screen-map.active [data-nav="galaxy"]').catch(() => {});
    await page.waitForSelector('#screen-galaxy.active');
    await page.$$eval('#galaxy-cards .galaxy-card', (els, n) => {
      els.find((e) => e.querySelector('.gx-name')?.textContent.includes(n)).click();
    }, name);
    await page.waitForSelector('#screen-map.active');
    const title = await page.textContent('#map-title');
    assert(title.includes(name), `map title "${title}" should mention ${name}`);

    await page.click('#planet-track .planet-node:not(.locked)');
    await page.waitForSelector('#screen-planet.active');
    await page.click('#btn-practice');
    await page.waitForSelector('#screen-play.active');

    const q = await page.evaluate(() => ({
      a: +document.querySelector('#q-a').textContent,
      op: document.querySelector('#q-op').textContent,
      b: +document.querySelector('#q-b').textContent,
    }));
    assert(q.op === symbol, `${name}: operator was "${q.op}", expected "${symbol}"`);
    const expected = symbol === '×' ? q.a * q.b : symbol === '+' ? q.a + q.b : q.a - q.b;
    if (symbol === '−') assert(expected >= 0, `${name}: negative answer ${q.a}-${q.b}`);

    for (const ch of String(expected)) await page.click(`#keypad button[data-k="${ch}"]`);
    await page.click('#keypad button[data-k="enter"]');
    await page.waitForTimeout(150);
    const fb = await page.evaluate(() => document.querySelector('#feedback').className);
    assert(fb.includes('good'), `${name}: correct answer not accepted (feedback="${fb}")`);
    console.log(`✓ ${name}: ${q.a}${q.op}${q.b}=${expected} accepted`);

    await page.click('#btn-quit-play');
    await page.waitForSelector('#screen-map.active');
  }

  // stats: heatmap switches per galaxy
  await page.click('#screen-map.active [data-nav="stats"]');
  await page.waitForSelector('#screen-stats.active');
  const tabs = await page.$$eval('#stats-gal-tabs .op-chip', (els) => els.length);
  assert(tabs === 3, `expected 3 stats galaxy tabs, got ${tabs}`);
  await page.$$eval('#stats-gal-tabs .op-chip', (els) => {
    els.find((e) => e.textContent.includes('Subtraction')).click();
  });
  const head = await page.evaluate(() => document.querySelector('#heatmap .hc.head')?.textContent);
  assert(head === '−', `subtraction grid header should be "−", got "${head}"`);
  console.log('✓ stats heatmap switches per galaxy');

  assert(fatal.length === 0, 'uncaught page errors:\n' + fatal.join('\n'));
  console.log('\nE2E PASSED');
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
