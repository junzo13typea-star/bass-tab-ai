/**
 * BassTab AI - Realistic Electric Bass Synthesizer Engine
 * 
 * Web Audio API による高品質エレクトリックベース音源。
 * プラックアタック、倍音減衰、ウォームなアンプサチュレーションをシミュレート。
 */

export class BassSynth {
  constructor(audioContext = null) {
    this.ctx = audioContext;
    this.masterGain = null;
    this.activeVoices = new Map(); // voice management
  }

  init(ctx) {
    this.ctx = ctx;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;

    // ベースキャビネット＆プリアンプ EQ (Ampeg風 低域パンチと中域抜け)
    const lowShelf = this.ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 110;
    lowShelf.gain.value = 3.5;

    const midPeak = this.ctx.createBiquadFilter();
    midPeak.type = 'peaking';
    midPeak.frequency.value = 800;
    midPeak.Q.value = 1.2;
    midPeak.gain.value = 2.0;

    const highShelf = this.ctx.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 3800;
    highShelf.gain.value = -6.0;

    // わずかなチューブサチュレーション (暖かみと太さ)
    const distortion = this.ctx.createWaveShaper();
    distortion.curve = this.makeDistortionCurve(12);
    distortion.oversample = '2x';

    this.masterGain.connect(distortion);
    distortion.connect(lowShelf);
    lowShelf.connect(midPeak);
    midPeak.connect(highShelf);
    highShelf.connect(this.ctx.destination);
  }

  setVolume(val) {
    if (this.masterGain) {
      this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1.5, val)), this.ctx.currentTime);
    }
  }

  /**
   * ベースノートを発音
   * @param {number} midi MIDIノート番号 (例: 28 = E1)
   * @param {number} duration 秒単位の音長
   * @param {number} velocity 0.0〜1.0
   * @param {number} startTime 発音時刻 (ctx.currentTime基準、省略時は即座)
   */
  playNote(midi, duration = 0.5, velocity = 0.8, startTime = null) {
    if (!this.ctx) return;
    const now = startTime !== null ? startTime : this.ctx.currentTime;
    const freq = 440.0 * Math.pow(2, (midi - 69) / 12);

    // 1. 基音オシレーター (深い低音サイン波)
    const oscSub = this.ctx.createOscillator();
    oscSub.type = 'sine';
    oscSub.frequency.setValueAtTime(freq, now);

    // 2. 倍音オシレーター (弦の質感・ノコギリ波)
    const oscBody = this.ctx.createOscillator();
    oscBody.type = 'sawtooth';
    oscBody.frequency.setValueAtTime(freq, now);

    // 3. アタックピッキング・ノイズ (指・ピックのクリック感)
    const oscClick = this.ctx.createOscillator();
    oscClick.type = 'triangle';
    oscClick.frequency.setValueAtTime(freq * 4.0, now);
    oscClick.frequency.exponentialRampToValueAtTime(freq, now + 0.035);

    // 4. 動的ローパスフィルター (弦を弾いた瞬間のブライトさから徐々にウォームに減衰)
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const cutoffBase = Math.min(2200, freq * 7.5);
    filter.frequency.setValueAtTime(cutoffBase * 1.6, now);
    filter.frequency.exponentialRampToValueAtTime(cutoffBase * 0.45, now + 0.12);
    filter.frequency.exponentialRampToValueAtTime(cutoffBase * 0.25, now + Math.max(0.2, duration));
    filter.Q.value = 2.5;

    // 5. アンプ・エンベロープ (音量変化)
    const voiceGain = this.ctx.createGain();
    const peakGain = 0.65 * velocity;

    // アタック (急速立ち上がり 3ms)
    voiceGain.gain.setValueAtTime(0.001, now);
    voiceGain.gain.exponentialRampToValueAtTime(peakGain, now + 0.004);
    
    // ディケイ ＆ サステイン
    const sustainGain = peakGain * 0.65;
    voiceGain.gain.exponentialRampToValueAtTime(sustainGain, now + 0.08);

    // リリース (弦の自然な余韻減衰)
    const releaseDuration = 0.12;
    const noteEndTime = now + Math.max(0.08, duration);
    voiceGain.gain.setValueAtTime(sustainGain, noteEndTime);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, noteEndTime + releaseDuration);

    // クリック音エンベロープ
    const clickGain = this.ctx.createGain();
    clickGain.gain.setValueAtTime(0.35 * velocity, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);

    // ルーティング
    oscSub.connect(filter);
    oscBody.connect(filter);
    oscClick.connect(clickGain);
    clickGain.connect(filter);

    filter.connect(voiceGain);
    voiceGain.connect(this.masterGain);

    // 発音スタート
    oscSub.start(now);
    oscBody.start(now);
    oscClick.start(now);

    const stopTime = noteEndTime + releaseDuration + 0.05;
    oscSub.stop(stopTime);
    oscBody.stop(stopTime);
    oscClick.stop(stopTime);

    return { stop: () => {
      try {
        const stopNow = this.ctx.currentTime;
        voiceGain.gain.cancelScheduledValues(stopNow);
        voiceGain.gain.setValueAtTime(voiceGain.gain.value, stopNow);
        voiceGain.gain.exponentialRampToValueAtTime(0.0001, stopNow + 0.04);
        oscSub.stop(stopNow + 0.05);
        oscBody.stop(stopNow + 0.05);
        oscClick.stop(stopNow + 0.05);
      } catch (e) {}
    }};
  }

  makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 10;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }
}

