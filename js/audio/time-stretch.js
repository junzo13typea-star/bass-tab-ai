/**
 * BassTab AI - Pitch-Preserving Time Stretch (Phase Vocoder)
 *
 * 再生速度を変えてもピッチを保つための簡易フェーズボコーダ。
 * DSP 本体は Float32Array 上の純粋関数として実装し、Node でも検証可能にする。
 * AudioBuffer への変換は createStretchedBufferAsync が担当する。
 */

/**
 * インプレース radix-2 FFT (re/im 分離配列)
 * inverse=true で逆変換 (1/N スケーリング込み)
 */
function fft(re, im, inverse = false) {
  const n = re.length;
  // ビット反転並べ替え
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  let len = 2;
  while (len <= n) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + half] * cwr - im[i + k + half] * cwi;
        const vi = re[i + k + half] * cwi + im[i + k + half] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
    len <<= 1;
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/**
 * 1チャンネル分の波形をピッチ不変で時間伸縮する
 * @param {Float32Array} input 入力波形
 * @param {number} rate 再生速度 (0.5 = 半分の速さ = 2倍の長さ / 1.5 = 1.5倍速 = 2/3の長さ)
 * @param {Object} [options] { windowSize = 2048, analysisHop = 512 }
 * @returns {Float32Array} 伸縮後の波形 (長さ ≒ input.length / rate)
 */
export function phaseVocoderStretch(input, rate, options = {}) {
  const N = options.windowSize || 2048;
  const Ha = options.analysisHop || 512;
  if (!(rate > 0)) throw new Error('rate must be positive');
  if (rate === 1 || input.length === 0) return new Float32Array(input);

  const Hs = Math.max(1, Math.round(Ha / rate));
  const Se = Hs / Ha; // 実際に適用される伸長率 (出力長 = 入力長 × Se)
  const outLength = Math.round(input.length * Se);

  // Hann 窓
  const win = new Float32Array(N);
  for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);

  const numBins = N / 2 + 1;
  const numFrames = Math.max(1, 1 + Math.ceil((input.length - N) / Ha));

  // 解析フレーム (mag/phase) をオンデマンド生成してキャッシュ (メモリ節約のため直前分のみ保持)
  const frameCache = new Map();
  const analyzeFrame = (k) => {
    if (frameCache.has(k)) return frameCache.get(k);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const start = k * Ha;
    for (let n = 0; n < N; n++) {
      const idx = start + n;
      re[n] = (idx < input.length ? input[idx] : 0) * win[n];
    }
    fft(re, im, false);
    const mag = new Float32Array(numBins);
    const phase = new Float32Array(numBins);
    for (let b = 0; b < numBins; b++) {
      mag[b] = Math.hypot(re[b], im[b]);
      phase[b] = Math.atan2(im[b], re[b]);
    }
    const frame = { mag, phase };
    frameCache.set(k, frame);
    // 過去フレームを破棄 (k は単調増加)
    for (const key of frameCache.keys()) {
      if (key < k - 1) frameCache.delete(key);
    }
    return frame;
  };

  const omega = new Float32Array(numBins);
  for (let b = 0; b < numBins; b++) omega[b] = (2 * Math.PI * Ha * b) / N;

  const out = new Float32Array(outLength + N);
  const env = new Float32Array(outLength + N);
  const yPhase = new Float32Array(numBins);
  const re = new Float32Array(N);
  const im = new Float32Array(N);

  const numOutFrames = Math.ceil(numFrames / Se);
  for (let u = 0; u < numOutFrames; u++) {
    const p = u / Se;
    const f = Math.min(Math.floor(p), numFrames - 1);
    const frac = Math.min(1, Math.max(0, p - Math.floor(p)));
    const fa = analyzeFrame(f);
    const fb = analyzeFrame(Math.min(f + 1, numFrames - 1));

    if (u === 0) {
      yPhase.set(fa.phase);
    } else {
      for (let b = 0; b < numBins; b++) {
        let delta = fb.phase[b] - fa.phase[b] - omega[b];
        delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
        yPhase[b] += ((omega[b] + delta) / Ha) * Hs;
      }
    }

    // スペクトル再構築 (共役対称)
    re.fill(0);
    im.fill(0);
    for (let b = 0; b < numBins; b++) {
      const m = fa.mag[b] * (1 - frac) + fb.mag[b] * frac;
      re[b] = m * Math.cos(yPhase[b]);
      im[b] = m * Math.sin(yPhase[b]);
      if (b > 0 && b < N / 2) {
        re[N - b] = re[b];
        im[N - b] = -im[b];
      }
    }
    fft(re, im, true);

    // 窓つきオーバーラップ加算
    const start = u * Hs;
    for (let n = 0; n < N; n++) {
      out[start + n] += re[n] * win[n];
      env[start + n] += win[n] * win[n];
    }
  }

  // 窓包絡で正規化
  for (let i = 0; i < outLength; i++) {
    if (env[i] > 1e-3) out[i] /= env[i];
  }
  return out.slice(0, outLength);
}

/**
 * AudioBuffer 全体をピッチ保持ストレッチした新しい AudioBuffer を生成する
 * チャンネル間に譲歩点を入れ、長い曲でもUIを固めない
 * @param {AudioBuffer} audioBuffer
 * @param {number} rate 再生速度
 * @returns {Promise<AudioBuffer>}
 */
export async function createStretchedBufferAsync(audioBuffer, rate) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const outLength = Math.round(audioBuffer.length / rate);

  const offline = new OfflineAudioContext(numChannels, Math.max(1, outLength), sampleRate);
  const outBuffer = offline.createBuffer(numChannels, Math.max(1, outLength), sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const stretched = phaseVocoderStretch(audioBuffer.getChannelData(ch), rate);
    outBuffer.copyToChannel(stretched.subarray(0, outLength), ch);
    if (ch + 1 < numChannels) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return outBuffer;
}
