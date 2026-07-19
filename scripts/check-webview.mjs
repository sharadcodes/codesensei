import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/ui/homeView.ts', 'utf8');
const match = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/);
if (!match) throw new Error('Could not locate the home webview script.');
const script = match[1].replace(/\\`/g, '`').replace(/\\\$\{/g, '${');
new vm.Script(script, { filename: 'homeView.webview.js' });
console.log('Webview script syntax OK');
