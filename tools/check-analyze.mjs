// Local check for js/analyze.js, on made-up signals only (no stem files needed).
// Run from anywhere with Node 18+:   node tools/check-analyze.mjs
// Exits 0 when every check passes, 1 otherwise.

import { analyzeMix, OVERSAMPLING, CEILING_DB } from '../js/analyze.js';

const SR = 44100;
const sine = (freq, amp, secs, phase = 0) => {
  const n = Math.round(SR * secs);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return x;
};
const stereo = (x) => [x, x];
const at = (db) => Math.pow(10, db / 20); // dB to linear amplitude

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
const f2 = (v) => (v === -Infinity ? '-inf' : v.toFixed(2));

// 1. A full-scale sine: the true peak must not read below the sample peak, and where the
//    crest falls between samples it must read above it. At sr/4 with phase pi/4 every sample
//    sits at +/-A*sqrt(1/2) (-3.01 dBFS) while the crest between them reaches A (0 dBTP).
{
  const r = await analyzeMix(stereo(sine(SR / 4, 1.0, 1.0, Math.PI / 4)), SR);
  check('full-scale sine: true peak >= sample peak', r.truePeakDb >= r.samplePeakDb - 1e-9,
    `tp=${f2(r.truePeakDb)} dBTP, sp=${f2(r.samplePeakDb)} dBFS`);
  check('full-scale sine: intersample crest found (tp well above sp)', r.truePeakDb > r.samplePeakDb + 1,
    `tp=${f2(r.truePeakDb)} dBTP, sp=${f2(r.samplePeakDb)} dBFS`);
  check('full-scale sine: true peak ~= 0 dBTP', Math.abs(r.truePeakDb) < 0.15, `tp=${f2(r.truePeakDb)} dBTP`);
  check(`oversampling factor is reported (${OVERSAMPLING}x)`, r.oversampling === OVERSAMPLING && OVERSAMPLING >= 2);
}

// 2. Silence: loudness and both peaks come back as -Infinity, and nothing is "over".
{
  const r = await analyzeMix(stereo(new Float32Array(SR)), SR);
  check('silence: integrated loudness is -Infinity', r.lufs === -Infinity);
  check('silence: sample peak is -Infinity', r.samplePeakDb === -Infinity);
  check('silence: true peak is -Infinity', r.truePeakDb === -Infinity);
  check('silence: not over the ceiling', r.over === false);
}

// 3. Loudness is a real BS.1770 measurement (reused from js/loudness.js): halving the
//    amplitude of a steady tone costs it 6.02 dB, and a full-scale tone reads in a sane range.
{
  const a = await analyzeMix(stereo(sine(1000, 1.0, 2.0)), SR);
  const b = await analyzeMix(stereo(sine(1000, 0.5, 2.0)), SR);
  check('1 kHz stereo sine at full scale: loudness in a sane range', a.lufs > -3 && a.lufs < 2, `${f2(a.lufs)} LUFS`);
  check('halving the amplitude: -6.02 LU', Math.abs(a.lufs - b.lufs - 6.0206) < 0.1,
    `${f2(a.lufs)} -> ${f2(b.lufs)} LUFS`);
}

// 4. The -1 dBTP verdict on boundary samples: a tone whose true peak sits exactly on the
//    ceiling is not "over"; a touch above it is, a touch below is not. (At 1 kHz the short
//    interpolator reads the crest to within a ten-thousandth of a dB, so the exact-ceiling
//    case stays "not over".)
{
  const exact = await analyzeMix(stereo(sine(1000, at(CEILING_DB), 1.0)), SR);
  check(`tone at exactly ${CEILING_DB} dBTP: read back at the ceiling`, Math.abs(exact.truePeakDb - CEILING_DB) < 0.1,
    `tp=${f2(exact.truePeakDb)} dBTP`);
  check(`tone at exactly ${CEILING_DB} dBTP: not over`, exact.over === false);
  const above = await analyzeMix(stereo(sine(1000, at(CEILING_DB + 0.2), 1.0)), SR);
  check(`tone at ${CEILING_DB + 0.2} dBTP: over`, above.over === true, `tp=${f2(above.truePeakDb)} dBTP`);
  const below = await analyzeMix(stereo(sine(1000, at(CEILING_DB - 0.2), 1.0)), SR);
  check(`tone at ${CEILING_DB - 0.2} dBTP: not over`, below.over === false, `tp=${f2(below.truePeakDb)} dBTP`);
}

// 5. A clipped sample: a 1.3x sine hard-clipped at +/-1. Sample and true peak both sit at
//    0 dB, over the ceiling.
{
  const x = sine(440, 1.3, 1.0);
  for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i]));
  const r = await analyzeMix(stereo(x), SR);
  check('clipped sine: sample peak at 0 dBFS', Math.abs(r.samplePeakDb) < 0.01, `sp=${f2(r.samplePeakDb)} dBFS`);
  check('clipped sine: true peak >= sample peak', r.truePeakDb >= r.samplePeakDb - 1e-9,
    `tp=${f2(r.truePeakDb)} dBTP, sp=${f2(r.samplePeakDb)} dBFS`);
  check('clipped sine: over the ceiling', r.over === true, `tp=${f2(r.truePeakDb)} dBTP`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
