import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const source = path.join(path.dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json')), 'dist');
const destination = path.resolve('public/maplibre');
mkdirSync(destination, { recursive: true });
for (const name of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(path.join(source, name), path.join(destination, name));
}
