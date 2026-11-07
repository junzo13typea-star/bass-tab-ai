/**
 * BassTab AI - Audio Analyzer & Bass Pitch Detector
 * 
 * 音声ファイルからベース音域（30Hz〜350Hz）をバンドパス抽出し、
 * YIN法（自己相関）によるピッチ推定とオンセット検出でベースラインのMIDIノート列を生成する。
 */

export class AudioAnalyzer {
  constructor() {
    this.audioCtx = null;
  }

  getAudioContext() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContext();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  /**
   * 音声ファイル (File / Blob / ArrayBuffer) を AudioBuffer にデコード
   */
  async decodeAudio(fileOrBuffer) {
    const ctx = this.getAudioContext();
    let arrayBuffer;
    if (fileOrBuffer instanceof ArrayBuffer) {
      arrayBuffer = fileOrBuffer;
    } else if (fileOrBuffer instanceof Blob || fileOrBuffer instanceof File) {
      arrayBuffer = await fileOrBuffer.arrayBuffer();
    } else {
      throw new Error('Unsupported audio input format');
    }

    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  /**
   * オフラインコンテキストでベース帯域のみを急峻にバンドパス抽出 (30Hz〜320Hz)
   */
  async filterBassBand(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const offlineCtx = new OfflineAudioContext(1, audioBuffer.length, sampleRate);

    const source = offlineCtx.createBufferSource();
    // モノラルミックスダウン
    const monoBuffer = offlineCtx.createBuffer(1, audioBuffer.length, sampleRate);
    const monoData = monoBuffer.getChannelData(0);
    const numChannels = audioBuffer.numberOfChannels;

    for (let c = 0; c < numChannels; c++) {
      const channelData = audioBuffer.getChannelData(c);
      for (let i = 0; i < audioBuffer.length; i++) {
        monoData[i] += channelData[i] / numChannels;
      }
    }
    source.buffer = monoBuffer;

    // ハイパスフィルター (超低域のゴロゴロノイズをカット 35Hz)
    const hp = offlineCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 35;
    hp.Q.value = 0.707;

    // ローパスフィルター 1 (ボーカル・ドラム高域カット 320Hz)
    const lp1 = offlineCtx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.value = 320;
    lp1.Q.value = 1.0;

    // ローパスフィルター 2 (急峻なスロープ -24dB/oct)
    const lp2 = offlineCtx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 320;
    lp2.Q.value = 1.0;

    source.connect(hp);
    hp.connect(lp1);
    lp1.connect(lp2);
    lp2.connect(offlineCtx.destination);

    source.start(0);
    return await offlineCtx.startRendering();
  }

  /**
   * フィルタリング済みバッファからベースラインのノートイベント列を抽出
   * @param {AudioBuffer} bassBuffer 
   * @param {Function} onProgress 進捗コールバック (0.0〜1.0)
   * @returns {Array<{ time: number, duration: number, midi: number, freq: number, velocity: number }>}
   */
  async analyzeBassline(bassBuffer, onProgress = null) {
    const data = bassBuffer.getChannelData(0);
    const sampleRate = bassBuffer.sampleRate;

    // 分析パラメータ
    const hopSize = Math.floor(sampleRate * 0.02); // 20ms ステップ
    const windowSize = Math.floor(sampleRate * 0.08); // 80ms 分析窓 (低音40Hzの周期約25msを3周期カバー)
    const totalHops = Math.floor((data.length - windowSize) / hopSize);

    // 1. 各フレームの RMS エネルギーと YIN ピッチを算出
    const frameAnalysis = [];
    const yinBuffer = new Float32Array(windowSize / 2);

    for (let i = 0; i < totalHops; i++) {
      const offset = i * hopSize;
      const frame = data.subarray(offset, offset + windowSize);

      // RMS 計算
      let sumSq = 0;
      for (let j = 0; j < windowSize; j++) {
        sumSq += frame[j] * frame[j];
      }
      const rms = Math.sqrt(sumSq / windowSize);

      // ピッチ検出 (YIN アルゴリズム)
      let freq = 0;
      let clarity = 0;
      if (rms > 0.005) {
        const pitchRes = this.detectYinPitch(frame, sampleRate, yinBuffer);
        freq = pitchRes.freq;
        clarity = pitchRes.clarity;
      }

      frameAnalysis.push({
        time: offset / sampleRate,
        rms,
        freq,
        clarity
      });

      if (onProgress && i % 100 === 0) {
        onProgress(0.1 + (i / totalHops) * 0.6);
      }
    }

    // 2. オンセット（発音点）の検出とノートグルーピング
    const notes = [];
    let currentNote = null;
    const minNoteDuration = 0.08; // 最短80ms

    // 動的ノイズフロア
    let maxRms = 0;
    for (const f of frameAnalysis) if (f.rms > maxRms) maxRms = f.rms;
    const noiseThreshold = Math.max(0.008, maxRms * 0.06);

    for (let i = 0; i < frameAnalysis.length; i++) {
      const f = frameAnalysis[i];
      const prev = i > 0 ? frameAnalysis[i - 1] : { rms: 0, freq: 0 };

      // 急峻なエネルギー上昇 (アタックトランジェント) または 音程の明瞭な変化
      const isAttack = (f.rms > noiseThreshold) && (f.rms > prev.rms * 1.55);
      const isPitchChange = currentNote && f.freq > 0 && Math.abs(this.freqToMidi(f.freq) - currentNote.midi) >= 0.8;

      if (f.rms > noiseThreshold && f.freq >= 38 && f.freq <= 400 && f.clarity > 0.6) {
        const midi = Math.round(this.freqToMidi(f.freq));

        // 4弦ベースの音域 (E1=28 〜 G4=67) に制約
        if (midi >= 28 && midi <= 67) {
          if (!currentNote || isAttack || isPitchChange) {
            // 前のノートを確定
            if (currentNote) {
              currentNote.duration = Math.max(minNoteDuration, f.time - currentNote.time);
              notes.push(currentNote);
            }
            // 新しいノート開始
            currentNote = {
              time: f.time,
              duration: 0.1,
              midi: midi,
              freq: f.freq,
              velocity: Math.min(1.0, Math.max(0.3, f.rms / (maxRms * 0.8)))
            };
          } else {
            // ノート継続中
            currentNote.duration = f.time - currentNote.time;
          }
        }
      } else {
        // 無音またはノイズ
        if (currentNote) {
          currentNote.duration = Math.max(minNoteDuration, f.time - currentNote.time);
          notes.push(currentNote);
          currentNote = null;
        }
      }

      if (onProgress && i % 200 === 0) {
        onProgress(0.7 + (i / frameAnalysis.length) * 0.3);
      }
    }

    if (currentNote) {
      notes.push(currentNote);
    }

    // 3. 後処理: 短すぎるノイズの除去とタイミングの微調整
    const cleanedNotes = this.cleanAndQuantizeNotes(notes);
    if (onProgress) onProgress(1.0);

    return cleanedNotes;
  }

  /**
   * YIN ピッチ検出アルゴリズム (低音域特化)
   */
  detectYinPitch(frame, sampleRate, yinBuffer) {
    const halfSize = yinBuffer.length;
    // 最小・最大ラグ (ベース音域 40Hz〜400Hz)
    const minLag = Math.floor(sampleRate / 400); // ~110 @ 44.1kHz
    const maxLag = Math.floor(sampleRate / 40);  // ~1100 @ 44.1kHz
    const boundLag = Math.min(halfSize - 1, maxLag);

    // 1. 差分平方和
    yinBuffer[0] = 1;
    let runningSum = 0;

    for (let tau = 1; tau <= boundLag; tau++) {
      let delta = 0;
      for (let i = 0; i < halfSize; i++) {
        const diff = frame[i] - frame[i + tau];
        delta += diff * diff;
      }
      runningSum += delta;
      yinBuffer[tau] = runningSum > 0 ? (delta * tau) / runningSum : 1;
    }

    // 2. 閾値通過の最小値探索 (累積平均正規化差分)
    const threshold = 0.22;
    let tauEstimate = -1;

    for (let tau = minLag; tau <= boundLag; tau++) {
      if (yinBuffer[tau] < threshold) {
        while (tau + 1 <= boundLag && yinBuffer[tau + 1] < yinBuffer[tau]) {
          tau++;
        }
        tauEstimate = tau;
        break;
      }
    }

    if (tauEstimate === -1) {
      // 閾値未満がなければ全体での最小値
      let minVal = 1.0;
      for (let tau = minLag; tau <= boundLag; tau++) {
        if (yinBuffer[tau] < minVal) {
          minVal = yinBuffer[tau];
          tauEstimate = tau;
        }
      }
      if (minVal > 0.45) return { freq: 0, clarity: 0 };
    }

    // 放物線補間によるサブサンプル精度
    let betterTau = tauEstimate;
    if (tauEstimate > 1 && tauEstimate < boundLag) {
      const s0 = yinBuffer[tauEstimate - 1];
      const s1 = yinBuffer[tauEstimate];
      const s2 = yinBuffer[tauEstimate + 1];
      const denom = (2 * s1 - s0 - s2);
      if (Math.abs(denom) > 1e-6) {
        betterTau = tauEstimate + (s2 - s0) / (2 * denom);
      }
    }

    const freq = sampleRate / betterTau;
    const clarity = Math.max(0, 1.0 - yinBuffer[tauEstimate]);

    return { freq, clarity };
  }

  freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440.0);
  }

  midiToFreq(midi) {
    return 440.0 * Math.pow(2, (midi - 69) / 12);
  }

  cleanAndQuantizeNotes(rawNotes) {
    if (!rawNotes || rawNotes.length === 0) return [];
    
    // 短すぎるゴミ（30ms以下）の除去
    const filtered = rawNotes.filter(n => n.duration >= 0.06);

    // 近接した同一音の結合 (レガート・サステインの補正)
    const merged = [];
    for (let i = 0; i < filtered.length; i++) {
      const cur = filtered[i];
      if (merged.length > 0) {
        const last = merged[merged.length - 1];
        const gap = cur.time - (last.time + last.duration);
        if (last.midi === cur.midi && gap < 0.05) {
          last.duration = (cur.time + cur.duration) - last.time;
          continue;
        }
      }
      merged.push({ ...cur });
    }

    return merged;
  }
}
