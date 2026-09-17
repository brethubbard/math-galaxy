// shell.test.js — regression guards for a DEPLOY-SKEW bug, not a logic bug.
//
// Symptom: a returning child tapped "⚡ Fluency Run" and nothing happened. The
// service worker served navigations network-first but everything else
// cache-first, so the NEW index.html ran the OLD cached js/app.js + styles.css.
// The old styles.css has no `[hidden]` override and `.btn` sets display:flex, so
// the button rendered; the old app.js binds no handler for it, so tapping it did
// nothing. Two independent guards, one test each.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

describe('service worker', () => {
  const sw = read('sw.js');

  it('serves the app shell network-first so HTML, JS and CSS share a deploy', () => {
    // No `caches.match()` may win ahead of the network for same-origin shell
    // requests — that is exactly what produced the skew.
    const shell = sw.slice(sw.indexOf('if (sameOrigin) {'));
    expect(shell).toContain('fetch(req)');
    expect(shell.indexOf('fetch(req)')).toBeLessThan(shell.indexOf('caches.match(req'));
  });

  it('still serves the 40 MB voice model cache-first', () => {
    const model = sw.slice(sw.indexOf("'/models/'"));
    expect(model).toMatch(/caches\.match\(req\)\.then\(\(cached\) => cached \|\| fetch\(req\)\)/);
  });

  it('precaches every shell file the page actually loads', () => {
    // index.html's own <link>/<script> refs, plus every module they statically
    // import — an un-precached one would simply be missing offline.
    const refs = new Set(
      [...read('index.html').matchAll(/(?:src|href)="(?!https?:|\/\/)\.?\/?([^"#?]+)"/g)]
        .map((m) => m[1])
        .filter((f) => /\.(js|css|webmanifest)$/.test(f))
    );
    for (const f of fs.readdirSync(path.join(root, 'js'))) {
      for (const m of read(`js/${f}`).matchAll(/^import[^']*'\.\/([^']+\.js)'/gm)) {
        refs.add(`js/${m[1]}`);
      }
    }
    expect(refs.size).toBeGreaterThan(3);
    for (const f of refs) expect(sw, `${f} is not precached`).toContain(`'./${f}'`);
  });
});

describe('fluency button', () => {
  it('is hidden without depending on styles.css being current', () => {
    // `hidden` alone is overridden by `.btn { display: flex }`, so a stale
    // stylesheet would show a button that nothing is listening to.
    const btn = read('index.html').match(/<button[^>]*id="btn-fluency"[^>]*>/)[0];
    expect(btn).toContain('hidden');
    expect(btn).toMatch(/style="display:\s*none"/);
  });

  it('is revealed through the inline style, not just the attribute', () => {
    const app = read('js/app.js');
    const fn = app.slice(app.indexOf('function renderFluencyButton'));
    expect(fn.slice(0, fn.indexOf('if (!rec.cleared) return;')))
      .toContain("btn.style.display = rec.cleared ? '' : 'none';");
  });

  it('keeps the [hidden] override in styles.css as the belt to that braces', () => {
    expect(read('styles.css')).toContain('[hidden] { display: none !important; }');
  });
});
