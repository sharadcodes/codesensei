import { logger } from '../logger';

/**
 * Generate a short beep WAV buffer (sine wave).
 * Default: 880Hz, 150ms, 16-bit PCM mono at 44100Hz.
 */
function generateBeepWav(freqHz = 880, durationMs = 150, sampleRate = 44100): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const headerSize = 44;
  const buf = Buffer.alloc(headerSize + dataSize);

  // WAV header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);       // PCM chunk size
  buf.writeUInt16LE(1, 20);        // audio format = PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  // Generate sine wave with fade in/out
  const fadeSamples = Math.floor(sampleRate * 0.005); // 5ms fade
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let amp = Math.sin(2 * Math.PI * freqHz * t);
    // Fade in/out to avoid clicks
    if (i < fadeSamples) amp *= i / fadeSamples;
    else if (i > numSamples - fadeSamples) amp *= (numSamples - i) / fadeSamples;
    const sample = Math.round(amp * 0.3 * 32767); // 30% volume
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

/**
 * Play a short beep via the webview AudioContext. Non-blocking — fires and forgets.
 * @param sink An object with a playBeepWav(base64) method (e.g. HomeViewProvider)
 */
export function playBeep(sink: { playBeepWav(base64: string): void }): void {
  try {
    const wav = generateBeepWav(880, 150);
    sink.playBeepWav(wav.toString('base64'));
  } catch (e) {
    logger.error(`[beep] Failed: ${(e as Error).message}`);
  }
}

/**
 * Play a double beep (high-low) to signal "listening" state.
 * @param sink An object with a playBeepWav(base64) method (e.g. HomeViewProvider)
 */
export function playListeningBeep(sink: { playBeepWav(base64: string): void }): void {
  try {
    // High beep (880Hz) then low beep (660Hz) — like "go ahead"
    const wav1 = generateBeepWav(880, 100);
    const wav2 = generateBeepWav(660, 100);
    const combined = Buffer.concat([wav1, generateBeepWav(440, 50), wav2]); // gap tone at low volume
    sink.playBeepWav(combined.toString('base64'));
  } catch (e) {
    logger.error(`[beep] Failed: ${(e as Error).message}`);
  }
}
