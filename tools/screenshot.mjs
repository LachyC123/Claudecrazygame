// Headless screenshot harness. Usage:
//   node tools/screenshot.mjs <url> <outfile> [--wait ms] [--w px] [--h px] [--script "js"]
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const url = args[0] || 'http://localhost:5173/';
const out = args[1] || 'shots/shot.png';
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const wait = parseInt(getArg('--wait', '120000'), 10);
const W = parseInt(getArg('--w', '1920'), 10);
const H = parseInt(getArg('--h', '1080'), 10);
const script = getArg('--script', null);

fs.mkdirSync(out.replace(/\/[^/]+$/, '') || '.', { recursive: true });

const EXE = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: fs.existsSync(EXE) ? EXE : undefined,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'load', timeout: 90000 });
// Prefer the deterministic READY signal; fall back to a fixed wait.
try {
  await page.waitForFunction('window.__READY__ === true || window.__BOOT_ERROR__', { timeout: wait });
} catch { logs.push('[warn] READY signal timed out, capturing anyway'); }
const bootErr = await page.evaluate('window.__BOOT_ERROR__ || null');
if (bootErr) logs.push('[BOOT_ERROR] ' + bootErr);
await page.waitForTimeout(600);
if (script) { try { await page.evaluate(script); await page.waitForTimeout(1200); } catch (e) { logs.push(`[script] ${e.message}`); } }
await page.screenshot({ path: out });
await browser.close();
console.log(logs.join('\n'));
console.log(`saved ${out}`);
