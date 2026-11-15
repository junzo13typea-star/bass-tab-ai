/**
 * メトロノーム / カウントインのスケジューリング検証 (モック AudioContext)
 * 実行: node metronome-test.mjs
 */
import { SyncPlayer } from './js/audio/player.js';

const clicks = []; // {t, freq}

class FakeParam {
  constructor() { this.value = 0; }
  setValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
}
class FakeOsc {
  constructor() { this.frequency = new FakeParam(); this.type = ''; }
  connect() {}
  start(t) { clicks.push({ t, freq: this.frequency.value }); }
  stop() {}
}
class FakeGain {
  constructor() { this.gain = new FakeParam(); }
  connect() {}
}
const ctx = {
  currentTime: 0,
  state: 'running',
  destination: {},
  resume() {},
  createGain: () => new FakeGain(),
  createOscillator: () => new FakeOsc(),
  createBufferSource: () => ({
    connect() {}, start() {}, stop() {}, disconnect() {},
    playbackRate: new FakeParam(), buffer: null, onended: null
  })
};
globalThis.requestAnimationFrame = () => {};

const synth = { playNote() {}, setVolume() {} };
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(a - b) < 1e-6;

// --- 1. メトロノームのグリッドとアクセント ---
clicks.length = 0;
const p = new SyncPlayer(ctx, synth);
p.loadTrack(null, [{ time: 30, midi: 40, duration: 0.4 }]); // duration = 32
p.setMetronomeGrid(120, 0.5, 4); // 1拍0.5秒、拍は 0.5, 1.0, 1.5, ...
p.setMetronomeEnabled(true);
ctx.currentTime = 0;
p.play();
for (let t = 0; t <= 3.0; t += 0.1) {
  ctx.currentTime = t;
  p.runScheduler();
}
const times = clicks.map(c => Math.round(c.t * 1000) / 1000);
// グリッドは offset=0.5 から前方向にも伸びるため 0.0 の拍も鳴る
check('クリック時刻が拍グリッド通り', JSON.stringify(times.slice(0, 5)) === JSON.stringify([0, 0.5, 1, 1.5, 2]));
check('小節頭 (0.5) がアクセント', clicks[1].freq === 1760);
check('2拍目 (1.0) は通常音', clicks[2].freq === 1175);
check('次の小節頭 (2.5) がアクセント', clicks[5].freq === 1760);
p.pause();
check('一時停止で予約クリックが消える', p.pendingClicks.length === 0);

// --- 2. カウントイン (4拍入ってから開始位置に到達) ---
clicks.length = 0;
const p2 = new SyncPlayer(ctx, synth);
p2.loadTrack(null, [{ time: 30, midi: 40, duration: 0.4 }]);
p2.setMetronomeGrid(120, 0.5, 4);
p2.setCountInEnabled(true);
p2.seek(4.0); // 開始位置 4.0 秒 (一時停止中)
ctx.currentTime = 10;
p2.play({ countIn: true }); // カウントイン 4拍 = 2秒 → 12秒に開始位置到達
const ci = clicks.map(c => Math.round(c.t * 1000) / 1000);
check('カウントインは4クリック', ci.length === 4);
check('カウントイン時刻 (10, 10.5, 11, 11.5)', JSON.stringify(ci) === JSON.stringify([10, 10.5, 11, 11.5]));
check('カウントイン先頭がアクセント', clicks[0].freq === 1760);
check('開始位置到達時刻 = 12', near(p2.countInEndCtxTime, 12));
ctx.currentTime = 11; // カウントイン途中
p2.runAnimationLoop();
check('カウントイン中は現在時刻が開始位置に留まる', near(p2.currentTime, 4.0));
ctx.currentTime = 12.5; // 開始後0.5秒
p2.runAnimationLoop();
check('開始後は通常再生 (4.5秒)', near(p2.currentTime, 4.5));
p2.pause();

// --- 3. カウントインなし指定では入らない ---
clicks.length = 0;
const p3 = new SyncPlayer(ctx, synth);
p3.loadTrack(null, [{ time: 30, midi: 40, duration: 0.4 }]);
p3.setMetronomeGrid(120, 0.5, 4);
p3.setCountInEnabled(true);
ctx.currentTime = 20;
p3.play(); // options なし (シーク等の内部リスタート相当)
check('内部リスタートではカウントインなし', clicks.length === 0 && p3.countInEndCtxTime === 0);
p3.pause();

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
