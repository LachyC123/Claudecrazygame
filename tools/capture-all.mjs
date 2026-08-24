// Capture every registered capture scene in one browser session.
// Usage: node tools/capture-all.mjs [--port 5173] [--out shots/round1] [--w 1920] [--h 1080]
//        [--scenes vista,combat,weapon,enemy,loot,hud]
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = get('--port', '5173');
const out = get('--out', 'shots/latest');
const W = parseInt(get('--w', '1600'), 10);
const H = parseInt(get('--h', '900'), 10);
const scenes = get('--scenes', 'vista,combat,weapon,enemy,loot,hud').split(',').filter(Boolean);
const timeout = parseInt(get('--timeout', '180000'), 10);

fs.mkdirSync(out, { recursive: true });
const EXE = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath: fs.existsSync(EXE) ? EXE : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});

const report = [];
for (const scene of scenes) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = `http://127.0.0.1:${port}/?capture=${scene}`;
  const t0 = Date.now();
  let status = 'ok';
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.__READY__ === true || window.__BOOT_ERROR__', { timeout });
    const bootErr = await page.evaluate('window.__BOOT_ERROR__ || null');
    if (bootErr) { status = 'BOOT_ERROR'; errors.unshift(bootErr); }
    await page.waitForTimeout(500);
  } catch (e) { status = 'TIMEOUT'; errors.unshift(e.message.split('\n')[0]); }
  const file = `${out}/${scene}.png`;
  await page.screenshot({ path: file });
  const stats = await page.evaluate(`(() => { try {
    const c = window.__CTX__; if (!c) return null;
    return { fps: Math.round(c.engine?.stats?.fps || 0), ms: +(c.engine?.stats?.ms||0).toFixed(1),
             calls: c.renderer.info.render.calls, tris: c.renderer.info.render.triangles,
             progs: c.renderer.info.programs?.length || 0,
             geoms: c.renderer.info.memory.geometries, texs: c.renderer.info.memory.textures };
  } catch(e) { return { err: String(e) }; } })()`);
  report.push({ scene, status, file, ms: Date.now() - t0, stats, errors: errors.slice(0, 6) });
  console.log(`${status === 'ok' ? '✓' : '✗'} ${scene} -> ${file} (${((Date.now()-t0)/1000).toFixed(1)}s)`
    + (stats ? ` calls=${stats.calls} tris=${stats.tris} fps=${stats.fps}` : '')
    + (errors.length ? `\n    ERR: ${errors.slice(0,3).join(' | ').slice(0,600)}` : ''));
  await page.close();
}
await browser.close();
fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
const bad = report.filter((r) => r.status !== 'ok').length;
console.log(`\n${report.length - bad}/${report.length} scenes captured cleanly -> ${out}/report.json`);
