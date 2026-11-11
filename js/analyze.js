/* Mix health check: a readable loudness and true-peak report for a rendered mix.
   `analyzeMix` takes the mix as Float32Array channels plus the sample rate and resolves with
   the integrated loudness (BS.1770, reused from loudness.js — no second implementation), the
   sample peak (dBFS) and the true peak (dBTP). The true peak is measured on 4x-oversampled
   audio (the same windowed-sinc interpolation the limiter senses peaks with, see
   limiter-worklet.js), so the peaks between samples that a DAC or a lossy encoder will
   produce count too — never just the samples' absolute values.
   Runs in the page and in Node (the check script): long loops hand the main thread back
   through a message rather than a timer, for the same reason as in loudness.js (a hidden tab
   holds timers back for a second or more). Nothing here touches the playing mix. */

import { integratedLoudness } from './loudness.js';

export const OVERSAMPLING = 4; // the true peak is interpolated to 4x the sample rate
export const CEILING_DB = -1; // the limiter's ceiling: a mix over it is turned down

// 4x interpolation, 12 taps per phase — the same windowed-sinc taps as the limiter's peak
// sensing, so the report reads peaks the way the chain they play through does.
const PHASES = OVERSAMPLING, HALF = 6;
const TAPS = [1, 2, 3].map((p) => {
  const f = p / PHASES, taps = new Float64Array(2 * HALF);
  for (let k = 0; k < 2 * HALF; k++) {
    const t = f - (k - HALF + 1); // distance from the point to the k-th sample in the window
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    taps[k] = sinc * (0.5 + 0.5 * Math.cos(Math.PI * t / HALF));
  }
  const sum = taps.reduce((a, v) => a + v, 0);
  return taps.map((v) => v / sum); // unity gain at DC
});
// No interpolated point can be louder than the loudest sample in its window times BOUND (the
// taps' summed size), so a window whose peak can't beat the running maximum is skipped.
const BOUND = Math.max(...TAPS.map((t) => t.reduce((a, v) => a + Math.abs(v), 0)));

// Hands the main thread back between chunks, by message rather than timer (see loudness.js).
const yields = [];
const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
if (channel) channel.port1.onmessage = () => yields.shift()();
const breather = () => new Promise((resolve) => {
  if (!channel) { setTimeout(resolve); return; }
  yields.push(resolve);
  channel.port2.postMessage(0);
});

const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

// The sample peak and the 4x-oversampled true peak of one channel, in chunks so a whole
// 32-bar mix never holds the main thread for more than a few ms at a time.
async function channelPeaks(x) {
  const n = x.length, span = 2 * HALF, CHUNK = 1 << 16;
  let sample = 0, tp = 0;
  for (let from = 0; from < n; from += CHUNK) {
    const to = Math.min(n, from + CHUNK);
    for (let i = from; i < to; i++) {
      const a = Math.abs(x[i]);
      if (a > sample) sample = a;
      // The interval between x[i] and x[i+1], read from the window x[i-5 .. i+6] (zeros off the ends).
      let wmax = 0;
      for (let k = 0; k < span; k++) {
        const j = i - HALF + 1 + k;
        const v = j >= 0 && j < n ? Math.abs(x[j]) : 0;
        if (v > wmax) wmax = v;
      }
      if (wmax * BOUND <= tp) continue; // can't beat the running peak: skip the interpolation
      for (let p = 0; p < PHASES - 1; p++) {
        const taps = TAPS[p];
        let y = 0;
        for (let k = 0; k < span; k++) {
          const j = i - HALF + 1 + k;
          if (j >= 0 && j < n) y += taps[k] * x[j];
        }
        const ay = Math.abs(y);
        if (ay > tp) tp = ay;
      }
    }
    await breather();
  }
  // Phase 0 of the interpolation is the samples themselves, so the true peak never reads
  // below the sample peak.
  return { sample, tp: Math.max(tp, sample) };
}

// `channels` are Float32Arrays of one mix (e.g. left and right), `sampleRate` their rate.
// Resolves with:
//   lufs         integrated loudness (BS.1770), -Infinity for silence
//   samplePeakDb highest |sample|, dBFS (-Infinity for silence)
//   truePeakDb   highest 4x-oversampled peak, dBTP (-Infinity for silence)
//   oversampling the factor the true peak was interpolated at (4)
//   ceilingDb    the ceiling the `over` verdict compares against (-1 dBTP)
//   over         true when the true peak exceeds the ceiling
// Never rejects on quiet or empty input; rejects only on a nonsensical call (no channels).
export async function analyzeMix(channels, sampleRate) {
  if (!channels || !channels.length || !sampleRate) throw new Error('analyzeMix: no channels to analyze');
  const lufs = await integratedLoudness(channels, sampleRate);
  let sample = 0, tp = 0;
  for (const x of channels) {
    const p = await channelPeaks(x);
    if (p.sample > sample) sample = p.sample;
    if (p.tp > tp) tp = p.tp;
  }
  const truePeakDb = db(tp);
  return {
    lufs,
    samplePeakDb: db(sample),
    truePeakDb,
    oversampling: OVERSAMPLING,
    ceilingDb: CEILING_DB,
    over: truePeakDb > CEILING_DB,
  };
}
