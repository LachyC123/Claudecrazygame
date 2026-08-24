// Build a genuinely blind A/B comparison: copies two images to neutral names in
// randomized order and writes the answer key to a file the critic never reads.
// Usage: node tools/blindpair.mjs <ours.png> <reference.jpg> <outdir>
import fs from 'node:fs';
import path from 'node:path';

const [ours, ref, outdir = '/tmp/blind'] = process.argv.slice(2);
fs.mkdirSync(outdir, { recursive: true });
const flip = Math.random() < 0.5;
const A = flip ? ref : ours;
const B = flip ? ours : ref;
const extA = path.extname(A), extB = path.extname(B);
fs.copyFileSync(A, `${outdir}/image_A${extA}`);
fs.copyFileSync(B, `${outdir}/image_B${extB}`);
const key = { A: flip ? 'REFERENCE' : 'OURS', B: flip ? 'OURS' : 'REFERENCE', ours, ref };
fs.writeFileSync(`${outdir}/.key.json`, JSON.stringify(key, null, 2));
console.log(JSON.stringify({ imageA: `${outdir}/image_A${extA}`, imageB: `${outdir}/image_B${extB}` }));
