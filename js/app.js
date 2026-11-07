/**
 * BassTab AI - Main Application Controller
 */

import { AudioAnalyzer } from './audio/analyzer.js';
import { BassSynth } from './audio/bass-synth.js';
import { SyncPlayer } from './audio/player.js';
import { FretMapper } from './tab/fret-mapper.js';
import { TabRenderer } from './tab/tab-renderer.js';
import { FretboardUI } from './ui/fretboard.js';
import { Controls } from './ui/controls.js';
import { PRESETS } from './presets.js';

class BassTabApp {
  constructor() {
    this.analyzer = new AudioAnalyzer();
    this.synth = new BassSynth();
    this.player = null;
    this.mapper = new FretMapper();
    this.tabRenderer = null;
    this.fretboard = null;
    this.controls = null;

    this.currentTrackTitle = 'Classic Rock 8-Beat';
    this.currentAudioBuffer = null;
    this.currentTabNotes = [];
    this.loopA = 0;
    this.loopB = 0;
    this.isLoopActive = false;
  }

  init() {
    // 1. Web Audio Context & Synth 初期化 (ユーザー初操作で起動)
    const ctx = this.analyzer.getAudioContext();
    this.synth.init(ctx);
    this.player = new SyncPlayer(ctx, this.synth);

    // 2. TAB譜レンダラーの初期化
    const tabCanvas = document.getElementById('tabCanvas');
    const tabContainer = document.getElementById('tabViewContainer');
    this.tabRenderer = new TabRenderer(tabCanvas, tabContainer);
    this.tabRenderer.onSeek = (timeSec) => {
      this.player.seek(timeSec);
    };

    // 3. バーチャル指板の初期化 (フレットタップで音を鳴らす)
    const fbContainer = document.getElementById('fretboardContainer');
    this.fretboard = new FretboardUI(fbContainer, (stringNum, fret) => {
      // 指板直接タップ時のベース発音
      const openMidi = { 1: 43, 2: 38, 3: 33, 4: 28 }[stringNum] || 28;
      const midi = openMidi + fret;
      this.synth.playNote(midi, 0.45, 0.85);
    });

    // 4. プレイヤーコールバックの配線
    this.player.onTimeUpdate = (currentTime, progress) => {
      this.tabRenderer.updateTime(currentTime);
      this.controls.updateTimeDisplay(currentTime, this.player.duration);
    };

    this.player.onNoteHit = (note) => {
      // 指板の該当フレットをリアルタイム発光
      if (note.string && note.fret !== undefined) {
        this.fretboard.highlightFret(note.string, note.fret, Math.max(0.15, note.duration));
      }
    };

    this.player.onPlayStateChange = (isPlaying) => {
      this.controls.updatePlayButton(isPlaying);
      if (!isPlaying) {
        this.fretboard.clearAllHighlights();
      }
    };

    // 5. UI コントロールの初期化
    this.initControls();

    // 6. デフォルトプリセットの読み込み (開いてすぐ試せる！)
    this.loadPreset('rock-drive');

    // 7. PWA Service Worker 登録
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js')
        .catch(err => console.log('SW registration failed:', err));
    }
  }

  initControls() {
    const dom = {
      btnPlayPause: document.getElementById('btnPlayPause'),
      btnStop: document.getElementById('btnStop'),
      sliderSpeed: document.getElementById('sliderSpeed'),
      labelSpeed: document.getElementById('labelSpeed'),
      sliderAudioVol: document.getElementById('sliderAudioVol'),
      sliderBassVol: document.getElementById('sliderBassVol'),
      btnMuteAudio: document.getElementById('btnMuteAudio'),
      btnMuteBass: document.getElementById('btnMuteBass'),
      btnSetLoopA: document.getElementById('btnSetLoopA'),
      btnSetLoopB: document.getElementById('btnSetLoopB'),
      btnToggleLoop: document.getElementById('btnToggleLoop'),
      presetSelect: document.getElementById('presetSelect'),
      dropZone: document.getElementById('dropZone'),
      fileInput: document.getElementById('fileInput'),
      timeDisplay: document.getElementById('timeDisplay'),
      loadingOverlay: document.getElementById('loadingOverlay'),
      loadingProgressBar: document.getElementById('loadingProgressBar'),
      loadingText: document.getElementById('loadingText')
    };

    // プリセットセレクトボックスの構築
    if (dom.presetSelect) {
      dom.presetSelect.innerHTML = PRESETS.map(p => `
        <option value="${p.id}">${p.title} (${p.bpm} BPM)</option>
      `).join('');
    }

    this.controls = new Controls(dom, {
      onTogglePlay: () => {
        if (this.player.isPlaying) {
          this.player.pause();
        } else {
          this.player.play();
        }
      },
      onStop: () => {
        this.player.stop();
        this.fretboard.clearAllHighlights();
      },
      onChangeSpeed: (speed) => {
        this.player.setPlaybackRate(speed);
      },
      onChangeAudioVolume: (vol) => {
        this.player.setAudioVolume(vol);
      },
      onChangeBassVolume: (vol) => {
        this.player.setBassVolume(vol);
      },
      onToggleAudioMute: () => {
        return this.player.toggleAudioMute();
      },
      onToggleBassMute: () => {
        return this.player.toggleBassMute();
      },
      onSetLoopA: () => {
        this.loopA = this.player.currentTime;
        this.showToast(`📍 A点設定: ${this.controls.formatTime(this.loopA)}`);
        this.updateLoopState();
      },
      onSetLoopB: () => {
        this.loopB = this.player.currentTime;
        this.showToast(`📍 B点設定: ${this.controls.formatTime(this.loopB)}`);
        this.updateLoopState();
      },
      onToggleLoop: () => {
        this.isLoopActive = !this.isLoopActive;
        this.updateLoopState();
        return this.isLoopActive;
      },
      onSelectPreset: (presetId) => {
        this.loadPreset(presetId);
      },
      onFileSelected: (file) => {
        this.processUploadedFile(file);
      }
    });
  }

  loadPreset(presetId) {
    const preset = PRESETS.find(p => p.id === presetId) || PRESETS[0];
    this.player.stop();

    this.currentTrackTitle = preset.title;
    this.currentAudioBuffer = null;
    this.currentTabNotes = preset.notes;

    // トラック情報表示更新
    this.updateTrackInfo(preset.title, `${preset.genre} • ${preset.bpm} BPM • ${preset.desc}`);

    // TAB譜・プレイヤーへのセット
    const lastNote = preset.notes[preset.notes.length - 1];
    const duration = lastNote ? lastNote.time + lastNote.duration + 1.5 : 10;

    this.player.loadTrack(null, this.currentTabNotes);
    this.tabRenderer.setTabNotes(this.currentTabNotes, duration, preset.bpm);
    this.controls.updateTimeDisplay(0, duration);

    this.showToast(`🎵 プリセット「${preset.title.split(' ')[1]}」をロードしました`);
  }

  async processUploadedFile(file) {
    if (!file) return;
    this.player.stop();

    const fileName = file.name.replace(/\.[^/.]+$/, "");
    this.controls.showProgress(0.05, 'オーディオファイルをデコード中...');

    try {
      // 1. デコード
      const audioBuffer = await this.analyzer.decodeAudio(file);
      this.currentAudioBuffer = audioBuffer;

      // 2. ベース帯域抽出
      this.controls.showProgress(0.25, 'ベース周波数帯域を抽出中...');
      const bassBuffer = await this.analyzer.filterBassBand(audioBuffer);

      // 3. ピッチ＆ノート検出
      const rawNotes = await this.analyzer.analyzeBassline(bassBuffer, (pct) => {
        this.controls.showProgress(0.3 + pct * 0.5, 'ベース音程とリズムを採譜中...');
      });

      // 4. 最適運指決定 (4弦TAB譜化)
      this.controls.showProgress(0.88, '最適なベース運指ポジションを計算中...');
      const tabNotes = this.mapper.mapNotesToTab(rawNotes);
      this.currentTabNotes = tabNotes;

      // 5. プレイヤー & TAB譜にセット
      this.controls.showProgress(0.98, 'TAB譜を描画中...');
      this.player.loadTrack(audioBuffer, tabNotes);
      this.tabRenderer.setTabNotes(tabNotes, audioBuffer.duration, 120);

      this.updateTrackInfo(fileName, `AI自動採譜 • ${tabNotes.length}音符検出 • 長さ ${this.controls.formatTime(audioBuffer.duration)}`);
      this.controls.updateTimeDisplay(0, audioBuffer.duration);

      this.controls.hideProgress();
      this.showToast(`🎉 「${fileName}」のベースTAB譜を生成しました！`);

    } catch (err) {
      console.error('Audio processing error:', err);
      this.controls.hideProgress();
      alert(`音声の解析に失敗しました: ${err.message || '形式をご確認ください'}`);
    }
  }

  updateTrackInfo(title, meta) {
    const titleEl = document.getElementById('currentTrackTitle');
    const metaEl = document.getElementById('currentTrackMeta');
    if (titleEl) titleEl.textContent = title;
    if (metaEl) metaEl.textContent = meta;
  }

  updateLoopState() {
    if (this.isLoopActive && this.loopB > this.loopA) {
      this.player.setLoop(true, this.loopA, this.loopB);
      this.tabRenderer.setLoop(true, this.loopA, this.loopB);
    } else {
      this.player.setLoop(false, 0, 0);
      this.tabRenderer.setLoop(false, 0, 0);
    }
  }

  showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast-popup';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
}

// アプリ起動
window.addEventListener('DOMContentLoaded', () => {
  const app = new BassTabApp();
  app.init();
  window.bassApp = app;
});
