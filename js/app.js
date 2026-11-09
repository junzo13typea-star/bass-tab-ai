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
    this.currentTempo = null;
    this.loopA = 0;
    this.loopB = 0;
    this.isLoopActive = false;

    // 監査修正で追加した状態
    this.selectedNoteIndex = -1;  // 編集中の音符
    this.sensitivity = 'normal';  // 検出感度 ('low'|'normal'|'high')
    this.tuning = '4';            // チューニング ('4'|'5')
    this.timeSignature = '4/4';   // 拍子 ('4/4'|'3/4'|'6/8')
    this.lastFile = null;         // 再解析用に保持する最後のアップロードファイル
    this.isGeneratedTab = false;  // 解析で生成したTABかどうか (自動保存の対象)
    this.domExtra = null;         // 動的追加コントロールへの参照

    // UI改善で追加した状態
    this.autoScroll = true;       // 譜面の自動スクロール追従
    this.domProgress = null;      // 再生位置プログレスバーへの参照
    this.domStretchBadge = null;  // ピッチ保持の状態バッジ
    this.domNotice = null;        // 譜面エリアの恒常通知 (検出0件など)
    this.domHelp = null;          // 使い方モーダル
    this._toastTimer = null;
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
    this.tabRenderer.onNoteSelect = (index, note) => {
      this.selectedNoteIndex = index;
      this.updateEditBar();
    };

    // 3. バーチャル指板の初期化 (フレットタップで音を鳴らす)
    const fbContainer = document.getElementById('fretboardContainer');
    this.fretboard = new FretboardUI(fbContainer, (stringNum, fret) => {
      // 指板直接タップ時のベース発音
      const openMidi = { 1: 43, 2: 38, 3: 33, 4: 28, 5: 23 }[stringNum] || 28;
      const midi = openMidi + fret;
      this.synth.playNote(midi, 0.45, 0.85);
    });

    // 4. プレイヤーコールバックの配線
    this.player.onTimeUpdate = (currentTime, progress) => {
      this.tabRenderer.updateTime(currentTime);
      this.controls.updateTimeDisplay(currentTime, this.player.duration);
      this.updateProgressBar(progress);
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

    // 5.5 追加コントロール (拍子・チューニング・感度・再解析・書き出し・音符編集バー)
    this.initExtraControls();

    // 5.6 保存済み設定 (音量・速度・ミュート・チューニング・感度) の復元
    this.restoreSettings();

    // 6. デフォルトプリセットの読み込み (開いてすぐ試せる！)
    this.loadPreset('rock-drive');

    // 6.1 拍子だけはプリセット読込 (4/4 リセット) の後に保存値を適用する
    this.applyTimeSignatureSetting();

    // 6.5 前回生成したTABが保存されていれば復元する
    this.restoreSavedTab();

    // 6.6 初回のみ使い方モーダルを自動表示する
    this.maybeShowFirstRunHelp();

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
        this.saveSettings();
      },
      onChangeAudioVolume: (vol) => {
        this.player.setAudioVolume(vol);
        this.saveSettings();
      },
      onChangeBassVolume: (vol) => {
        this.player.setBassVolume(vol);
        this.saveSettings();
      },
      onToggleAudioMute: () => {
        const muted = this.player.toggleAudioMute();
        this.saveSettings();
        return muted;
      },
      onToggleBassMute: () => {
        const muted = this.player.toggleBassMute();
        this.saveSettings();
        return muted;
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

  /**
   * 追加コントロール群を動的に生成する (index.html は変更しない)
   * 拍子 / チューニング / 検出感度 / 再解析 / TAB書き出し / 自動スクロール /
   * 使い方 / 音符編集バー / ピッチ保持バッジ / 再生プログレスバー
   * 見た目は Studio Modern (白基調 + シアン #38bdf8) に統一する
   */
  initExtraControls() {
    const tabContainer = document.getElementById('tabViewContainer');
    if (!tabContainer || !tabContainer.parentNode) return;

    const BTN = 'font:inherit; font-size:13px; padding:5px 10px; border-radius:8px; border:1px solid #7dd3fc; background:#ffffff; color:#0369a1; cursor:pointer;';
    const SEL = 'font:inherit; font-size:13px; padding:4px 6px; border-radius:8px; border:1px solid #7dd3fc; background:#ffffff; color:#0f172a; cursor:pointer;';

    const wrap = document.createElement('div');
    wrap.id = 'auditFixControls';
    wrap.style.cssText = 'margin: 6px 0;';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:6px 2px; font-size:13px;';
    bar.innerHTML = `
      <label>拍子
        <select id="ctlTimeSignature" aria-label="拍子" style="${SEL}">
          <option value="4/4" selected>4/4</option>
          <option value="3/4">3/4</option>
          <option value="6/8">6/8</option>
        </select>
      </label>
      <label>チューニング
        <select id="ctlTuning" aria-label="チューニング" style="${SEL}">
          <option value="4" selected>4弦 (EADG)</option>
          <option value="5">5弦 (BEADG)</option>
        </select>
      </label>
      <label>検出感度
        <select id="ctlSensitivity" aria-label="検出感度" style="${SEL}">
          <option value="low">低</option>
          <option value="normal" selected>標準</option>
          <option value="high">高</option>
        </select>
      </label>
      <button id="btnReanalyze" type="button" aria-label="再解析" style="${BTN}">🔁 再解析</button>
      <button id="btnExportTab" type="button" aria-label="TAB書き出し" style="${BTN}">📄 TAB書き出し</button>
      <button id="btnAutoScroll" type="button" aria-label="自動スクロールの切り替え" aria-pressed="true" style="${BTN}">⇥ 自動スクロール: ON</button>
      <button id="btnHelp" type="button" aria-label="使い方を表示" style="${BTN}">❓ 使い方</button>
      <span id="stretchBadge" role="status" style="display:none; font-size:12px; padding:4px 8px; border-radius:999px; background:rgba(56,189,248,0.12); border:1px solid rgba(56,189,248,0.6); color:#7dd3fc;">ピッチ保持を準備中…</span>
    `;

    const editBar = document.createElement('div');
    editBar.id = 'noteEditBar';
    editBar.style.cssText = 'display:none; flex-wrap:wrap; gap:8px; align-items:center; padding:6px 8px; font-size:13px; background:rgba(56,189,248,0.10); border:1px solid rgba(56,189,248,0.55); border-radius:8px;';
    editBar.innerHTML = `
      <span id="editNoteInfo">音符を選択中</span>
      <button id="btnNoteUp" type="button" aria-label="音程を半音上げる" style="${BTN}">半音 ▲</button>
      <button id="btnNoteDown" type="button" aria-label="音程を半音下げる" style="${BTN}">半音 ▼</button>
      <button id="btnNoteDelete" type="button" aria-label="選択中の音符を削除" style="${BTN}">🗑 削除</button>
      <button id="btnNoteClose" type="button" aria-label="音符編集を閉じる" style="${BTN}">✕ 閉じる</button>
    `;

    wrap.appendChild(bar);
    wrap.appendChild(editBar);
    tabContainer.parentNode.insertBefore(wrap, tabContainer.nextSibling);

    this.domExtra = {
      timeSigSelect: bar.querySelector('#ctlTimeSignature'),
      tuningSelect: bar.querySelector('#ctlTuning'),
      sensSelect: bar.querySelector('#ctlSensitivity'),
      autoScrollBtn: bar.querySelector('#btnAutoScroll'),
      editBar,
      editNoteInfo: editBar.querySelector('#editNoteInfo')
    };
    this.domStretchBadge = bar.querySelector('#stretchBadge');

    // ピッチ保持ストレッチの生成状態をバッジに反映する
    if (this.player) {
      this.player.onStretchState = (state, rate) => this.handleStretchState(state, rate);
    }

    this.domExtra.timeSigSelect.addEventListener('change', (e) => {
      this.setTimeSignatureUI(e.target.value);
      this.saveSettings();
      if (this.isGeneratedTab) this.saveGeneratedTab();
    });
    this.domExtra.tuningSelect.addEventListener('change', (e) => {
      this.setTuningUI(e.target.value);
      this.saveSettings();
    });
    this.domExtra.sensSelect.addEventListener('change', (e) => {
      this.sensitivity = e.target.value;
      this.saveSettings();
    });
    bar.querySelector('#btnReanalyze').addEventListener('click', () => {
      if (this.lastFile) {
        this.processUploadedFile(this.lastFile);
      } else {
        this.showToast('先に音声ファイルを読み込んでください');
      }
    });
    bar.querySelector('#btnExportTab').addEventListener('click', () => {
      this.exportTextTab();
    });
    this.domExtra.autoScrollBtn.addEventListener('click', () => {
      this.setAutoScrollUI(!this.autoScroll);
    });
    bar.querySelector('#btnHelp').addEventListener('click', () => {
      this.openHelp();
    });
    editBar.querySelector('#btnNoteUp').addEventListener('click', () => this.shiftSelectedNote(1));
    editBar.querySelector('#btnNoteDown').addEventListener('click', () => this.shiftSelectedNote(-1));
    editBar.querySelector('#btnNoteDelete').addEventListener('click', () => this.deleteSelectedNote());
    editBar.querySelector('#btnNoteClose').addEventListener('click', () => this.tabRenderer.setSelectedNote(-1));

    // 再生位置プログレスバー (譜面の直上)
    this.initProgressBar(tabContainer);
  }

  /**
   * チューニング変更を mapper / TAB描画 / 指板 のすべてへ連動させる
   */
  setTuningUI(tuning) {
    this.tuning = tuning === '5' ? '5' : '4';
    this.mapper.setTuning(this.tuning);
    if (this.tabRenderer) this.tabRenderer.setTuning(this.tuning);
    if (this.fretboard) this.fretboard.setTuning(this.tuning);
    if (this.domExtra && this.domExtra.tuningSelect) {
      this.domExtra.tuningSelect.value = this.tuning;
    }
    this.showToast(this.tuning === '5'
      ? '5弦チューニング: 譜面と指板にB弦行を表示しました (Low B の検出は再解析で反映されます)'
      : '4弦チューニングに戻しました (検出範囲の反映は再解析が必要です)');
  }

  /**
   * 自動スクロール追従の ON/OFF を切り替える
   */
  setAutoScrollUI(enabled) {
    this.autoScroll = !!enabled;
    if (this.tabRenderer) this.tabRenderer.setAutoScroll(this.autoScroll);
    if (this.domExtra && this.domExtra.autoScrollBtn) {
      this.domExtra.autoScrollBtn.textContent = this.autoScroll ? '⇥ 自動スクロール: ON' : '⇥ 自動スクロール: OFF';
      this.domExtra.autoScrollBtn.setAttribute('aria-pressed', String(this.autoScroll));
    }
  }

  /**
   * ピッチ保持ストレッチの生成状態に応じてバッジを出し分ける
   */
  handleStretchState(state, rate) {
    if (!this.domStretchBadge) return;
    if (state === 'generating') {
      this.domStretchBadge.textContent = `ピッチ保持を準備中… (${rate}x)`;
      this.domStretchBadge.style.display = 'inline-block';
    } else {
      this.domStretchBadge.style.display = 'none';
      if (state === 'failed') {
        this.showToast('ピッチ保持の生成に失敗したため、通常再生を継続します', 4000);
      }
    }
  }

  /**
   * 再生位置を示す細いプログレスバーを動的生成する (クリック/タップでシーク可能)
   */
  initProgressBar(tabContainer) {
    if (!tabContainer || !tabContainer.parentNode) return;
    const bar = document.createElement('div');
    bar.id = 'tabProgressBar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', '再生位置');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', '0');
    bar.style.cssText = 'position:relative; height:16px; margin:2px 0 0; cursor:pointer; display:flex; align-items:center;';
    bar.innerHTML = `
      <div style="position:absolute; left:0; right:0; height:6px; border-radius:3px; background:rgba(56,189,248,0.18);"></div>
      <div id="tabProgressFill" style="position:absolute; left:0; height:6px; width:0%; border-radius:3px; background:#38bdf8;"></div>
    `;
    tabContainer.parentNode.insertBefore(bar, tabContainer);
    this.domProgress = {
      bar,
      fill: bar.querySelector('#tabProgressFill')
    };
    bar.addEventListener('pointerdown', (e) => {
      if (!this.player || !(this.player.duration > 0)) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      this.player.seek(ratio * this.player.duration);
    });
  }

  updateProgressBar(progress) {
    if (!this.domProgress) return;
    const pct = Math.min(100, Math.max(0, (progress || 0) * 100));
    this.domProgress.fill.style.width = `${pct}%`;
    this.domProgress.bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  /**
   * 譜面エリアに残り続ける通知カードを表示する (検出0件など、見落とせない案内用)
   * actions: [{ label, primary?, onClick }] — ボタンはシアン基調で統一
   */
  showTabNotice({ title, lines = [], actions = [] }) {
    this.hideTabNotice();
    const tabContainer = document.getElementById('tabViewContainer');
    if (!tabContainer || !tabContainer.parentNode) return;

    const BTN = 'font:inherit; font-size:13px; padding:5px 10px; border-radius:8px; border:1px solid #7dd3fc; background:#ffffff; color:#0369a1; cursor:pointer;';
    const BTN_PRIMARY = 'font:inherit; font-size:13px; padding:5px 10px; border-radius:8px; border:1px solid #38bdf8; background:#38bdf8; color:#082f49; cursor:pointer; font-weight:600;';

    const notice = document.createElement('div');
    notice.id = 'tabNotice';
    notice.setAttribute('role', 'alert');
    notice.style.cssText = 'margin:6px 0; padding:10px 12px; border-radius:10px; background:#ffffff; border:1px solid #bae6fd; border-left:4px solid #38bdf8; color:#0f172a; font-size:13px; line-height:1.6; box-shadow:0 2px 10px rgba(2,132,199,0.08);';

    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:700; margin-bottom:4px;';
    titleEl.textContent = title;
    notice.appendChild(titleEl);

    for (const line of lines) {
      const p = document.createElement('div');
      p.textContent = line;
      notice.appendChild(p);
    }

    if (actions.length > 0) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;';
      for (const action of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = action.label;
        btn.setAttribute('aria-label', action.label);
        btn.style.cssText = action.primary ? BTN_PRIMARY : BTN;
        btn.addEventListener('click', () => { if (action.onClick) action.onClick(); });
        row.appendChild(btn);
      }
      notice.appendChild(row);
    }

    tabContainer.parentNode.insertBefore(notice, tabContainer);
    this.domNotice = notice;
  }

  hideTabNotice() {
    if (this.domNotice) {
      this.domNotice.remove();
      this.domNotice = null;
    }
  }

  /**
   * モーダルメッセージ (alert() の置き換え)。解析失敗など長文の案内に使う
   */
  showMessage(title, lines = []) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; z-index:1200; background:rgba(2,20,35,0.55); display:flex; align-items:center; justify-content:center; padding:16px;';
    const card = document.createElement('div');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', title);
    card.style.cssText = 'max-width:520px; width:100%; max-height:85vh; overflow:auto; background:#ffffff; color:#0f172a; border-radius:14px; border-top:4px solid #38bdf8; padding:18px 20px; font-size:14px; line-height:1.7; box-shadow:0 12px 40px rgba(0,0,0,0.35);';
    const h = document.createElement('div');
    h.style.cssText = 'font-size:16px; font-weight:700; margin-bottom:8px;';
    h.textContent = title;
    card.appendChild(h);
    for (const line of lines) {
      const p = document.createElement('div');
      p.textContent = line;
      card.appendChild(p);
    }
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = '閉じる';
    ok.setAttribute('aria-label', 'メッセージを閉じる');
    ok.style.cssText = 'font:inherit; margin-top:14px; padding:6px 18px; border-radius:8px; border:1px solid #38bdf8; background:#38bdf8; color:#082f49; cursor:pointer; font-weight:600;';
    const close = () => overlay.remove();
    ok.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    card.appendChild(ok);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  /**
   * 使い方モーダルを構築する (初回は自動表示、以降は「❓ 使い方」ボタンから)
   */
  buildHelpModal() {
    if (this.domHelp) return this.domHelp;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; z-index:1200; background:rgba(2,20,35,0.55); display:none; align-items:center; justify-content:center; padding:16px;';
    const card = document.createElement('div');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'BassTab AI の使い方');
    card.style.cssText = 'max-width:560px; width:100%; max-height:85vh; overflow:auto; background:#ffffff; color:#0f172a; border-radius:14px; border-top:4px solid #38bdf8; padding:18px 20px; font-size:14px; line-height:1.7; box-shadow:0 12px 40px rgba(0,0,0,0.35);';
    card.innerHTML = `
      <div style="font-size:17px; font-weight:700; margin-bottom:6px;">🎸 BassTab AI の使い方</div>
      <div style="font-weight:700; margin-top:10px;">1. まずはプリセットで試す</div>
      <div>上のプリセット一覧から曲を選ぶと、すぐにTAB譜の再生が始まります。スペースキーでも再生/一時停止できます。</div>
      <div style="font-weight:700; margin-top:10px;">2. 自分の曲からTABを作る</div>
      <div>音声ファイル (MP3/WAVなど) をドロップまたは選択すると、AIがベースラインを自動で採譜します。検出できないときは「検出感度」を上げて「🔁 再解析」を押してください。感度は、音が小さい・埋もれ気味の曲では「高」、ノイズを拾いすぎるときは「低」が向いています。</div>
      <div style="font-weight:700; margin-top:10px;">3. 譜面の操作</div>
      <div>譜面をドラッグすると左右にスクロールできます。クリックでその位置へジャンプ (シーク) します。「自動スクロール」をOFFにすると、再生中も譜面が追従しません。譜面の上の細いバーからも位置移動できます。</div>
      <div style="font-weight:700; margin-top:10px;">4. 音符の編集</div>
      <div>譜面の音符をクリックすると選択でき、編集バーで半音の上げ下げと削除ができます。運指 (弦とフレット) は自動で最も近い位置に直ります。</div>
      <div style="font-weight:700; margin-top:10px;">5. 指板</div>
      <div>下の指板はタップするとその音が鳴ります。再生中は今弾くべきフレットが光ります。</div>
      <div style="font-weight:700; margin-top:10px;">6. 練習サポート</div>
      <div>速度を変えてもピッチは保たれます (準備中はバッジが表示されます)。A-Bループ、原曲/ベースの音量バランス、拍子 (4/4・3/4・6/8) とチューニング (5弦はLow B対応) も切り替えられます。</div>
      <div style="font-weight:700; margin-top:10px;">7. 保存と書き出し</div>
      <div>生成したTABは自動で保存され、次回開いたときに復元されます (原曲音源は保存できないためシンセ再生のみ)。「📄 TAB書き出し」でテキスト譜としてダウンロードできます。</div>
    `;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = '閉じる';
    ok.setAttribute('aria-label', '使い方を閉じる');
    ok.style.cssText = 'font:inherit; margin-top:14px; padding:6px 18px; border-radius:8px; border:1px solid #38bdf8; background:#38bdf8; color:#082f49; cursor:pointer; font-weight:600;';
    ok.addEventListener('click', () => this.closeHelp());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeHelp(); });
    card.appendChild(ok);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this.domHelp = overlay;
    return overlay;
  }

  openHelp() {
    const overlay = this.buildHelpModal();
    overlay.style.display = 'flex';
  }

  closeHelp() {
    if (this.domHelp) this.domHelp.style.display = 'none';
    try { localStorage.setItem('basstab.helpSeen.v1', '1'); } catch (e) { /* 保存失敗は無視 */ }
  }

  maybeShowFirstRunHelp() {
    let seen = null;
    try { seen = localStorage.getItem('basstab.helpSeen.v1'); } catch (e) { /* 読めなければ表示しない */ }
    if (seen === null) {
      // localStorage が使える環境でのみ初回判定する (使えない場合は毎回出さない)
      try { localStorage.setItem('basstab.helpProbe', '1'); localStorage.removeItem('basstab.helpProbe'); }
      catch (e) { return; }
      this.openHelp();
    }
  }

  /**
   * 設定 (音量・速度・ミュート・拍子・チューニング・感度) を生成TABとは別キーで保存する
   */
  saveSettings() {
    try {
      const payload = {
        version: 1,
        audioVolume: this.player ? this.player.audioVolume : 0.8,
        bassVolume: this.player ? this.player.bassVolume : 1.0,
        isMuteAudio: this.player ? this.player.isMuteAudio : false,
        isMuteBass: this.player ? this.player.isMuteBass : false,
        playbackRate: this.player ? this.player.playbackRate : 1.0,
        timeSignature: this.timeSignature,
        tuning: this.tuning,
        sensitivity: this.sensitivity
      };
      localStorage.setItem('basstab.settings.v1', JSON.stringify(payload));
    } catch (e) {
      // 保存失敗時は無視 (アプリ動作は継続)
    }
  }

  loadSettings() {
    try {
      return JSON.parse(localStorage.getItem('basstab.settings.v1') || 'null');
    } catch (e) {
      return null;
    }
  }

  /**
   * 保存済み設定を起動時に復元する (拍子はプリセット読込後に別途適用)
   */
  restoreSettings() {
    const s = this.loadSettings();
    if (!s || !this.player) return;
    const dom = this.controls ? this.controls.dom : {};

    // チューニング (mapper / 譜面 / 指板へ連動。トーストは出さない)
    if (s.tuning) {
      this.tuning = s.tuning === '5' ? '5' : '4';
      this.mapper.setTuning(this.tuning);
      if (this.tabRenderer) this.tabRenderer.setTuning(this.tuning);
      if (this.fretboard) this.fretboard.setTuning(this.tuning);
      if (this.domExtra && this.domExtra.tuningSelect) this.domExtra.tuningSelect.value = this.tuning;
    }
    // 感度
    if (s.sensitivity && ['low', 'normal', 'high'].includes(s.sensitivity)) {
      this.sensitivity = s.sensitivity;
      if (this.domExtra && this.domExtra.sensSelect) this.domExtra.sensSelect.value = s.sensitivity;
    }
    // 音量 (スライダー表示も同期)
    if (typeof s.audioVolume === 'number') {
      this.player.setAudioVolume(s.audioVolume);
      if (dom.sliderAudioVol) dom.sliderAudioVol.value = s.audioVolume;
    }
    if (typeof s.bassVolume === 'number') {
      this.player.setBassVolume(s.bassVolume);
      if (dom.sliderBassVol) dom.sliderBassVol.value = s.bassVolume;
    }
    // ミュート (ボタン表示も同期)
    if (s.isMuteAudio && !this.player.isMuteAudio) {
      this.player.toggleAudioMute();
      if (dom.btnMuteAudio) {
        dom.btnMuteAudio.classList.add('muted');
        dom.btnMuteAudio.textContent = '🔇 原曲OFF';
      }
    }
    if (s.isMuteBass && !this.player.isMuteBass) {
      this.player.toggleBassMute();
      if (dom.btnMuteBass) {
        dom.btnMuteBass.classList.add('muted');
        dom.btnMuteBass.textContent = '🔇 ベースOFF';
      }
    }
    // 再生速度 (スライダーとラベルも同期)
    if (typeof s.playbackRate === 'number' && s.playbackRate !== 1) {
      this.player.setPlaybackRate(s.playbackRate);
      if (dom.sliderSpeed) dom.sliderSpeed.value = s.playbackRate;
      if (dom.labelSpeed) dom.labelSpeed.textContent = `${s.playbackRate.toFixed(2)}x`;
    }
  }

  /**
   * 保存済みの拍子を適用する (プリセット読込の 4/4 リセット後に呼ぶ)
   */
  applyTimeSignatureSetting() {
    const s = this.loadSettings();
    if (s && s.timeSignature) {
      this.setTimeSignatureUI(s.timeSignature);
    }
  }

  setTimeSignatureUI(sig) {
    this.timeSignature = ['4/4', '3/4', '6/8'].includes(sig) ? sig : '4/4';
    if (this.tabRenderer) this.tabRenderer.setTimeSignature(this.timeSignature);
    if (this.domExtra && this.domExtra.timeSigSelect) {
      this.domExtra.timeSigSelect.value = this.timeSignature;
    }
  }

  /**
   * 音符編集バーの表示を現在の選択に合わせて更新する
   */
  updateEditBar() {
    if (!this.domExtra || !this.domExtra.editBar) return;
    const note = this.selectedNoteIndex >= 0 ? this.currentTabNotes[this.selectedNoteIndex] : null;
    if (!note) {
      this.domExtra.editBar.style.display = 'none';
      return;
    }
    this.domExtra.editBar.style.display = 'flex';
    this.domExtra.editNoteInfo.textContent =
      `選択中: ${note.noteName || ''} (${note.string}弦 ${note.fret}F) ${note.time.toFixed(2)}s`;
  }

  /**
   * 編集中の音符の音程を半音単位でずらす (string/fret はマッパーのテーブルで再計算)
   */
  shiftSelectedNote(delta) {
    const note = this.selectedNoteIndex >= 0 ? this.currentTabNotes[this.selectedNoteIndex] : null;
    if (!note) return;

    const newMidi = Math.max(23, Math.min(67, note.midi + delta));
    if (newMidi === note.midi) return;
    note.midi = newMidi;
    note.freq = this.analyzer.midiToFreq(newMidi);

    const cands = this.mapper.getCandidates(newMidi);
    if (cands.length > 0) {
      // 現在のポジションに最も近い候補を選ぶ
      let best = cands[0];
      let bestScore = Infinity;
      for (const c of cands) {
        const score = Math.abs(c.string - note.string) * 10 + Math.abs(c.fret - note.fret);
        if (score < bestScore) { bestScore = score; best = c; }
      }
      note.string = best.string;
      note.fret = best.fret;
    } else if (newMidi < this.mapper.minMidi) {
      note.string = this.mapper.stringCount;
      note.fret = 0;
    } else {
      note.string = 1;
      note.fret = this.mapper.MAX_FRETS;
    }
    note.noteName = this.mapper.midiToNoteName(newMidi);

    this.syncNotesAfterEdit();
    this.updateEditBar();
    if (this.tabRenderer) this.tabRenderer.render();
  }

  deleteSelectedNote() {
    const idx = this.selectedNoteIndex;
    if (idx < 0 || idx >= this.currentTabNotes.length) return;
    this.currentTabNotes.splice(idx, 1);
    if (this.tabRenderer) this.tabRenderer.setSelectedNote(-1);
    this.syncNotesAfterEdit();
    this.showToast('音符を削除しました');
  }

  /**
   * 編集結果をレンダラーとプレイヤーへ反映し、生成TABなら自動保存する
   */
  syncNotesAfterEdit() {
    if (this.tabRenderer) this.tabRenderer.updateTabNotes(this.currentTabNotes);
    if (this.player) {
      this.player.tabNotes = this.currentTabNotes;
      if (this.player.isPlaying) {
        this.player.findNextNoteIndex(this.player.currentTime);
      }
    }
    if (this.isGeneratedTab) this.saveGeneratedTab();
  }

  /**
   * 現在のノート列から ASCII TAB 文字列を生成する
   */
  generateTextTab() {
    const notes = [...this.currentTabNotes].sort((a, b) => a.time - b.time);
    const bpm = (this.currentTempo && this.currentTempo.bpm) || (this.tabRenderer ? this.tabRenderer.bpm : 120) || 120;
    const offset = (this.currentTempo && this.currentTempo.offset) || 0;
    const barBeats = { '4/4': 4, '3/4': 3, '6/8': 3 }[this.timeSignature] || 4;
    const barLen = (60 / bpm) * barBeats;

    const hasLowB = notes.some(n => (n.string || 0) >= 5);
    const stringNums = hasLowB ? [1, 2, 3, 4, 5] : [1, 2, 3, 4];
    const labels = { 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B' };
    const lines = {};
    stringNums.forEach(s => { lines[s] = `${labels[s]}|`; });

    // 同時刻の音を1カラムにまとめる
    const columns = [];
    for (const n of notes) {
      const key = Math.round(n.time * 1000);
      const last = columns[columns.length - 1];
      if (last && last.key === key) last.notes.push(n);
      else columns.push({ key, time: n.time, notes: [n] });
    }

    let prevBar = null;
    for (const col of columns) {
      const barIdx = Math.floor((col.time - offset + 1e-6) / barLen);
      if (prevBar !== null && barIdx !== prevBar) {
        stringNums.forEach(s => { lines[s] += '|'; });
      }
      prevBar = barIdx;

      let colWidth = 3;
      for (const n of col.notes) colWidth = Math.max(colWidth, String(n.fret).length + 2);
      for (const s of stringNums) {
        const hit = col.notes.find(n => (n.string || 4) === s);
        const cell = hit ? String(hit.fret) : '';
        lines[s] += cell.padEnd(colWidth, '-');
      }
    }
    stringNums.forEach(s => { lines[s] += '|'; });

    const header = [
      `BassTab AI - ${this.currentTrackTitle || 'Untitled'}`,
      `BPM: ${Math.round(bpm * 10) / 10} / 拍子: ${this.timeSignature} / チューニング: ${this.tuning === '5' ? '5弦 (BEADG)' : '4弦 (EADG)'} / 音符数: ${notes.length}`,
      ''
    ];
    return header.concat(stringNums.map(s => lines[s])).join('\n') + '\n';
  }

  exportTextTab() {
    if (!this.currentTabNotes || this.currentTabNotes.length === 0) {
      this.showToast('書き出すTABがありません');
      return;
    }
    const text = this.generateTextTab();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (this.currentTrackTitle || 'basstab').replace(/[^\w\- ]+/g, '').trim() || 'basstab';
    a.href = url;
    a.download = `${safeName}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast('📄 テキストTABをダウンロードしました');
  }

  /**
   * 生成したTABを localStorage に自動保存する
   */
  saveGeneratedTab() {
    try {
      const payload = {
        version: 1,
        title: this.currentTrackTitle,
        tempo: this.currentTempo,
        timeSignature: this.timeSignature,
        tuning: this.tuning,
        sensitivity: this.sensitivity,
        notes: this.currentTabNotes,
        savedAt: Date.now()
      };
      localStorage.setItem('basstab.savedTab.v1', JSON.stringify(payload));
    } catch (e) {
      // 容量超過などでは保存を諦める (アプリ動作は継続)
      console.warn('TABの自動保存に失敗しました:', e);
    }
  }

  /**
   * 保存済みの生成TABがあれば復元する (原曲音源は保存できないためシンセ再生のみ)
   */
  restoreSavedTab() {
    let payload = null;
    try {
      payload = JSON.parse(localStorage.getItem('basstab.savedTab.v1') || 'null');
    } catch (e) { /* 破損データは無視 */ }
    if (!payload || !Array.isArray(payload.notes) || payload.notes.length === 0) return;

    this.player.stop();
    this.currentTrackTitle = payload.title || '保存済みTAB';
    this.currentAudioBuffer = null;
    this.currentTabNotes = payload.notes;
    this.currentTempo = payload.tempo || null;
    this.isGeneratedTab = true;

    if (payload.tuning) {
      this.tuning = payload.tuning === '5' ? '5' : '4';
      this.mapper.setTuning(this.tuning);
      if (this.tabRenderer) this.tabRenderer.setTuning(this.tuning);
      if (this.fretboard) this.fretboard.setTuning(this.tuning);
      if (this.domExtra && this.domExtra.tuningSelect) this.domExtra.tuningSelect.value = this.tuning;
    }
    if (payload.sensitivity) {
      this.sensitivity = payload.sensitivity;
      if (this.domExtra && this.domExtra.sensSelect) this.domExtra.sensSelect.value = payload.sensitivity;
    }

    const lastNote = payload.notes[payload.notes.length - 1];
    const duration = lastNote ? lastNote.time + lastNote.duration + 1.5 : 10;
    this.player.loadTrack(null, this.currentTabNotes);
    const bpm = (this.currentTempo && this.currentTempo.bpm) || 120;
    const beatOffset = (this.currentTempo && this.currentTempo.offset) || 0;
    this.tabRenderer.setTabNotes(this.currentTabNotes, duration, bpm, beatOffset);
    this.setTimeSignatureUI(payload.timeSignature || '4/4');

    this.updateTrackInfo(this.currentTrackTitle,
      `保存済みTABを復元 • ${payload.notes.length}音符 • 推定 ${Math.round(bpm)} BPM (原曲音源なし・シンセ再生のみ)`);
    this.controls.updateTimeDisplay(0, duration);
    this.showToast('💾 前回生成したTAB譜を復元しました');
  }

  loadPreset(presetId) {
    const preset = PRESETS.find(p => p.id === presetId) || PRESETS[0];
    this.player.stop();
    this.hideTabNotice();

    this.currentTrackTitle = preset.title;
    this.currentAudioBuffer = null;
    // プリセット定義そのものを書き換えないようコピーを保持する (音符編集のため)
    this.currentTabNotes = preset.notes.map(n => ({ ...n }));
    this.currentTempo = { bpm: preset.bpm, offset: 0 };
    this.isGeneratedTab = false;

    // トラック情報表示更新
    this.updateTrackInfo(preset.title, `${preset.genre} • ${preset.bpm} BPM • ${preset.desc}`);

    // TAB譜・プレイヤーへのセット
    const lastNote = preset.notes[preset.notes.length - 1];
    const duration = lastNote ? lastNote.time + lastNote.duration + 1.5 : 10;

    this.player.loadTrack(null, this.currentTabNotes);
    this.tabRenderer.setTabNotes(this.currentTabNotes, duration, preset.bpm);
    // プリセット読み込み時は拍子を 4/4 に戻す
    this.setTimeSignatureUI('4/4');
    this.controls.updateTimeDisplay(0, duration);

    this.showToast(`🎵 プリセット「${preset.title.split(' ')[1]}」をロードしました`);
  }

  async processUploadedFile(file) {
    if (!file) return;
    this.player.stop();
    this.hideTabNotice();
    this.lastFile = file; // 感度・チューニング変更後の再解析用

    const fileName = file.name.replace(/\.[^/.]+$/, "");
    this.currentTrackTitle = fileName;
    this.controls.showProgress(0.05, 'オーディオファイルをデコード中...');

    try {
      // 1. デコード
      const audioBuffer = await this.analyzer.decodeAudio(file);
      this.currentAudioBuffer = audioBuffer;

      // 2. ベース帯域抽出
      this.controls.showProgress(0.25, 'ベース周波数帯域を抽出中...');
      const bassBuffer = await this.analyzer.filterBassBand(audioBuffer);

      // 3. ピッチ＆ノート検出 (感度・チューニング設定を反映)
      const rawNotes = await this.analyzer.analyzeBassline(bassBuffer, (pct) => {
        this.controls.showProgress(0.3 + pct * 0.5, 'ベース音程とリズムを採譜中...');
      }, { sensitivity: this.sensitivity, tuning: this.tuning });

      // 4. テンポ推定とリズム量子化 (拍グリッドへ吸着させ、小節線とリズムを一致させる)
      const tempo = this.analyzer.estimateTempo(rawNotes);
      const quantizedNotes = this.analyzer.quantizeNotes(rawNotes, tempo.bpm, tempo.offset);
      this.currentTempo = tempo;

      // 5. 最適運指決定 (4弦TAB譜化)
      this.controls.showProgress(0.88, '最適なベース運指ポジションを計算中...');
      const tabNotes = this.mapper.mapNotesToTab(quantizedNotes);
      this.currentTabNotes = tabNotes;

      // 検出 0 件は成功扱いにせず、理由候補と対処法を譜面エリアに残し続ける
      if (tabNotes.length === 0) {
        this.isGeneratedTab = false;
        this.player.loadTrack(audioBuffer, []);
        this.tabRenderer.setTabNotes([], audioBuffer.duration, tempo.bpm, tempo.offset);
        this.updateTrackInfo(fileName, 'AI自動採譜 • 検出 0 件');
        this.controls.updateTimeDisplay(0, audioBuffer.duration);
        this.controls.hideProgress();
        this.showTabNotice({
          title: 'ベース音を検出できませんでした',
          lines: [
            '考えられる理由: ベースの音量が小さい / 低音成分が少ない、ベース以外の楽器が大きく低音が埋もれている、ファイルの冒頭が無音に近い。',
            '対処法: 「検出感度」を「高」に切り替えて再解析してください。'
          ],
          actions: [
            {
              label: '感度を「高」にして再解析',
              primary: true,
              onClick: () => {
                this.sensitivity = 'high';
                if (this.domExtra && this.domExtra.sensSelect) this.domExtra.sensSelect.value = 'high';
                this.saveSettings();
                if (this.lastFile) this.processUploadedFile(this.lastFile);
              }
            },
            { label: '閉じる', onClick: () => this.hideTabNotice() }
          ]
        });
        this.showToast('ベース音を検出できませんでした', 4000);
        return;
      }

      // 6. プレイヤー & TAB譜にセット
      this.controls.showProgress(0.98, 'TAB譜を描画中...');
      this.hideTabNotice();
      this.player.loadTrack(audioBuffer, tabNotes);
      this.tabRenderer.setTabNotes(tabNotes, audioBuffer.duration, tempo.bpm, tempo.offset);
      this.isGeneratedTab = true;
      this.saveGeneratedTab();

      this.updateTrackInfo(fileName, `AI自動採譜 • ${tabNotes.length}音符検出 • 推定 ${Math.round(tempo.bpm)} BPM • 長さ ${this.controls.formatTime(audioBuffer.duration)}`);
      this.controls.updateTimeDisplay(0, audioBuffer.duration);

      this.controls.hideProgress();
      this.showToast(`🎉 「${fileName}」のベースTAB譜を生成しました！`);

    } catch (err) {
      console.error('Audio processing error:', err);
      this.controls.hideProgress();
      this.showMessage('音声の解析に失敗しました', [
        `エラー内容: ${err.message || '不明なエラー'}`,
        '対応形式は MP3 / WAV などの一般的な音声ファイルです。ファイルが破損していないか、別のファイルでもお試しください。'
      ]);
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

  showToast(msg, durationMs = 3000) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast-popup';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    // 連続表示時は前のタイマーを破棄し、新しいメッセージの表示時間を保証する
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), durationMs);
  }
}

// アプリ起動
window.addEventListener('DOMContentLoaded', () => {
  const app = new BassTabApp();
  app.init();
  window.bassApp = app;
});

