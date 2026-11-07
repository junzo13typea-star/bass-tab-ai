/**
 * BassTab AI - UI Controls & Event Handler Module
 */

export class Controls {
  constructor(domElements, callbacks) {
    this.dom = domElements;
    this.cb = callbacks;

    this.initEvents();
  }

  initEvents() {
    // 1. 再生 / 一時停止
    this.dom.btnPlayPause?.addEventListener('click', () => {
      this.cb.onTogglePlay();
    });

    // 2. 停止
    this.dom.btnStop?.addEventListener('click', () => {
      this.cb.onStop();
    });

    // 3. テンポ (再生速度) スライダー
    this.dom.sliderSpeed?.addEventListener('input', (e) => {
      const speed = parseFloat(e.target.value);
      if (this.dom.labelSpeed) {
        this.dom.labelSpeed.textContent = `${speed.toFixed(2)}x`;
      }
      this.cb.onChangeSpeed(speed);
    });

    // 4. 元音源ボリューム
    this.dom.sliderAudioVol?.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      this.cb.onChangeAudioVolume(vol);
    });

    // 5. ベース音ボリューム
    this.dom.sliderBassVol?.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      this.cb.onChangeBassVolume(vol);
    });

    // 6. マイナスワン (ミュート切替)
    this.dom.btnMuteAudio?.addEventListener('click', () => {
      const isMuted = this.cb.onToggleAudioMute();
      this.dom.btnMuteAudio.classList.toggle('muted', isMuted);
      this.dom.btnMuteAudio.textContent = isMuted ? '🔇 原曲OFF' : '🎵 原曲ON';
    });

    this.dom.btnMuteBass?.addEventListener('click', () => {
      const isMuted = this.cb.onToggleBassMute();
      this.dom.btnMuteBass.classList.toggle('muted', isMuted);
      this.dom.btnMuteBass.textContent = isMuted ? '🔇 ベースOFF' : '🎸 ベースON';
    });

    // 7. A-B ループ練習
    this.dom.btnSetLoopA?.addEventListener('click', () => {
      this.cb.onSetLoopA();
    });

    this.dom.btnSetLoopB?.addEventListener('click', () => {
      this.cb.onSetLoopB();
    });

    this.dom.btnToggleLoop?.addEventListener('click', () => {
      const active = this.cb.onToggleLoop();
      this.dom.btnToggleLoop.classList.toggle('active', active);
    });

    // 8. プリセット楽曲選択
    this.dom.presetSelect?.addEventListener('change', (e) => {
      const presetId = e.target.value;
      if (presetId) {
        this.cb.onSelectPreset(presetId);
      }
    });

    // 9. ファイルドラッグ＆ドロップ ＆ ファイル選択
    this.initFileDrop();

    // 10. キーボードショートカット (スペースキーで再生/停止)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        this.cb.onTogglePlay();
      }
    });
  }

  initFileDrop() {
    const dropZone = this.dom.dropZone;
    const fileInput = this.dom.fileInput;
    if (!dropZone || !fileInput) return;

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        this.cb.onFileSelected(files[0]);
      }
    });

    fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        this.cb.onFileSelected(files[0]);
      }
    });

    dropZone.addEventListener('click', () => {
      fileInput.click();
    });
  }

  updatePlayButton(isPlaying) {
    if (!this.dom.btnPlayPause) return;
    this.dom.btnPlayPause.textContent = isPlaying ? '⏸ 一時停止' : '▶️ 再生';
    this.dom.btnPlayPause.classList.toggle('playing', isPlaying);
  }

  updateTimeDisplay(currentTime, duration) {
    if (!this.dom.timeDisplay) return;
    const curStr = this.formatTime(currentTime);
    const durStr = this.formatTime(duration);
    this.dom.timeDisplay.textContent = `${curStr} / ${durStr}`;
  }

  showProgress(percent, message = 'ベース音を解析中...') {
    if (this.dom.loadingOverlay) {
      this.dom.loadingOverlay.style.display = 'flex';
    }
    if (this.dom.loadingProgressBar) {
      this.dom.loadingProgressBar.style.width = `${Math.round(percent * 100)}%`;
    }
    if (this.dom.loadingText) {
      this.dom.loadingText.textContent = `${message} (${Math.round(percent * 100)}%)`;
    }
  }

  hideProgress() {
    if (this.dom.loadingOverlay) {
      this.dom.loadingOverlay.style.display = 'none';
    }
  }

  formatTime(seconds) {
    const s = Math.floor(seconds || 0);
    const m = Math.floor(s / 60);
    const remS = s % 60;
    return `${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
  }
}
