import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Copy the naudiodon2 binding and its adjacent PortAudio runtime library.
// The addon uses @loader_path/@rpath on macOS (and an adjacent rpath on
// Linux), so these files must remain together in the packaged extension.
const releaseDir = join(root, 'node_modules', 'naudiodon2', 'build', 'Release');
const destDir = join(root, 'dist', 'native');

if (!existsSync(releaseDir)) {
  console.error('Warning: naudiodon2 build directory not found at', releaseDir);
  console.error('Run: npx node-gyp rebuild --directory=node_modules/naudiodon2');
  process.exit(0); // Don't fail the build, just warn
}

mkdirSync(destDir, { recursive: true });

// Copy the addon plus platform-specific shared libraries.
const files = readdirSync(releaseDir).filter(
  (f) =>
    f.endsWith('.node') ||
    f.endsWith('.dll') ||
    f.endsWith('.dylib') ||
    /\.so(?:\.\d+)*$/.test(f)
);

for (const file of files) {
  const src = join(releaseDir, file);
  const dest = join(destDir, file);
  copyFileSync(src, dest);
  console.log(`Copied ${file} to dist/native/`);
}
