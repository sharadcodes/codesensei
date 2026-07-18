import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Copy naudiodon2 native binding + PortAudio DLL to dist/native/
const releaseDir = join(root, 'node_modules', 'naudiodon2', 'build', 'Release');
const destDir = join(root, 'dist', 'native');

if (!existsSync(releaseDir)) {
  console.error('Warning: naudiodon2 build directory not found at', releaseDir);
  console.error('Run: npx node-gyp rebuild --directory=node_modules/naudiodon2');
  process.exit(0); // Don't fail the build, just warn
}

mkdirSync(destDir, { recursive: true });

// Copy all .node and .dll files from the Release directory
const files = readdirSync(releaseDir).filter(
  (f) => f.endsWith('.node') || f.endsWith('.dll')
);

for (const file of files) {
  const src = join(releaseDir, file);
  const dest = join(destDir, file);
  copyFileSync(src, dest);
  console.log(`Copied ${file} to dist/native/`);
}
