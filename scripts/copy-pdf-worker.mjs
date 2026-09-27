import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const base = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const output = path.resolve('public/pdfjs');
mkdirSync(output, {recursive: true});
cpSync(path.join(base, 'build/pdf.worker.min.mjs'), path.join(output, 'pdf.worker.min.mjs'));
for (const dir of ['cmaps','standard_fonts','wasm']) cpSync(path.join(base,dir),path.join(output,dir),{recursive:true});
