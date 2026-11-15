// BassTab マイク録音 テスト (Node)
// 使い方: node recorder-test.mjs
// ブラウザAPI (getUserMedia / MediaRecorder / AudioContext) をスタブして
// js/recorder.js の開始・停止・File生成・後片付け・レベルメーターを検証する。
import { MicRecorder, RECORD_MAX_SEC } from './js/recorder.js';

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };

// --- スタブ ---
let stoppedTracks = 0;
const fakeStream = {
  getTracks: () => [{ stop: () => { stoppedTracks++; } }]
};
let lastConstraints = null;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: {
    mediaDevices: {
      getUserMedia: async (constraints) => { lastConstraints = constraints; return fakeStream; }
    }
  }
});
class FakeMediaRecorder {
  static isTypeSupported(t) { return t.includes('webm'); }
  constructor(stream, opts) { this.state = 'inactive'; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: new Blob(['fake-audio-data']) });
    if (this.onstop) setTimeout(() => this.onstop(), 0);
  }
}
globalThis.MediaRecorder = FakeMediaRecorder;
const fakeAudioContext = {
  createMediaStreamSource: () => ({ connect: () => {} }),
  createAnalyser: () => ({
    fftSize: 2048,
    getByteTimeDomainData: (arr) => { arr.fill(200); } // 一定レベルの信号
  })
};

// 対応判定
check('isSupported が true', MicRecorder.isSupported() === true);

// 開始 → 録音中フラグ・制約 (音声加工OFF) ・レベル
const rec = new MicRecorder();
await rec.start(fakeAudioContext);
check('録音中になる', rec.recording === true);
check('音声加工が無効化されている', !!lastConstraints && lastConstraints.audio.echoCancellation === false && lastConstraints.audio.noiseSuppression === false && lastConstraints.audio.autoGainControl === false);
check('レベルメーターが正の値を返す', rec.getLevel() > 0);
check('経過時間が進む', rec.elapsedSec() >= 0);

// 停止 → File が返り、後片付けされる
const file = await rec.stop();
check('File が返る', !!file && typeof file.name === 'string');
check('ファイル名が「録音」で始まり .webm', /^録音 .*\.webm$/.test(file.name));
check('データが入っている', !!file && file.size > 0);
check('マイクのトラックが止まる', stoppedTracks === 1);
check('停止後は録音中ではない', rec.recording === false);

// 録音していない状態で stop すると null
const rec2 = new MicRecorder();
check('未録音の stop は null', (await rec2.stop()) === null);

// マイク許可が拒否されたらエラーが伝播する
globalThis.navigator.mediaDevices.getUserMedia = async () => { throw new Error('NotAllowedError'); };
const rec3 = new MicRecorder();
let threw = false;
try { await rec3.start(); } catch (e) { threw = true; }
check('許可拒否はエラーになる', threw && rec3.recording === false);

// 未対応環境の判定
const savedMR = globalThis.MediaRecorder;
globalThis.MediaRecorder = undefined;
check('MediaRecorder がなければ isSupported は false', MicRecorder.isSupported() === false);
globalThis.MediaRecorder = savedMR;

check('録音上限は600秒', RECORD_MAX_SEC === 600);

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
