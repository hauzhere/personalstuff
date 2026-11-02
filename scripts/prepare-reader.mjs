import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function prepareReaderAssets() {
  const source = resolve('node_modules/pdfjs-dist');
  const target = resolve('reader/vendor');
  await mkdir(target, { recursive: true });
  for (const name of ['pdf.mjs', 'pdf.worker.mjs']) await cp(`${source}/build/${name}`, `${target}/${name}`);
  for (const name of ['cmaps', 'standard_fonts', 'wasm']) await cp(`${source}/${name}`, `${target}/${name}`, { recursive: true });
  await cp(`${source}/LICENSE`, `${target}/LICENSE`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await prepareReaderAssets();
