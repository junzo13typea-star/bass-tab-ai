/**
 * BassTab AI - Audio & TAB Synchronized Player
 *
 * 楽曲オーディオ再生とベースシンセ発音、TAB譜スクロール、指板発光を
 * サブミリ秒精度で同期制御するスタジオ・プレイヤーエンジン。
 *
 * 再生速度変更時はピッチ保持タイムストレッチ (time-stretch.js) を使い、
 * 生成が済むまでは従来の playbackRate (デチューン) でフォールバックする。
 * タイムライン (currentTime / スケジューラ) は常に原曲時間軸で統一される。
 */

import { createStretchedBufferAsync } from './time-stretch.js';

export class SyncPlayer {
  constructor(audioContext, bassSynth) {
    this.ctx = audioContext;
    this.synth = bassSynth;

    this.audioBuffer = null;
    this.sourceNode = null;
    this.audioGainNode = null;

    this.tabNotes = [];
    this.isPlaying = false;
    this.playbackRate = 1.0;
    this.currentTime = 0;
    this.startTime = 0;
    this.pauseOffset = 0;
    this.duration = 0;

    // 音量バランス (マイナスワン制御)
    this.audioVolume = 0.8;
    this.bassVolume = 1.0;
    this.isMuteAudio = false;
    this.isMuteBass = false;

    // ループ練習 (A-B Loop)
    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    // メトロノーム / カウントイン
    this.metronomeEnabled = false;
    this.countInEnabled = false;
    this.metroBpm = 120;
    this.metroOffset = 0;
    this.beatsPerBar = 4;
    this.metronomeGainNode = null;
    this.nextClickTime = null;   // 次クリックの曲時間 (秒)。null なら再計算
    this.nextClickBeat = 0;      // 次クリックの拍番号 (グリッド原点からの通し番号)
    this.countInEndCtxTime = 0;  // カウントイン終了の ctx 時刻 (0 = なし)
    this.pendingClicks = [];     // 予約済みクリック音 {osc, at}

    // 先読みスケジューラー
    this.scheduleTimer = null;
    this.scheduledNoteIndex = 0;
    this.lookaheadMs = 25.0;
    this.scheduleAheadTime = 0.12; // 120ms 先まで予約

    // ピッチ保持タイムストレッチ用キャッシュ (rate -> AudioBuffer)
    this.stretchCache = new Map();
    this.stretchPending = new Set();
    this.stretchSourceBuffer = null;
    this.activeBuffer = null;      // 現在の再生に使っているバッファ
    this.activeBufferScale = 1;     // activeBuffer の時間スケール (原曲=1, ストレッチ済み≒1/rate)

    // コールバック
    this.onTimeUpdate = null; // (currentTime, progress) => {}
    this.onNoteHit = null;    // (note) => {}
    this.onPlayStateChange = null; // (isPlaying) => {}
    this.onStretchState = null;    // (state: 'generating'|'ready'|'failed'|'idle', rate) => {}

    this.initAudioNodes();
  }

  notifyStretchState(state, rate) {
    if (!this.onStretchState) return;
    try { this.onStretchState(state, rate); } catch (e) { /* UI側の失敗で再生を止めない */ }
  }

  initAudioNodes() {
    this.audioGainNode = this.ctx.createGain();
    this.audioGainNode.gain.value = this.audioVolume;
    this.audioGainNode.connect(this.ctx.destination);

    this.metronomeGainNode = this.ctx.createGain();
    this.metronomeGainNode.gain.value = 0.9;
    this.metronomeGainNode.connect(this.ctx.destination);
  }

  loadTrack(audioBuffer, tabNotes) {
    this.stop();
    this.audioBuffer = audioBuffer;
    // 曲が変わったらストレッチ済みキャッシュを破棄
    if (this.stretchSourceBuffer !== audioBuffer) {
      const hadPending = this.stretchPending.size > 0;
      this.stretchCache.clear();
      this.stretchPending.clear();
      this.stretchSourceBuffer = audioBuffer;
      if (hadPending) this.notifyStretchState('idle', this.playbackRate);
    }
    this.activeBuffer = audioBuffer;
    this.activeBufferScale = 1;
    this.tabNotes = tabNotes || [];
    this.duration = audioBuffer ? audioBuffer.duration : (tabNotes.length > 0 ? tabNotes[tabNotes.length - 1].time + 2 : 0);
    this.loopStart = 0;
    this.loopEnd = this.duration;
    this.currentTime = 0;
    this.pauseOffset = 0;
    this.scheduledNoteIndex = 0;
  }

  play(options = {}) {
    if (this.isPlaying) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.isPlaying = true;

    // カウントイン (再生ボタンの直接操作時のみ): 1小節分のクリックを入れてから開始する。
    // シーク・速度変更・ループの内部リスタートでは options.countIn が付かないので入らない。
    const wantCountIn = !!(options && options.countIn && this.countInEnabled);
    const spb = 60 / this.metroBpm;
    let countInCtxDur = 0;
    if (wantCountIn) {
      countInCtxDur = (this.beatsPerBar * spb) / this.playbackRate;
      this.countInEndCtxTime = this.ctx.currentTime + countInCtxDur;
    } else {
      this.countInEndCtxTime = 0;
    }
    this.startTime = this.ctx.currentTime + countInCtxDur - (this.pauseOffset / this.playbackRate);

    // 1. 元音源オーディオの再生スタート
    if (this.audioBuffer) {
      // ピッチ保持バッファが用意できていればそれを使い、なければデチューン再生で
      // フォールバックしつつ裏で生成を開始する
      const stretched = this.playbackRate !== 1 ? this.stretchCache.get(this.playbackRate) : null;
      if (this.playbackRate !== 1 && !stretched) {
        this.ensureStretchedBuffer(this.playbackRate);
      }
      const useBuffer = stretched || this.audioBuffer;
      this.activeBuffer = useBuffer;
      this.activeBufferScale = stretched ? useBuffer.duration / this.audioBuffer.duration : 1;

      this.sourceNode = this.ctx.createBufferSource();
      this.sourceNode.buffer = useBuffer;
      this.sourceNode.playbackRate.value = stretched ? 1 : this.playbackRate;
      this.sourceNode.connect(this.audioGainNode);

      const offset = Math.max(0, Math.min(this.pauseOffset * this.activeBufferScale, useBuffer.duration));
      if (countInCtxDur > 0) {
        this.sourceNode.start(this.countInEndCtxTime, offset);
      } else {
        this.sourceNode.start(0, offset);
      }

      this.sourceNode.onended = () => {
        if (this.isPlaying && !this.loopEnabled && this.currentTime >= this.duration - 0.2) {
          this.pause();
          this.seek(0);
        }
      };
    }

    // カウントインのクリックを予約する (最後のクリックが開始位置と同時)
    if (wantCountIn) {
      for (let m = this.beatsPerBar; m >= 1; m--) {
        const atCtx = this.countInEndCtxTime - (m * spb) / this.playbackRate;
        this.playClick(atCtx, m === this.beatsPerBar);
      }
    }

    // 2. 先読みベース音スケジューラーの開始
    this.nextClickTime = null;
    this.findNextNoteIndex(this.pauseOffset);
    this.runScheduler();

    // 3. UI同期アニメーションループの開始
    this.runAnimationLoop();

    if (this.onPlayStateChange) this.onPlayStateChange(true);
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;

    // 予約済みクリック (カウントイン含む) を止める
    this.stopPendingClicks();
    this.countInEndCtxTime = 0;

    // 現在時刻の記録
    this.pauseOffset = this.currentTime;

    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch (e) {}
      this.sourceNode = null;
    }

    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }

    if (this.onPlayStateChange) this.onPlayStateChange(false);
  }

  stop() {
    this.pause();
    this.currentTime = 0;
    this.pauseOffset = 0;
    this.scheduledNoteIndex = 0;
    if (this.onTimeUpdate) this.onTimeUpdate(0, 0);
  }

  seek(targetSeconds) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();

    this.currentTime = Math.max(0, Math.min(targetSeconds, this.duration));
    this.pauseOffset = this.currentTime;
    this.findNextNoteIndex(this.currentTime);

    if (this.onTimeUpdate) {
      const progress = this.duration > 0 ? this.currentTime / this.duration : 0;
      this.onTimeUpdate(this.currentTime, progress);
    }

    if (wasPlaying) this.play();
  }

  setPlaybackRate(rate) {
    this.playbackRate = Math.max(0.5, Math.min(1.75, rate));
    if (this.playbackRate !== 1 && this.audioBuffer) {
      this.ensureStretchedBuffer(this.playbackRate);
    }
    if (this.isPlaying) {
      const currentPos = this.currentTime;
      this.pause();
      this.pauseOffset = currentPos;
      this.play();
    }
  }

  /**
   * 指定速度のピッチ保持バッファを非同期生成してキャッシュする
   * 生成完了時に再生中かつ速度が一致していれば、現在位置のまま切替える
   */
  ensureStretchedBuffer(rate) {
    if (!this.audioBuffer || rate === 1) return;
    if (this.stretchCache.has(rate) || this.stretchPending.has(rate)) return;

    const sourceBuffer = this.audioBuffer;
    this.stretchPending.add(rate);
    this.notifyStretchState('generating', rate);

    createStretchedBufferAsync(sourceBuffer, rate)
      .then((stretched) => {
        this.stretchPending.delete(rate);
        // 生成中に別の曲へ切り替わっていたら破棄
        if (this.stretchSourceBuffer !== sourceBuffer || this.audioBuffer !== sourceBuffer) {
          this.notifyStretchState('idle', rate);
          return;
        }
        this.stretchCache.set(rate, stretched);
        this.notifyStretchState('ready', rate);

        if (this.isPlaying && this.playbackRate === rate && this.activeBuffer !== stretched) {
          const currentPos = this.currentTime;
          this.pause();
          this.pauseOffset = currentPos;
          this.play();
        }
      })
      .catch((err) => {
        this.stretchPending.delete(rate);
        // 生成中に別の曲へ切り替わっていた場合は失敗として扱わない
        if (this.stretchSourceBuffer !== sourceBuffer || this.audioBuffer !== sourceBuffer) {
          this.notifyStretchState('idle', rate);
        } else {
          this.notifyStretchState('failed', rate);
        }
        console.warn('ピッチ保持ストレッチの生成に失敗しました (デチューン再生を継続):', err);
      });
  }

  setAudioVolume(vol) {
    this.audioVolume = vol;
    if (this.audioGainNode) {
      this.audioGainNode.gain.setValueAtTime(this.isMuteAudio ? 0 : vol, this.ctx.currentTime);
    }
  }

  setBassVolume(vol) {
    this.bassVolume = vol;
    if (this.synth) {
      this.synth.setVolume(this.isMuteBass ? 0 : vol);
    }
  }

  toggleAudioMute() {
    this.isMuteAudio = !this.isMuteAudio;
    this.setAudioVolume(this.audioVolume);
    return this.isMuteAudio;
  }

  toggleBassMute() {
    this.isMuteBass = !this.isMuteBass;
    this.setBassVolume(this.bassVolume);
    return this.isMuteBass;
  }

  setLoop(enabled, start = 0, end = 0) {
    this.loopEnabled = enabled;
    if (start < end) {
      this.loopStart = start;
      this.loopEnd = end;
    }
  }

  // ===== メトロノーム / カウントイン =====

  /** 拍グリッド (BPM・最初の拍の位置・1小節の拍数) を設定する */
  setMetronomeGrid(bpm, offset, beatsPerBar) {
    if (isFinite(bpm) && bpm > 0) this.metroBpm = bpm;
    if (isFinite(offset)) this.metroOffset = offset;
    if (Number.isInteger(beatsPerBar) && beatsPerBar >= 1 && beatsPerBar <= 12) {
      this.beatsPerBar = beatsPerBar;
    }
    this.nextClickTime = null; // 次回スケジューラで現在位置から再計算
  }

  setMetronomeEnabled(enabled) {
    this.metronomeEnabled = !!enabled;
    if (!this.metronomeEnabled) {
      this.nextClickTime = null;
      this.stopPendingClicks();
    }
  }

  setCountInEnabled(enabled) {
    this.countInEnabled = !!enabled;
  }

  isCountInActive() {
    return this.countInEndCtxTime > 0 && this.ctx.currentTime < this.countInEndCtxTime;
  }

  /** クリック音を ctx 時刻に予約する (小節頭はアクセント) */
  playClick(atCtxTime, accent) {
    if (!this.metronomeGainNode) return;
    try {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = accent ? 1760 : 1175;
      g.gain.setValueAtTime(accent ? 0.55 : 0.35, atCtxTime);
      g.gain.exponentialRampToValueAtTime(0.0001, atCtxTime + 0.05);
      osc.connect(g);
      g.connect(this.metronomeGainNode);
      osc.start(atCtxTime);
      osc.stop(atCtxTime + 0.06);
      this.pendingClicks.push({ osc, at: atCtxTime });
    } catch (e) { /* クリックの失敗で再生を止めない */ }
  }

  stopPendingClicks() {
    const now = this.ctx.currentTime;
    for (const c of this.pendingClicks) {
      if (c.at > now - 0.01) {
        try { c.osc.stop(); } catch (e) {}
      }
    }
    this.pendingClicks = [];
  }

  /** スケジューラ窓内の拍グリッドへクリックを予約する */
  scheduleMetronomeClicks(currentAudioTime, scheduleWindowEnd) {
    if (!this.metronomeEnabled) return;
    const spb = 60 / this.metroBpm;

    if (this.nextClickTime === null || this.nextClickTime < currentAudioTime - spb) {
      const k = Math.ceil((currentAudioTime - this.metroOffset) / spb - 1e-6);
      this.nextClickBeat = k;
      this.nextClickTime = this.metroOffset + k * spb;
    }

    while (this.nextClickTime <= scheduleWindowEnd) {
      const withinSong = this.duration <= 0 || this.nextClickTime <= this.duration + spb;
      if (withinSong && this.nextClickTime >= currentAudioTime - 0.05) {
        const atCtx = this.startTime + (this.nextClickTime / this.playbackRate);
        const beatInBar = ((this.nextClickBeat % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar;
        this.playClick(atCtx, beatInBar === 0);
      }
      this.nextClickTime += spb;
      this.nextClickBeat++;
    }

    const now = this.ctx.currentTime;
    this.pendingClicks = this.pendingClicks.filter(c => c.at > now - 1);
  }

  findNextNoteIndex(time) {
    this.scheduledNoteIndex = 0;
    for (let i = 0; i < this.tabNotes.length; i++) {
      if (this.tabNotes[i].time >= time) {
        this.scheduledNoteIndex = i;
        break;
      }
    }
  }

  /**
   * 精密先読みスケジューラー (Web Audio Clock基準)
   */
  runScheduler() {
    if (!this.isPlaying) return;

    const currentAudioTime = (this.ctx.currentTime - this.startTime) * this.playbackRate;
    const scheduleWindowEnd = currentAudioTime + (this.scheduleAheadTime * this.playbackRate);

    // カウントイン中はノートもクリックも予約しない (クリックは play() で予約済み)
    if (this.isCountInActive()) {
      this.scheduleTimer = setTimeout(() => this.runScheduler(), this.lookaheadMs);
      return;
    }

    // メトロノームのクリック予約
    this.scheduleMetronomeClicks(currentAudioTime, scheduleWindowEnd);

    // ループチェック
    if (this.loopEnabled && this.loopEnd > this.loopStart && currentAudioTime >= this.loopEnd) {
      this.seek(this.loopStart);
      return;
    }

    // スケジュール対象のノートを発音予約
    while (this.scheduledNoteIndex < this.tabNotes.length) {
      const note = this.tabNotes[this.scheduledNoteIndex];
      if (note.time > scheduleWindowEnd) break;

      if (note.time >= currentAudioTime - 0.05) {
        const noteAudioTime = this.startTime + (note.time / this.playbackRate);
        const durationScaled = note.duration / this.playbackRate;

        // ベースシンセ発音 (ミュートされていなければ)
        if (!this.isMuteBass && this.synth) {
          this.synth.playNote(note.midi, durationScaled, (note.velocity || 0.8) * this.bassVolume, noteAudioTime);
        }

        // 発音瞬間のコールバック予約 (指板発光・TABハイライト)
        const delayMs = Math.max(0, (noteAudioTime - this.ctx.currentTime) * 1000);
        setTimeout(() => {
          if (this.isPlaying && this.onNoteHit) {
            this.onNoteHit(note);
          }
        }, delayMs);
      }

      this.scheduledNoteIndex++;
    }

    this.scheduleTimer = setTimeout(() => this.runScheduler(), this.lookaheadMs);
  }

  /**
   * UI同期・タイムライン描画更新ループ (60fps)
   */
  runAnimationLoop() {
    if (!this.isPlaying) return;

    this.currentTime = (this.ctx.currentTime - this.startTime) * this.playbackRate;
    if (this.isCountInActive()) {
      // カウントイン中は開始位置に留める
      this.currentTime = this.pauseOffset;
    }
    if (this.duration > 0) {
      this.currentTime = Math.min(this.currentTime, this.duration);
    }

    const progress = this.duration > 0 ? this.currentTime / this.duration : 0;
    if (this.onTimeUpdate) {
      this.onTimeUpdate(this.currentTime, progress);
    }

    if (this.isPlaying) {
      requestAnimationFrame(() => this.runAnimationLoop());
    }
  }
}

