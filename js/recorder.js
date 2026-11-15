/**
 * マイク録音: getUserMedia + MediaRecorder でその場の演奏を録音し、
 * 既存の解析フロー (processUploadedFile) に渡せる File を返す。
 * 音楽の採譜用途なので、ブラウザの音声加工 (エコー除去・ノイズ抑制・自動ゲイン) は切る。
 * ブラウザAPIは globalThis 経由で参照し、Nodeテストから差し替えられるようにしている。
 */

export const RECORD_MAX_SEC = 600; // 録音の上限 (10分)

export class MicRecorder {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mimeType = '';
    this.analyser = null;
    this._levelData = null;
  }

  static isSupported() {
    return !!(globalThis.navigator && globalThis.navigator.mediaDevices &&
      typeof globalThis.navigator.mediaDevices.getUserMedia === 'function' &&
      typeof globalThis.MediaRecorder === 'function');
  }

  get recording() {
    return !!this.recorder && this.recorder.state === 'recording';
  }

  /** 経過秒数 */
  elapsedSec() {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  /**
   * 録音開始。audioContext を渡すと入力レベルメーター (getLevel) が使える。
   * マイク許可が得られない場合は元のエラー (NotAllowedError 等) をそのまま投げる。
   */
  async start(audioContext = null) {
    if (this.recording) return;
    this.stream = await globalThis.navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    const MR = globalThis.MediaRecorder;
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', ''];
    this.mimeType = candidates.find(t => t === '' || (typeof MR.isTypeSupported === 'function' && MR.isTypeSupported(t))) || '';
    this.recorder = this.mimeType ? new MR(this.stream, { mimeType: this.mimeType }) : new MR(this.stream);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
    if (audioContext) {
      try {
        const src = audioContext.createMediaStreamSource(this.stream);
        this.analyser = audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        src.connect(this.analyser);
        this._levelData = new Uint8Array(this.analyser.fftSize);
      } catch (e) {
        this.analyser = null; // メーターが作れなくても録音は続ける
      }
    }
    this.startedAt = Date.now();
    this.recorder.start(250);
  }

  /** 入力レベル (0.0〜1.0 のRMS)。メーター未接続なら 0 */
  getLevel() {
    if (!this.analyser || !this._levelData) return 0;
    this.analyser.getByteTimeDomainData(this._levelData);
    let sum = 0;
    for (let i = 0; i < this._levelData.length; i++) {
      const v = (this._levelData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this._levelData.length) * 3);
  }

  /**
   * 録音停止。録音データの File を返す (ファイル名は日時ベース)。
   * 録音していない場合は null。
   */
  async stop() {
    if (!this.recorder) return null;
    const recorder = this.recorder;
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    const type = this.mimeType || recorder.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });
    this._cleanup();
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `録音 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
    return new File([blob], name, { type });
  }

  /** 録音を破棄して止める (エラー時など) */
  cancel() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch (e) { /* 既に停止済みなら無視 */ }
    }
    this._cleanup();
  }

  _cleanup() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) { try { track.stop(); } catch (e) { /* 無視 */ } }
    }
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.analyser = null;
    this._levelData = null;
  }
}
