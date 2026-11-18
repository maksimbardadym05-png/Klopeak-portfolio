// Rendert index.html Bild für Bild zu MP4 (deterministisch, parallel).
// node render.js stills <outdir> t1 t2 ...   -> PNG-Standbilder
// node render.js video <out.mp4> [fps] [workers]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html') + '?render';
const DUR = 35;

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort()); // lokale Inter-Schrift verwenden
  await page.goto(PAGE);
  await page.evaluate(() => window.READY);
  return page;
}
async function shot(page, t) {
  await page.evaluate(tt => window.drawFrame(tt), t);
  return page.locator('#c').screenshot({ type: 'png' });
}

async function stills(outdir, times) {
  fs.mkdirSync(outdir, { recursive: true });
  const browser = await chromium.launch();
  const page = await openPage(browser);
  for (const t of times) {
    const buf = await shot(page, +t);
    fs.writeFileSync(path.join(outdir, `t${(+t).toFixed(2)}.png`), buf);
  }
  await browser.close();
}

async function chunk(browser, f0, f1, fps, out) {
  const page = await openPage(browser);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  // Für Zeiten nach dem Info-Übergang braucht die Seite den Unschärfe-Cache: einmal den Übergangszeitpunkt zeichnen
  for (let f = f0; f < f1; f++) {
    const buf = await shot(page, f / fps);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if ((f - f0) % 60 === 0) process.stdout.write(`[${out.slice(-10)}] ${f}/${f1}\n`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  await page.close();
}

async function video(out, fps = 30, workers = 4) {
  const total = Math.round(DUR * fps);
  const browser = await chromium.launch();
  const per = Math.ceil(total / workers);
  const tmpdir = path.resolve(path.dirname(out), '.chunks');
  fs.mkdirSync(tmpdir, { recursive: true });
  const parts = [];
  const jobs = [];
  for (let w = 0; w < workers; w++) {
    const f0 = w * per, f1 = Math.min(total, f0 + per);
    if (f0 >= f1) break;
    const p = path.join(tmpdir, `part${w}.mp4`);
    parts.push(p);
    jobs.push(chunk(browser, f0, f1, fps, p));
  }
  await Promise.all(jobs);
  await browser.close();
  const list = path.join(tmpdir, 'list.txt');
  fs.writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
  await new Promise((res, rej) => {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' });
    ff.on('close', c => c === 0 ? res() : rej(new Error('concat failed')));
  });
  fs.rmSync(tmpdir, { recursive: true, force: true });
  console.log('fertig:', out);
}

const [mode, a1, ...rest] = process.argv.slice(2);
(mode === 'stills' ? stills(a1, rest) : video(a1, +(rest[0] || 30), +(rest[1] || 4))).catch(e => { console.error(e); process.exit(1); });
