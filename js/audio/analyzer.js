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
   * @param {Object} [options]
   * @param {'low'|'normal'|'high'} [options.sensitivity] 検出感度 (デフォルト 'normal' = 従来挙動)
   * @param {'4'|'5'} [options.tuning] チューニング (デフォルト '4'。'5' で Low B = MIDI 23 まで拡張)
   * @returns {Array<{ time: number, duration: number, midi: number, freq: number, velocity: number }>}
   */
  async analyzeBassline(bassBuffer, onProgress = null, options = {}) {
    const data = bassBuffer.getChannelData(0);
    const sampleRate = bassBuffer.sampleRate;

    // 感度プリセット (normal は従来の固定値と完全一致)
    const sensConfig = {
      low:    { noiseMul: 0.12, floor: 0.016, clarity: 0.70 },
      normal: { noiseMul: 0.06, floor: 0.008, clarity: 0.60 },
      high:   { noiseMul: 0.03, floor: 0.004, clarity: 0.50 }
    }[options.sensitivity] || { noiseMul: 0.06, floor: 0.008, clarity: 0.60 };

    // チューニング (5弦時は Low B まで解析下限を広げる)
    const is5String = options.tuning === '5';
    const minMidi = is5String ? 23 : 28;
    const minFreq = is5String ? 29 : 38;
    const yinMinFreq = is5String ? 30 : 40;

    // 分析パラメータ
    const hopSize = Math.floor(sampleRate * 0.02); // 20ms ステップ
    const windowSize = Math.floor(sampleRate * 0.08); // 80ms 分析窓 (低音40Hzの周期約25msを3周期カバー)
    const totalHops = Math.floor((data.length - windowSize) / hopSize);

    // 1. 各フレームの RMS エネルギーと YIN ピッチを算出
    const frameAnalysis = [];
    const yinBuffer = new Float32Array(windowSize / 2);
    // テンポ推定用にオンセット曲線 (RMS の正の変化量) も記録する。
    // 検出ノート列は他楽器の漏れや細切れ誤検出で汚染されやすいが、
    // 信号レベルの周期性は実テンポをよく保つため、estimateTempo が優先的に使う。
    const onsetFlux = [];
    let prevRms = 0;

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
        const pitchRes = this.detectYinPitch(frame, sampleRate, yinBuffer, yinMinFreq);
        freq = pitchRes.freq;
        clarity = pitchRes.clarity;
      }

      frameAnalysis.push({
        time: offset / sampleRate,
        rms,
        freq,
        clarity
      });
      onsetFlux.push(Math.max(0, rms - prevRms));
      prevRms = rms;

      if (onProgress && i % 100 === 0) {
        onProgress(0.1 + (i / totalHops) * 0.6);
      }

      // メインスレッドを定期的に解放し、進捗表示の再描画とUI応答を可能にする
      if (i % 50 === 49) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    this._onsetCurve = { hopSec: hopSize / sampleRate, flux: Float32Array.from(onsetFlux) };

    // 2. オンセット（発音点）の検出とノートグルーピング
    const notes = [];
    let currentNote = null;
    const minNoteDuration = 0.08; // 最短80ms

    // 動的ノイズフロア
    let maxRms = 0;
    for (const f of frameAnalysis) if (f.rms > maxRms) maxRms = f.rms;
    const noiseThreshold = Math.max(sensConfig.floor, maxRms * sensConfig.noiseMul);

    for (let i = 0; i < frameAnalysis.length; i++) {
      const f = frameAnalysis[i];
      const prev = i > 0 ? frameAnalysis[i - 1] : { rms: 0, freq: 0 };

      // 急峻なエネルギー上昇 (アタックトランジェント) または 音程の明瞭な変化
      const isAttack = (f.rms > noiseThreshold) && (f.rms > prev.rms * 1.55);
      const isPitchChange = currentNote && f.freq > 0 && Math.abs(this.freqToMidi(f.freq) - currentNote.midi) >= 0.8;

      if (f.rms > noiseThreshold && f.freq >= minFreq && f.freq <= 400 && f.clarity > sensConfig.clarity) {
        const midi = Math.round(this.freqToMidi(f.freq));

        // ベースの音域 (下限はチューニング依存: 4弦 E1=28 / 5弦 B0=23 〜 G4=67) に制約
        if (midi >= minMidi && midi <= 67) {
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

      // ノート化ループでも定期的に譲歩する
      if (i % 100 === 99) {
        await new Promise(r => setTimeout(r, 0));
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
  detectYinPitch(frame, sampleRate, yinBuffer, minFreq = 40) {
    const halfSize = yinBuffer.length;
    // 最小・最大ラグ (ベース音域 minFreq〜400Hz)
    const minLag = Math.floor(sampleRate / 400); // ~110 @ 44.1kHz
    const maxLag = Math.floor(sampleRate / minFreq);  // ~1100 @ 44.1kHz (40Hz時)
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

  /**
   * ノート列のオンセット間隔からテンポ (BPM) と拍の位相 (オフセット) を推定する
   * @returns {{ bpm: number, offset: number }} offset は最初の拍が来る時刻 (秒)
   */
  estimateTempo(notes) {
    if (!notes || notes.length < 4) return { bpm: 120, offset: 0 };

    // オンセット間隔 (IOI) を 0.30〜1.05 秒 (約57〜200BPMの1拍) に折りたたんで投票
    // 1つ先だけでなく2〜3つ先の音との間隔も見ることで、8分音符主体の曲を2倍のテンポと誤認しない
    const votes = new Map();
    const lagWeights = [1, 0.7, 0.45];
    for (let lag = 1; lag <= 3; lag++) {
      for (let i = lag; i < notes.length; i++) {
        const ioi = notes[i].time - notes[i - lag].time;
        if (ioi < 0.09 || ioi > 2.4) continue;
        let folded = ioi;
        while (folded < 0.30) folded *= 2;
        while (folded > 1.05) folded /= 2;
        const key = Math.round(folded * 200); // 5ms刻み
        const w = lagWeights[lag - 1] * (ioi >= 0.18 ? 1 : 0.5);
        votes.set(key, (votes.get(key) || 0) + w);
      }
    }
    if (votes.size === 0) return { bpm: 120, offset: 0 };

    const scoreNear = (targetLen) => {
      let s = 0;
      for (const [key, score] of votes) {
        if (Math.abs(key / 200 - targetLen) <= 0.03) s += score;
      }
      return s;
    };

    let bestKey = 0;
    let bestScore = -1;
    for (const [key, score] of votes) {
      if (score > bestScore) { bestScore = score; bestKey = key; }
    }
    let beatLen = bestKey / 200;

    // 倍テンポ誤認の補正: 170BPM超の候補で、半分のテンポにも十分な支持があれば半分を採用
    if (60 / beatLen > 170 && beatLen * 2 <= 1.05) {
      if (scoreNear(beatLen * 2) >= scoreNear(beatLen) * 0.55) {
        beatLen = beatLen * 2;
      }
    }

    // 近傍ビンの重み付き平均で推定を滑らかにする
    let wsum = 0;
    let vsum = 0;
    for (const [key, score] of votes) {
      const len = key / 200;
      if (Math.abs(len - beatLen) <= 0.03) { wsum += score; vsum += score * len; }
    }
    if (wsum > 0) beatLen = vsum / wsum;

    // ---- 信号レベルのテンポ推定 (オンセット曲線がある場合はこちらを優先) ----
    // フルミックス等の実音源では検出ノート列が他楽器の漏れ・細切れ誤検出で汚染され、
    // ノート間隔の投票やグリッド当てはめが実テンポを外すことがある (密度の飽和)。
    // 解析時に記録したオンセット曲線 (RMS フラックス) の周期性を直接測る方が堅牢なため、
    // コム (櫛) スコアで周期を走査し、ノート投票の勝者ともスコアで競わせて採用する。
    if (this._onsetCurve && this._onsetCurve.flux.length >= 200) {
      const { hopSec, flux } = this._onsetCurve;
      const sortedFlux = [...flux].sort((a, b) => b - a);
      const fluxThr = sortedFlux[Math.floor(sortedFlux.length * 0.35)];
      const events = [];
      for (let i = 0; i < flux.length; i++) {
        if (flux[i] > fluxThr) events.push({ t: i * hopSec, w: flux[i] });
      }
      if (events.length >= 40) {
        // 周期 P の8分グリッドへの重み付き整合スコアと位相 (円周統計)。
        // 拍グリッドで測ると均一な8分主体の曲で8分周期そのものが勝ってしまうため、
        // 候補周期の「8分グリッド」で整合を測り、オクターブの決着は投票側の prior に委ねる。
        const combFit = (P) => {
          const step8 = P / 2;
          let cs = 0, sn = 0, wsum2 = 0;
          for (const e of events) {
            const th = 2 * Math.PI * (e.t / step8);
            cs += e.w * Math.cos(th);
            sn += e.w * Math.sin(th);
            wsum2 += e.w;
          }
          let phase = Math.atan2(sn, cs) / (2 * Math.PI) * step8;
          if (phase < 0) phase += step8;
          const sigma = 0.018;
          let s = 0;
          for (const e of events) {
            const d = Math.abs(e.t - (phase + Math.round((e.t - phase) / step8) * step8));
            s += e.w * Math.exp(-(d * d) / (2 * sigma * sigma));
          }
          return { phase, score: s / wsum2 };
        };
        // 候補: コム走査の上位ピーク + ノート投票の勝者
        const scanScores = [];
        for (let P = 0.28; P <= 1.10; P += 0.002) scanScores.push({ P, ...combFit(P) });
        const peakIdx = [];
        for (let i = 1; i < scanScores.length - 1; i++) {
          if (scanScores[i].score >= scanScores[i - 1].score && scanScores[i].score >= scanScores[i + 1].score) {
            peakIdx.push(i);
          }
        }
        peakIdx.sort((a, b) => scanScores[b].score - scanScores[a].score);
        const combCandidates = [];
        for (const i of peakIdx) {
          if (combCandidates.every(c => Math.abs(c.P - scanScores[i].P) > 0.03)) {
            combCandidates.push({ P: scanScores[i].P, score: scanScores[i].score, phase: scanScores[i].phase });
          }
          if (combCandidates.length >= 4) break;
        }
        const noteWinnerLen = beatLen;
        combCandidates.push({ P: beatLen, ...combFit(beatLen), isNoteWinner: true });
        // 各候補を局所走査で精密化
        for (const c of combCandidates) {
          let bestP = c.P, bestFit = { score: c.score, phase: c.phase };
          for (let P = c.P * 0.97; P <= c.P * 1.03; P += 0.0005) {
            const f = combFit(P);
            if (f.score > bestFit.score) { bestFit = f; bestP = P; }
          }
          c.P = bestP; c.score = bestFit.score; c.phase = bestFit.phase;
        }
        combCandidates.sort((a, b) => b.score - a.score);
        const bestScore = combCandidates[0].score;
        // 採用規則: スコアが最良の92%以内にある候補を「合格」とし、
        // ノート投票の勝者 (倍テンポ補正などの音楽的 prior を含む) が合格内ならそれを優先。
        // 合格内に投票勝者が無い場合 (実音源で投票が外れた場合) はコムスコア最良を採用し、
        // スコアが互角 (98%以上) なら遅い周期 (長周期側) を優先する。
        const eligible = combCandidates.filter(c => c.score >= bestScore * 0.92);
        let chosen = eligible.find(c => c.isNoteWinner);
        if (!chosen) {
          chosen = eligible[0];
          for (const c of eligible) {
            if (c.score >= chosen.score * 0.98 && c.P > chosen.P) chosen = c;
          }
        }
        beatLen = chosen.P;
        let offset = chosen.phase;
        // 半拍ずれの仲裁: 拍位置に乗るノートのベロシティ合計が大きい方を拍頭にする
        const step8 = beatLen / 2;
        const beatVel = (phase) => {
          let s = 0;
          for (const n of notes) {
            const d = Math.abs(n.time - (phase + Math.round((n.time - phase) / beatLen) * beatLen));
            if (d < beatLen * 0.12) s += (n.velocity || 0.7);
          }
          return s;
        };
        if (beatVel(offset + step8) > beatVel(offset) * 1.15) offset += step8;
        const bpm = Math.round((60 / beatLen) * 10) / 10;
        return { bpm, offset };
      }
    }

    // ---- 候補テンポの精密化と選択 ----
    // 実音源 (特にフルミックス) では検出ノートに他楽器の漏れや細切れの誤検出が混ざり、
    // IOI投票の最大ピークが正しい周期にならないことがある (例: 188BPMの曲で150BPMを掴む)。
    // そこで投票の上位ピークを複数候補として保持し、それぞれを実グリッドへ精密化したうえで
    // 「16分グリッドの40ms以内に収まる音の割合」が最大の候補を採用する。
    // 適合率が互角の候補 (オクターブ関係など) は投票支持の高い方を優先する。

    // 候補グリッドに対する位相 (円周統計) と整合スコア
    const gridFit = (candBeatLen) => {
      const step8 = candBeatLen / 2;
      let cosSum = 0, sinSum = 0;
      for (const n of notes) {
        const th = 2 * Math.PI * (n.time / step8);
        cosSum += Math.cos(th);
        sinSum += Math.sin(th);
      }
      let phase = Math.atan2(sinSum, cosSum) / (2 * Math.PI) * step8;
      if (phase < 0) phase += step8;
      const sigma = step8 * 0.25;
      let score = 0;
      for (const n of notes) {
        const d = Math.abs(n.time - (phase + Math.round((n.time - phase) / step8) * step8));
        score += Math.exp(-(d * d) / (2 * sigma * sigma));
      }
      return { phase, score };
    };

    // 候補を精密化する: 周期±3.5%の走査 + 最小二乗フィット → { beatLen, offset8, frac40 }
    const refineCandidate = (candBeatLen) => {
      let bl = candBeatLen;
      let fit = gridFit(bl);
      const SCAN = 120;
      for (let i = 0; i <= SCAN; i++) {
        const cand = candBeatLen * (0.965 + (0.07 * i) / SCAN);
        const f = gridFit(cand);
        if (f.score > fit.score) { fit = f; bl = cand; }
      }
      let off8 = fit.phase;
      let step8 = bl / 2;
      for (let iter = 0; iter < 4; iter++) {
        const pts = [];
        for (const n of notes) {
          const k = Math.round((n.time - off8) / step8);
          const resid = n.time - (off8 + k * step8);
          if (Math.abs(resid) <= step8 * 0.32) pts.push([k, n.time]);
        }
        if (pts.length < 8) break;
        let sk = 0, st = 0, skk = 0, skt = 0;
        for (const [k, t] of pts) { sk += k; st += t; skk += k * k; skt += k * t; }
        const denom = pts.length * skk - sk * sk;
        if (Math.abs(denom) < 1e-9) break;
        const b = (pts.length * skt - sk * st) / denom;
        const a = (st - b * sk) / pts.length;
        if (b < 0.12 || b > 0.62) break;
        const newBl = b * 2;
        const change = Math.abs(newBl - bl);
        bl = newBl;
        step8 = b;
        off8 = ((a % step8) + step8) % step8;
        if (change < 0.00005) break;
      }
      const step16 = bl / 4;
      let within = 0;
      for (const n of notes) {
        const d = Math.abs(n.time - (off8 + Math.round((n.time - off8) / step16) * step16));
        if (d <= 0.040) within++;
      }
      return { beatLen: bl, offset8: off8, frac40: within / notes.length };
    };

    // 平滑化した投票 (候補の支持度とピーク抽出用)
    const smoothVotes = new Map();
    for (const [key, score] of votes) {
      let s = 0;
      for (let d = -3; d <= 3; d++) s += (votes.get(key + d) || 0) * (1 - Math.abs(d) / 4);
      smoothVotes.set(key, s);
    }
    const voteScoreNear = (targetLen) => {
      let s = 0;
      for (const [key, sc] of smoothVotes) {
        if (Math.abs(key / 200 - targetLen) <= 0.02) s = Math.max(s, sc);
      }
      return s;
    };

    const candidateMap = new Map();
    const addCandidate = (bl) => {
      if (bl < 0.28 || bl > 1.10) return;
      const id = Math.round(bl * 1000);
      for (const k of candidateMap.keys()) if (Math.abs(k - id) < 15) return;
      candidateMap.set(id, { beatLen: bl, voteScore: voteScoreNear(bl) });
    };
    addCandidate(beatLen); // 従来ロジックの勝者 (倍テンポ補正・平滑化済み)
    {
      const sortedPeaks = [...smoothVotes.entries()].sort((a, b) => b[1] - a[1]);
      const picked = [];
      for (const [key] of sortedPeaks) {
        if (picked.every(p => Math.abs(p - key) > 8)) picked.push(key);
        if (picked.length >= 4) break;
      }
      for (const key of picked) {
        let ws = 0, vs = 0;
        for (const [k2, sc] of votes) {
          if (Math.abs(k2 - key) <= 3) { ws += sc; vs += sc * (k2 / 200); }
        }
        if (ws > 0) addCandidate(vs / ws);
      }
    }

    let results = [...candidateMap.values()].map(c => ({ ...c, ...refineCandidate(c.beatLen) }));
    const maxFrac = Math.max(...results.map(r => r.frac40));
    results = results.filter(r => r.frac40 >= maxFrac - 0.03);
    // オクターブ対策: 適合率が互角の候補同士が約2:1の関係にある場合、
    // 遅い側に一定の投票支持 (>=35%) があれば速い側 (倍テンポ誤認) を落とす
    results = results.filter(r => !results.some(o =>
      o !== r &&
      Math.abs(o.beatLen - r.beatLen * 2) <= r.beatLen * 0.10 &&
      o.voteScore >= r.voteScore * 0.35
    ));
    results.sort((a, b) => b.voteScore - a.voteScore);
    beatLen = results[0].beatLen;
    let offset = results[0].offset8;
    const step8 = beatLen / 2;

    // 拍位相の決定: 8分位相と、それを半拍ずらした候補のうち、
    // 拍位置に乗る音のベロシティ合計が大きい方を拍の頭とする (8分主体の曲の半拍ずれ対策)
    const beatScore = (phase) => {
      let s = 0;
      for (const n of notes) {
        const d = Math.abs(n.time - (phase + Math.round((n.time - phase) / beatLen) * beatLen));
        if (d < beatLen * 0.12) s += (n.velocity || 0.7);
      }
      return s;
    };
    const phaseA = offset;
    const phaseB = offset + step8;
    offset = beatScore(phaseB) > beatScore(phaseA) * 1.15 ? phaseB : phaseA;

    const bpm = Math.round((60 / beatLen) * 10) / 10;
    return { bpm, offset };
  }

  /**
   * 検出ノートを16分音符グリッドへ量子化する (最も近いグリッド位置へ吸着)
   */
  quantizeNotes(notes, bpm, offset = 0) {
    if (!notes || notes.length === 0 || !bpm) return notes;
    const step = (60 / bpm) / 4; // 16分音符の長さ
    const snapped = notes.map(n => {
      const k = Math.round((n.time - offset) / step);
      return { ...n, time: offset + k * step };
    });
    // 次の音と重ならないよう長さを整える
    for (let i = 0; i < snapped.length; i++) {
      const cur = snapped[i];
      const next = snapped[i + 1];
      let end = cur.time + cur.duration;
      if (next && end > next.time) end = next.time;
      cur.duration = Math.max(0.06, end - cur.time);
    }
    return snapped;
  }
}

