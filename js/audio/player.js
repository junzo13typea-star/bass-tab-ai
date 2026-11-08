/**
 * BassTab AI - Audio & TAB Synchronized Player
 * 
 * 楽曲オーディオ再生とベースシンセ発音、TAB譜スクロール、指板発光を
 * サブミリ秒精度で同期制御するスタジオ・プレイヤーエンジン。
 */

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

    // 先読みスケジューラー
    this.scheduleTimer = null;
    this.scheduledNoteIndex = 0;
    this.lookaheadMs = 25.0;
    this.scheduleAheadTime = 0.12; // 120ms 先まで予約

    // コールバック
    this.onTimeUpdate = null; // (currentTime, progress) => {}
    this.onNoteHit = null;    // (note) => {}
    this.onPlayStateChange = null; // (isPlaying) => {}

    this.initAudioNodes();
  }

  initAudioNodes() {
    this.audioGainNode = this.ctx.createGain();
    this.audioGainNode.gain.value = this.audioVolume;
    this.audioGainNode.connect(this.ctx.destination);
  }

  loadTrack(audioBuffer, tabNotes) {
    this.stop();
    this.audioBuffer = audioBuffer;
    this.tabNotes = tabNotes || [];
    this.duration = audioBuffer ? audioBuffer.duration : (tabNotes.length > 0 ? tabNotes[tabNotes.length - 1].time + 2 : 0);
    this.loopStart = 0;
    this.loopEnd = this.duration;
    this.currentTime = 0;
    this.pauseOffset = 0;
    this.scheduledNoteIndex = 0;
  }

  play() {
    if (this.isPlaying) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.isPlaying = true;
    this.startTime = this.ctx.currentTime - (this.pauseOffset / this.playbackRate);

    // 1. 元音源オーディオの再生スタート
    if (this.audioBuffer) {
      this.sourceNode = this.ctx.createBufferSource();
      this.sourceNode.buffer = this.audioBuffer;
      this.sourceNode.playbackRate.value = this.playbackRate;
      this.sourceNode.connect(this.audioGainNode);

      const offset = Math.max(0, Math.min(this.pauseOffset, this.audioBuffer.duration));
      this.sourceNode.start(0, offset);

      this.sourceNode.onended = () => {
        if (this.isPlaying && !this.loopEnabled && this.currentTime >= this.duration - 0.2) {
          this.pause();
          this.seek(0);
        }
      };
    }

    // 2. 先読みベース音スケジューラーの開始
    this.findNextNoteIndex(this.pauseOffset);
    this.runScheduler();

    // 3. UI同期アニメーションループの開始
    this.runAnimationLoop();

    if (this.onPlayStateChange) this.onPlayStateChange(true);
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;

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
    if (this.isPlaying) {
      const currentPos = this.currentTime;
      this.pause();
      this.pauseOffset = currentPos;
      this.play();
    }
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

