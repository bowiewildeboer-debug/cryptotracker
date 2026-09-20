/**
 * Assembles the deployable site: the static app plus the JSON the nightly job produced.
 *
 *   node scripts/build-site.mjs [outDir]
 *
 * Deliberately a plain copy. The app has no build step, so what is tested locally is byte for
 * byte what GitHub Pages serves.
 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';

const out = process.argv[2] ?? '_site';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync('web', out, { recursive: true });
if (existsSync('data')) cpSync('data', `${out}/data`, { recursive: true });
else console.warn('no data/ directory - run the pipeline first or the app will show an error');

console.log(`built ${out}`);
