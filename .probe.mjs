import { chromium } from 'playwright';
import fs from 'node:fs';
const EXE='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: fs.existsSync(EXE)?EXE:undefined,
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--no-sandbox','--disable-dev-shm-usage']});
const page = await browser.newPage({ viewport:{width:1280,height:720}, deviceScaleFactor:1 });
page.on('console', m=>console.log('['+m.type()+']', m.text()));
page.on('pageerror', e=>console.log('[pageerror]', e.message));
const t0=Date.now();
await page.goto(process.argv[2]||'http://127.0.0.1:5180/?capture=vista',{waitUntil:'load',timeout:90000});
console.log('load', Date.now()-t0);
try { await page.waitForFunction('window.__READY__===true||window.__BOOT_ERROR__',null,{timeout:240000, polling:500}); }
catch(e){ console.log('WAITERR', e.message.slice(0,200)); }
console.log('ready at', Date.now()-t0, await page.evaluate('!!window.__READY__'), await page.evaluate('window.__BOOT_ERROR__||null'));
await page.evaluate(()=>console.log('STATS '+JSON.stringify(window.__PFX_STATS__)));
await page.screenshot({path: process.argv[3]||'/tmp/shot-render.png'});
await browser.close();
