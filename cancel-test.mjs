// BassTab 解析キャンセル テスト (Node)
// 使い方: node cancel-test.mjs
// 実ファイル (New Life) の先頭30秒で、通常解析が完走することと、
// 進捗30%時点でトークンを立てると ANALYSIS_CANCELLED で速く止まることを検証する。
import { execFileSync } from 'node:child_process';
import { AudioAnalyzer } from './js/audio/analyzer.js';

const FILE = new URL('../user/files/12-___________12.mp3', import.meta.url).pathname;
const LIMIT_SEC = 30;

function decodeMono(file) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'], { maxBuffer: 1024 * 1024 * 1024 });
  const data = new Float32Array(buf.length / 4);
  for (let i = 0; i < data.length; i++) data[i] = buf.readFloatLE(i * 4);
  return { data, sampleRate: 44100 };
}
function biquad(type, freq, q, sampleRate) {
  const w = 2 * Math.PI * freq / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  let b0, b1, b2;
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
  else { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function applyBiquad(f, data) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
    f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
    out[i] = y;
  }
  return out;
}
function filterBassBand(data, sampleRate) {
  let d = applyBiquad(biquad('highpass', 35, 0.707, sampleRate), data);
  d = applyBiquad(biquad('lowpass', 320, 1.0, sampleRate), d);
  d = applyBiquad(biquad('lowpass', 320, 1.0, sampleRate), d);
  return d;
}

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };

const decoded = decodeMono(FILE);
const data = decoded.data.subarray(0, Math.floor(LIMIT_SEC * decoded.sampleRate));
const filtered = filterBassBand(data, decoded.sampleRate);
const fakeBuffer = {
  duration: LIMIT_SEC,
  sampleRate: decoded.sampleRate,
  getChannelData: () => filtered
};

const analyzer = new AudioAnalyzer();

// 1. 通常解析 (トークンなし) は完走する
const t0 = Date.now();
const notes = await analyzer.analyzeBassline(fakeBuffer, null, {});
const fullMs = Date.now() - t0;
check(`通常解析が完走する (notes=${notes.length})`, notes.length > 0);

// 2. 進捗30%でキャンセル → ANALYSIS_CANCELLED で中断し、完走より速い
const token = { cancelled: false };
const t1 = Date.now();
let caught = null;
try {
  await analyzer.analyzeBassline(fakeBuffer, (pct) => { if (pct >= 0.3) token.cancelled = true; }, { cancelToken: token });
} catch (e) { caught = e; }
const cancelMs = Date.now() - t1;
check('キャンセルで ANALYSIS_CANCELLED が投げられる', !!caught && caught.code === 'ANALYSIS_CANCELLED');
check(`キャンセルは完走より速く止まる (${cancelMs}ms < ${fullMs}ms)`, cancelMs < fullMs);

// 3. 最初から cancelled なトークンでも中断する (進捗コールバックなし経路)
let caught2 = null;
try {
  await analyzer.analyzeBassline(fakeBuffer, null, { cancelToken: { cancelled: true } });
} catch (e) { caught2 = e; }
check('事前キャンセルでも中断する', !!caught2 && caught2.code === 'ANALYSIS_CANCELLED');

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
