import { readFileSync } from 'node:fs';

const [target, file] = process.argv.slice(2);

if (!target || !file) {
  console.error('Usage: node scripts/verify-native-arch.mjs <target> <native-addon>');
  process.exit(2);
}

const expected = new Map([
  ['darwin-arm64', { format: 'Mach-O', arch: 'arm64' }],
  ['darwin-x64', { format: 'Mach-O', arch: 'x64' }],
  ['linux-x64', { format: 'ELF', arch: 'x64' }],
  ['win32-x64', { format: 'PE', arch: 'x64' }],
]).get(target);

if (!expected) {
  console.error(`Unsupported release target: ${target}`);
  process.exit(2);
}

const data = readFileSync(file);
const actual = detectArchitecture(data);

if (actual.format !== expected.format || actual.arch !== expected.arch) {
  console.error(
    `Native addon mismatch for ${target}: expected ${expected.format}/${expected.arch}, ` +
    `got ${actual.format}/${actual.arch}`
  );
  process.exit(1);
}

console.log(`Verified ${file}: ${actual.format}/${actual.arch} for ${target}`);

function detectArchitecture(data) {
  if (data.length < 64) return { format: 'unknown', arch: 'unknown' };

  // Thin 64-bit Mach-O. Universal binaries are intentionally rejected because
  // the extension's native addon should contain exactly its declared target.
  const machMagic = data.readUInt32LE(0);
  if (machMagic === 0xfeedfacf) {
    const cpuType = data.readUInt32LE(4);
    if (cpuType === 0x0100000c) return { format: 'Mach-O', arch: 'arm64' };
    if (cpuType === 0x01000007) return { format: 'Mach-O', arch: 'x64' };
    return { format: 'Mach-O', arch: `cpu-0x${cpuType.toString(16)}` };
  }

  // ELF64 e_machine values: EM_X86_64=62, EM_AARCH64=183.
  if (data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = data.readUInt16LE(18);
    if (machine === 62) return { format: 'ELF', arch: 'x64' };
    if (machine === 183) return { format: 'ELF', arch: 'arm64' };
    return { format: 'ELF', arch: `machine-${machine}` };
  }

  // PE/COFF machine values: AMD64=0x8664, ARM64=0xaa64.
  if (data[0] === 0x4d && data[1] === 0x5a) {
    const peOffset = data.readUInt32LE(0x3c);
    if (peOffset + 6 <= data.length && data.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0') {
      const machine = data.readUInt16LE(peOffset + 4);
      if (machine === 0x8664) return { format: 'PE', arch: 'x64' };
      if (machine === 0xaa64) return { format: 'PE', arch: 'arm64' };
      return { format: 'PE', arch: `machine-0x${machine.toString(16)}` };
    }
  }

  return { format: 'unknown', arch: 'unknown' };
}
