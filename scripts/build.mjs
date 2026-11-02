import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import { prepareReaderAssets } from './prepare-reader.mjs';

const files = ['index.html', 'styles.css', 'app.js', 'task-store.js', 'completion-sound.js', 'sw.js', 'manifest.webmanifest', 'icons', '.nojekyll'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
for (const file of files) await cp(file, `dist/${file}`, { recursive: true });
await prepareReaderAssets();
await mkdir('dist/reader');
for (const file of ['index.html', 'styles.css', 'app.js', 'pdf-loader.js', 'dedupe.js', 'speech.js', 'icon.svg', 'vendor']) {
  await cp(`reader/${file}`, `dist/reader/${file}`, { recursive: true });
}
const manifest = JSON.parse(await readFile('dist/manifest.webmanifest', 'utf8'));
for (const icon of manifest.icons) await readFile(`dist/${icon.src.replace(/^\.\//, '')}`);
console.log('Built dist/: Gone at / and Slidecast at /reader/.');
