import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const generated = join(root, '.tools', 'generated-icons');
mkdirSync(generated, { recursive: true });
execFileSync(process.execPath, [
  join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
  'icon', join(root, 'public', 'app-icon.svg'), '--output', generated,
], { cwd: root, stdio: 'inherit' });

const ico = readFileSync(join(generated, 'icon.ico'));
if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('Invalid ICO header');
const count = ico.readUInt16LE(4);
const entries = Array.from({ length: count }, (_, index) => Buffer.from(ico.subarray(6 + index * 16, 22 + index * 16)));
// Tauri decodes only the first ICO entry for the live window icon. Put the
// largest image first so the taskbar never enlarges a 16 px source. Retain
// all other sizes and their original payload offsets for Windows Explorer.
const area = entry => (entry[0] || 256) * (entry[1] || 256);
entries.sort((a, b) => area(b) - area(a));
entries.forEach((entry, index) => entry.copy(ico, 6 + index * 16));
writeFileSync(join(root, 'src-tauri', 'icons', 'icon.ico'), ico);
for (const name of ['icon.png', 'icon.icns']) copyFileSync(join(generated, name), join(root, 'src-tauri', 'icons', name));
console.log(`Windows default icon: ${entries[0][0] || 256} × ${entries[0][1] || 256}; ${count} sizes retained.`);
