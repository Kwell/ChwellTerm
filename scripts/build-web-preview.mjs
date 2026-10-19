import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  configFile: false,
  root,
  base: './',
  publicDir: false,
  plugins: [react()],
  build: {
    write: false,
    target: ['es2022', 'chrome105', 'safari14'],
    cssCodeSplit: false,
    assetsInlineLimit: Infinity,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
if (Array.isArray(result) || !('output' in result)) throw new Error('Expected a single web preview build.');
const outputs = result.output;
const entry = outputs.find(item => item.type === 'asset' && item.fileName === 'index.html');
if (!entry) throw new Error('Missing preview HTML.');
let html = String(entry.source);
html = html.replace(/<script\b[^>]*\bsrc="\.\/([^\"]+)"[^>]*><\/script>/g, (_, name) => {
  const chunk = outputs.find(item => item.type === 'chunk' && item.fileName === name);
  if (!chunk || chunk.type !== 'chunk') throw new Error(`Missing script: ${name}`);
  return `<script type="module">${chunk.code.replace(/<\/script/gi, '<\\/script')}</script>`;
});
html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\.\/([^\"]+)"[^>]*>/g, (_, name) => {
  const css = outputs.find(item => item.type === 'asset' && item.fileName === name);
  if (!css || css.type !== 'asset') throw new Error(`Missing stylesheet: ${name}`);
  return `<style>${String(css.source).replace(/<\/style/gi, '<\\/style')}</style>`;
});
const icon = await readFile(join(root, 'public/app-icon.svg'));
html = html.replace(/(<link\b[^>]*\brel="icon"[^>]*\bhref=")[^"]+("[^>]*>)/, `$1data:image/svg+xml;base64,${icon.toString('base64')}$2`);
if (/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref="(?:\.\/)?assets\//i.test(html)) {
  throw new Error('Preview still references external build assets.');
}
const outputDir = join(root, 'output/web');
await mkdir(outputDir, { recursive: true });
const outputPath = join(outputDir, 'ChwellTerm.html');
await writeFile(outputPath, html);
console.log(`Standalone browser preview: ${outputPath}`);
