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
import { loadLibraryEntries, upsertLibraryEntry, removeLibraryEntry } from './library.js';
import { MicRecorder, RECORD_MAX_SEC } from './recorder.js';
import { registerServiceWorker } from './sw-update.js';
import { installErrorGuard } from './error-guard.js';

// 未捕捉例外でも真っ白にならないためのグローバルエラーハンドラ (U3)
installErrorGuard();

/**
 * ペア取り込み (原曲＋ベースステム) のファイル名がステムらしいか判定する。
 * ファイル名に bass / stem / ベース を含むものをステム候補とする。
 */
export function isStemLikeName(name) {
  return /bass|stem|ベース/i.test(name || '');
}

/**
 * 取り込まれたファイル一式から { original, stem } の割り当てを決める (純関数)。
 * - 1ファイル: そのまま原曲のみ (stem は null)
 * - 2ファイル: 片方だけ名前がステムらしい場合はそちらをステムにする。
 *   両方/どちらでもない場合は並び順どおり [0]=原曲, [1]=ステム とし、
 *   ペア表示でユーザーに見えるようにする (黙って逆にしない)。
 * - 3つ以上: 先頭2つだけを使う。
 */
export function resolvePairFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return { original: list[0], stem: null };
  const a = list[0];
  const b = list[1];
  const aStem = isStemLikeName(a.name);
  const bStem = isStemLikeName(b.name);
  if (aStem && !bStem) return { original: b, stem: a };
  return { original: a, stem: b };
}

/**
 * 原曲とステムの長さのずれ (秒)。0.5秒を超えたら警告対象。
 */
export function pairDurationDiffSec(originalDuration, stemDuration) {
  if (!isFinite(originalDuration) || !isFinite(stemDuration)) return 0;
  return Math.abs(originalDuration - stemDuration);
}

export function shouldWarnPairMismatch(originalDuration, stemDuration) {
  return pairDurationDiffSec(originalDuration, stemDuration) > 0.5;
}

/**
 * 低信頼のしきい値。TAB描画側 (tab-renderer.js) の琥珀色判定
 * (confidence < 0.8) と必ず一致させること。
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.8;

/**
 * 低信頼の音符 (琥珀色) とそれ以外に仕分ける (純関数)。
 * confidence が数値でない音符は判定できないため残す側に入れる。
 */
export function partitionLowConfidenceNotes(notes, threshold = LOW_CONFIDENCE_THRESHOLD) {
  const kept = [];
  const removed = [];
  for (const n of notes || []) {
    if (n && typeof n.confidence === 'number' && n.confidence < threshold) removed.push(n);
    else kept.push(n);
  }
  return { kept, removed };
}

/**
 * 音符列を8分音符のグリッドに整える (純関数)。
 * - 音符は「発音が含まれる8分スロット」に属し、持続する範囲のスロットを覆う。
 *   スロットごとに1音を置くため、長い音は8分ごとの打ち直しになる
 * - 同じスロットに複数の音符が重なる場合は、スロットとの重なりが最も大きい
 *   音符を採用し、同点なら開始が早い方を採る
 * - 採用されなかった音符 (16分の断片など) は消える
 */
export function snapNotesToEighthGrid(notes, bpm, offset = 0) {
  if (!Array.isArray(notes) || !isFinite(bpm) || bpm <= 0) return [];
  const eighth = 60 / bpm / 2;
  const base = isFinite(offset) ? offset : 0;
  const slots = new Map();
  for (const n of notes) {
    if (!n || !isFinite(n.time)) continue;
    const dur = isFinite(n.duration) && n.duration > 0 ? n.duration : eighth;
    const startIdx = Math.max(0, Math.floor((n.time - base) / eighth + 1e-6));
    let endIdx = Math.round((n.time + dur - base) / eighth);
    if (endIdx <= startIdx) endIdx = startIdx + 1;
    for (let i = startIdx; i < endIdx; i++) {
      const slotStart = base + i * eighth;
      const overlap = Math.min(n.time + dur, slotStart + eighth) - Math.max(n.time, slotStart);
      const cur = slots.get(i);
      if (!cur || overlap > cur.overlap + 1e-9 || (Math.abs(overlap - cur.overlap) <= 1e-9 && n.time < cur.note.time)) {
        slots.set(i, { note: n, overlap });
      }
    }
  }
  return [...slots.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, { note }]) => ({ ...note, time: base + i * eighth, duration: eighth }));
}

export class BassTabApp {
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
    this.lastPair = null;         // 再解析用に保持する最後の { original, stem } ペア (stem は null 可)
    this.isGeneratedTab = false;  // 解析で生成したTABかどうか (自動保存の対象)
    this.domExtra = null;         // 動的追加コントロールへの参照
    this.currentRawNotes = null;  // 再量子化用に保持する検出直後のノート列
    this.estimatedTempo = null;   // 自動推定したテンポ (手動BPMを「推定に戻す」用)

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
      // 試聴: 選択した音符の音程をベース音で鳴らし、採譜ミスに耳で気づけるようにする。
      // 半音修正などの編集後も applyEditResult が再選択するので、変更後の音がそのまま確認できる。
      if (note && typeof note.midi === 'number' && this.synth) {
        const dur = Math.min(0.6, Math.max(0.25, note.duration || 0.4));
        const vel = Math.min(1, Math.max(0.4, note.velocity || 0.85));
        this.synth.playNote(note.midi, dur, vel);
      }
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

    // 7. PWA Service Worker 登録 (新バージョンがあれば通知し、自動で再読み込みして更新)
    registerServiceWorker(() => {
      this.showToast('🚀 新バージョンが利用可能です。更新中...', 4000);
    });
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
          // メトロノームの拍グリッドを現在のテンポに同期してから再生する
          const { bpm, offset } = this.editGridTempo();
          const bpb = this.timeSignature === '6/8' ? 3 : (parseInt(this.timeSignature, 10) || 4);
          this.player.setMetronomeGrid(bpm, offset, bpb);
          this.player.play({ countIn: true });
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
      onFileSelected: (files) => {
        // 1ファイルなら従来どおり単体、2ファイルならペア取り込みとして振り分ける
        const pair = resolvePairFiles(files);
        if (pair) this.processUploadedFile(pair.original, pair.stem);
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
    bar.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px 10px; align-items:center; padding:10px 12px; font-size:13px; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; box-shadow:0 1px 3px rgba(15,23,42,0.06);';
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
      <label>BPM
        <input id="ctlBpm" type="number" min="40" max="280" step="0.1" aria-label="BPMを手動で指定" style="${SEL} width:76px; cursor:text;">
      </label>
      <button id="btnApplyBpm" type="button" aria-label="指定したBPMで再配置" style="${BTN}">BPM適用</button>
      <button id="btnResetBpm" type="button" aria-label="推定したBPMに戻す" style="${BTN}">推定に戻す</button>
      <button id="btnReanalyze" type="button" aria-label="再解析" style="${BTN}">🔁 再解析</button>
      <button id="btnExportTab" type="button" aria-label="TAB書き出し" style="${BTN}">📄 TAB書き出し</button>
      <button id="btnExportMidi" type="button" aria-label="MIDI書き出し" style="${BTN}">🎹 MIDI書き出し</button>
      <button id="btnExportXml" type="button" aria-label="MusicXML書き出し" style="${BTN}">🎼 MusicXML</button>
      <button id="btnPrintTab" type="button" aria-label="TABを印刷またはPDF保存" style="${BTN}">🖨 印刷/PDF</button>
      <button id="btnSaveLibrary" type="button" aria-label="現在のTABをライブラリに保存" style="${BTN}">💾 ライブラリに保存</button>
      <button id="btnOpenLibrary" type="button" aria-label="曲ライブラリを開く" style="${BTN}">📚 ライブラリ</button>
      <button id="btnRecord" type="button" aria-label="マイクで録音して採譜" aria-pressed="false" style="${BTN}">🎤 録音して採譜</button>
      <button id="btnAddStem" type="button" aria-label="ベースステムを追加" style="${BTN} display:none;">🎚 ベースステムを追加</button>
      <button id="btnDeleteLowConf" type="button" aria-label="信頼度が低めの音符をまとめて削除" style="${BTN}">🧹 低信頼を一括削除</button>
      <button id="btnSnapEighth" type="button" aria-label="音符を8ビートのグリッドに整える" style="${BTN}">🎯 8ビートに整える</button>
      <button id="btnAutoScroll" type="button" aria-label="自動スクロールの切り替え" aria-pressed="true" style="${BTN}">⇥ 自動スクロール: ON</button>
      <button id="btnMetronome" type="button" aria-label="メトロノームの切り替え" aria-pressed="false" style="${BTN}">🥁 メトロノーム: OFF</button>
      <button id="btnCountIn" type="button" aria-label="カウントインの切り替え" aria-pressed="false" style="${BTN}">⏱ カウントイン: OFF</button>
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
      <button id="btnNoteLeft" type="button" aria-label="音符を16分1つ前に移動" title="← キー (Shiftで4つ分)" style="${BTN}">◀ 移動</button>
      <button id="btnNoteRight" type="button" aria-label="音符を16分1つ後に移動" title="→ キー (Shiftで4つ分)" style="${BTN}">移動 ▶</button>
      <button id="btnNoteInsert" type="button" aria-label="直後の空き位置に音符を追加" title="Insert キー" style="${BTN}">＋ 追加</button>
      <button id="btnNoteString" type="button" aria-label="同じ音高の別弦割当てへ変更" title="S キー" style="${BTN}">弦変更</button>
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
      metronomeBtn: bar.querySelector('#btnMetronome'),
      countInBtn: bar.querySelector('#btnCountIn'),
      bpmInput: bar.querySelector('#ctlBpm'),
      editBar,
      editNoteInfo: editBar.querySelector('#editNoteInfo')
    };
    bar.querySelector('#btnApplyBpm').addEventListener('click', () => {
      const v = parseFloat(this.domExtra.bpmInput.value);
      this.applyManualBpm(v, false);
    });
    bar.querySelector('#btnResetBpm').addEventListener('click', () => {
      if (this.estimatedTempo) this.applyManualBpm(this.estimatedTempo.bpm, true);
      else this.showToast('推定したBPMがまだありません');
    });
    this.domExtra.bpmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = parseFloat(this.domExtra.bpmInput.value);
        this.applyManualBpm(v, false);
      }
    });
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
      if (this.lastPair) {
        this.processUploadedFile(this.lastPair.original, this.lastPair.stem);
      } else {
        this.showToast('先に音声ファイルを読み込んでください');
      }
    });
    // ペア取り込み: 原曲を読み込んだあとからベースステムを追加/変更するボタン。
    // ファイル入力は index.html を編集しない方針のため、ここで動的に生成する。
    this.domExtra.stemBtn = bar.querySelector('#btnAddStem');
    const stemInput = document.createElement('input');
    stemInput.type = 'file';
    stemInput.id = 'stemFileInput';
    stemInput.accept = 'audio/*,.mp3,.wav,.m4a,.ogg,.flac';
    stemInput.style.display = 'none';
    document.body.appendChild(stemInput);
    this.domExtra.stemInput = stemInput;
    this.domExtra.stemBtn.addEventListener('click', () => {
      if (!this.lastPair || !this.lastPair.original) {
        this.showToast('先に原曲を読み込んでください');
        return;
      }
      stemInput.click();
    });
    stemInput.addEventListener('change', (e) => {
      const stemFile = e.target.files && e.target.files[0];
      // 同じファイルを再選択しても change が発火するようリセットする
      e.target.value = '';
      if (stemFile) this.addStemFile(stemFile);
    });
    bar.querySelector('#btnDeleteLowConf').addEventListener('click', () => this.deleteLowConfidenceNotes());
    bar.querySelector('#btnSnapEighth').addEventListener('click', () => this.snapToEighthGrid());
    bar.querySelector('#btnExportTab').addEventListener('click', () => {
      this.exportTextTab();
    });
    bar.querySelector('#btnExportMidi').addEventListener('click', () => {
      this.exportMidi();
    });
    bar.querySelector('#btnExportXml').addEventListener('click', () => {
      this.exportMusicXml();
    });
    bar.querySelector('#btnPrintTab').addEventListener('click', () => {
      this.printTab();
    });
    bar.querySelector('#btnSaveLibrary').addEventListener('click', () => {
      this.saveToLibrary();
    });
    bar.querySelector('#btnOpenLibrary').addEventListener('click', () => {
      this.openLibrary();
    });
    this.domExtra.recordBtn = bar.querySelector('#btnRecord');
    this.domExtra.recordBtn.addEventListener('click', () => {
      this.toggleRecording();
    });

    // 印刷専用エリア (画面では非表示。@media print でアプリ本体を隠し、これだけ出す)
    if (!document.getElementById('tabPrintArea')) {
      const printArea = document.createElement('div');
      printArea.id = 'tabPrintArea';
      document.body.appendChild(printArea);
      const printStyle = document.createElement('style');
      printStyle.textContent =
        '#tabPrintArea{display:none;}' +
        '@media print{' +
        'body>*:not(#tabPrintArea){display:none!important;}' +
        'body::before,body::after{display:none!important;}' +
        '#tabPrintArea{display:block!important;}' +
        '#tabPrintArea img{width:100%;break-inside:avoid;page-break-inside:avoid;}' +
        '@page{size:A4 landscape;margin:10mm;}' +
        '}';
      document.head.appendChild(printStyle);
    }
    this.domPrintArea = document.getElementById('tabPrintArea');
    this.domExtra.autoScrollBtn.addEventListener('click', () => {
      this.setAutoScrollUI(!this.autoScroll);
    });
    this.domExtra.metronomeBtn.addEventListener('click', () => {
      this.setMetronomeUI(!this.player.metronomeEnabled);
      this.saveSettings();
    });
    this.domExtra.countInBtn.addEventListener('click', () => {
      this.setCountInUI(!this.player.countInEnabled);
      this.saveSettings();
    });
    bar.querySelector('#btnHelp').addEventListener('click', () => {
      this.openHelp();
    });
    editBar.querySelector('#btnNoteUp').addEventListener('click', () => this.shiftSelectedNote(1));
    editBar.querySelector('#btnNoteDown').addEventListener('click', () => this.shiftSelectedNote(-1));
    editBar.querySelector('#btnNoteLeft').addEventListener('click', () => this.moveSelectedNote(-1));
    editBar.querySelector('#btnNoteRight').addEventListener('click', () => this.moveSelectedNote(1));
    editBar.querySelector('#btnNoteInsert').addEventListener('click', () => this.insertNoteAfterSelected());
    editBar.querySelector('#btnNoteString').addEventListener('click', () => this.cycleSelectedNoteString());
    editBar.querySelector('#btnNoteDelete').addEventListener('click', () => this.deleteSelectedNote());
    editBar.querySelector('#btnNoteClose').addEventListener('click', () => this.tabRenderer.setSelectedNote(-1));

    // 音符編集中のキーボードショートカット (入力欄にフォーカスがある時は無効)
    window.addEventListener('keydown', (e) => {
      if (this.selectedNoteIndex < 0) return;
      const tag = e.target && e.target.tagName;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); this.moveSelectedNote(e.shiftKey ? -4 : -1); break;
        case 'ArrowRight': e.preventDefault(); this.moveSelectedNote(e.shiftKey ? 4 : 1); break;
        case 'ArrowUp': e.preventDefault(); this.shiftSelectedNote(1); break;
        case 'ArrowDown': e.preventDefault(); this.shiftSelectedNote(-1); break;
        case 'Delete': case 'Backspace': e.preventDefault(); this.deleteSelectedNote(); break;
        case 'Insert': e.preventDefault(); this.insertNoteAfterSelected(); break;
        case 's': case 'S': this.cycleSelectedNoteString(); break;
      }
    });

    // 再生位置プログレスバー (譜面の直上)
    this.initProgressBar(tabContainer);
  }

  /**
   * TABセクションの見出しを現在の弦数に合わせる (4弦/5弦)
   */
  updateTabTitle() {
    const el = document.getElementById('tabSectionTitle');
    if (el) el.textContent = `📜 ${this.tuning}弦エレキベース TAB譜 (同期スクロール)`;
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
    this.updateTabTitle();
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
   * メトロノームの ON/OFF を切り替える (再生中も即反映される)
   */
  setMetronomeUI(enabled) {
    if (this.player) this.player.setMetronomeEnabled(enabled);
    if (this.domExtra && this.domExtra.metronomeBtn) {
      this.domExtra.metronomeBtn.textContent = enabled ? '🥁 メトロノーム: ON' : '🥁 メトロノーム: OFF';
      this.domExtra.metronomeBtn.setAttribute('aria-pressed', String(!!enabled));
    }
  }

  /**
   * カウントインの ON/OFF を切り替える (再生ボタンで開始したときだけ1小節入る)
   */
  setCountInUI(enabled) {
    if (this.player) this.player.setCountInEnabled(enabled);
    if (this.domExtra && this.domExtra.countInBtn) {
      this.domExtra.countInBtn.textContent = enabled ? '⏱ カウントイン: ON' : '⏱ カウントイン: OFF';
      this.domExtra.countInBtn.setAttribute('aria-pressed', String(!!enabled));
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
      <div>譜面の音符をクリックすると選択でき、編集バーで半音の上げ下げ・16分単位の移動・追加・弦変更・削除ができます。半音を変えると運指 (弦とフレット) は自動で最も近い位置に直ります。キー操作: ←→ 移動 (Shiftで4つ分) / ↑↓ 半音 / Insert 追加 / S 弦変更 / Delete 削除。「🧹 低信頼を一括削除」は琥珀色の音符 (信頼度が低め) をまとめて消します。件数を確認してから削除します。「🎯 8ビートに整える」は音符を8分音符のグリッドに吸着させ、長い音は8分ごとの打ち直しにして、まっすぐな8ビートの譜面に直します。</div>
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
        metronome: this.player ? this.player.metronomeEnabled : false,
        countIn: this.player ? this.player.countInEnabled : false,
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
      this.updateTabTitle();
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
    // メトロノーム / カウントイン (ボタン表示も同期)
    if (s.metronome) this.setMetronomeUI(true);
    if (s.countIn) this.setCountInUI(true);
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
   * 信頼度が低めの音符 (琥珀色) をまとめて削除する。
   * 件数を出して確認してから消す (本当の音が混ざることがあるため)。
   */
  deleteLowConfidenceNotes() {
    if (!this.currentTabNotes || this.currentTabNotes.length === 0) {
      this.showToast('先に音声ファイルを読み込んでください');
      return;
    }
    const { kept, removed } = partitionLowConfidenceNotes(this.currentTabNotes);
    if (removed.length === 0) {
      this.showToast('低信頼の音符はありませんでした');
      return;
    }
    const ok = window.confirm(`信頼度が低めの音符が ${removed.length} 件あります。すべて削除しますか？\n本当の音が混ざっている場合もあります。削除は取り消せません。`);
    if (!ok) return;
    this.currentTabNotes = kept;
    this.selectedNoteIndex = -1;
    if (this.tabRenderer) this.tabRenderer.setSelectedNote(-1);
    this.syncNotesAfterEdit();
    this.updateEditBar();
    this.showToast(`低信頼の音符を ${removed.length} 件削除しました`);
  }

  /**
   * 現在のTABを8ビート (8分音符) のグリッドに整える。
   * 長い音は8分ごとの打ち直しになり、16分位置の音は最寄りの8分に寄る。
   */
  snapToEighthGrid() {
    if (!this.currentTabNotes || this.currentTabNotes.length === 0) {
      this.showToast('先に音声ファイルを読み込んでください');
      return;
    }
    const { bpm, offset } = this.editGridTempo();
    const before = this.currentTabNotes;
    const snapped = snapNotesToEighthGrid(before, bpm, offset);
    const unchanged = snapped.length === before.length && snapped.every((n, i) =>
      Math.abs(n.time - before[i].time) < 0.001 && Math.abs(n.duration - before[i].duration) < 0.001 && n.midi === before[i].midi);
    if (unchanged) {
      this.showToast('すでに8ビートに整っています');
      return;
    }
    const ok = window.confirm(`音符を8ビート (8分音符) のグリッドに整えます。${before.length}音 → ${snapped.length}音になります。\n16分音符や細かいニュアンスは失われます。この操作は取り消せません。`);
    if (!ok) return;
    this.currentTabNotes = snapped;
    this.selectedNoteIndex = -1;
    if (this.tabRenderer) this.tabRenderer.setSelectedNote(-1);
    this.syncNotesAfterEdit();
    this.updateEditBar();
    this.showToast(`8ビートに整えました (${before.length}音 → ${snapped.length}音)`);
  }

  // 編集操作の基準テンポ (グリッド計算用)。未解析時はレンダラーのBPMで代替する
  editGridTempo() {
    if (this.currentTempo && this.currentTempo.bpm) {
      return { bpm: this.currentTempo.bpm, offset: this.currentTempo.offset || 0 };
    }
    return { bpm: (this.tabRenderer && this.tabRenderer.bpm) || 120, offset: 0 };
  }

  // 編集後の選択位置を保ったまま再描画する
  applyEditResult(res) {
    this.currentTabNotes = res.notes;
    this.syncNotesAfterEdit();
    if (this.tabRenderer) {
      this.tabRenderer.setSelectedNote(res.index);
      this.tabRenderer.render();
    }
    this.updateEditBar();
  }

  /**
   * 選択中の音符を16分グリッドで前後に移動する (衝突時は単音化ルールで移動音を優先)
   */
  moveSelectedNote(deltaSlots) {
    const idx = this.selectedNoteIndex;
    if (idx < 0 || idx >= this.currentTabNotes.length) return;
    const { bpm, offset } = this.editGridTempo();
    const res = BassTabApp.moveNoteBySlots(this.currentTabNotes, idx, deltaSlots, bpm, offset);
    if (!res) {
      this.showToast('それ以上は移動できません');
      return;
    }
    this.applyEditResult(res);
  }

  /**
   * 選択中の音符の直後の空きスロットに同じ音を追加する
   */
  insertNoteAfterSelected() {
    const idx = this.selectedNoteIndex;
    if (idx < 0 || idx >= this.currentTabNotes.length) return;
    const { bpm, offset } = this.editGridTempo();
    const res = BassTabApp.insertNoteAfter(this.currentTabNotes, idx, bpm, offset);
    if (!res) {
      this.showToast('追加できる空き位置がありません');
      return;
    }
    this.applyEditResult(res);
    this.showToast('音符を追加しました');
  }

  /**
   * 選択中の音符を、同じ音高の別弦割当てへ切り替える
   */
  cycleSelectedNoteString() {
    const note = this.selectedNoteIndex >= 0 ? this.currentTabNotes[this.selectedNoteIndex] : null;
    if (!note) return;
    if (!BassTabApp.cycleStringAssignment(note, this.mapper)) {
      this.showToast('この音は他の弦では弾けません');
      return;
    }
    this.syncNotesAfterEdit();
    if (this.tabRenderer) this.tabRenderer.render();
    this.updateEditBar();
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
   * 現在のTABを Standard MIDI File (format 0) として書き出す。
   * DAW やスコアソフトにそのまま渡せる。テンポは現在のBPMで埋め込む。
   */
  exportMidi() {
    if (!this.currentTabNotes || this.currentTabNotes.length === 0) {
      this.showToast('書き出すTABがありません');
      return;
    }
    const bpm = (this.currentTempo && this.currentTempo.bpm) || 120;
    const bytes = BassTabApp.buildMidiBytes(this.currentTabNotes, bpm, this.currentTrackTitle || 'BassTab');
    const blob = new Blob([bytes], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (this.currentTrackTitle || 'basstab').replace(/[^\w\- ]+/g, '').trim() || 'basstab';
    a.href = url;
    a.download = `${safeName}.mid`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast('🎹 MIDIファイルをダウンロードしました');
  }

  /**
   * 現在のTABを MusicXML (.musicxml) として書き出す。
   * MuseScore等のスコアソフトで開ける (音高・タイミング・弦/フレット付き)。
   */
  exportMusicXml() {
    if (!this.currentTabNotes || this.currentTabNotes.length === 0) {
      this.showToast('書き出すTABがありません');
      return;
    }
    const { bpm, offset } = this.editGridTempo();
    const xml = BassTabApp.buildMusicXml(
      this.currentTabNotes, bpm, offset,
      this.currentTrackTitle || 'BassTab', this.timeSignature || '4/4');
    const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (this.currentTrackTitle || 'basstab').replace(/[^\w\- ]+/g, '').trim() || 'basstab';
    a.href = url;
    a.download = `${safeName}.musicxml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast('🎼 MusicXMLをダウンロードしました');
  }

  /**
   * 印刷用に、全曲を4小節ごとの段 (システム) に分け、段ごとの画像を生成する。
   * 紙で読めるよう印刷用パレット (白地・濃色) で描き、段単位で画像を分けることで
   * ブラウザの改ページが段の途中で譜面を割らないようにする。
   * レンダラーの canvas/ctx を一時的に差し替え、終了後に必ず元の表示状態へ戻す。
   * @returns {string[]|null} 段ごとの PNG data URL の配列
   */
  buildPrintImages() {
    const r = this.tabRenderer;
    if (!r || !r.canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    const bpm = r.bpm || 120;
    const beatsPerBar = typeof r.getBarBeatCount === 'function' ? r.getBarBeatCount() : 4;
    const barInterval = (60 / bpm) * beatsPerBar;
    const systemDur = barInterval * 4; // 1段 = 4小節
    const firstStart = r.beatOffset - Math.ceil(r.beatOffset / barInterval) * barInterval;
    const systems = Math.min(120, Math.max(1, Math.ceil((r.duration - firstStart) / systemDur)));
    const stripCssW = Math.ceil(systemDur * r.pixelsPerSecond) + r.leftPadding + 8;
    const stripCssH = r.totalHeight;

    const strip = document.createElement('canvas');
    const saved = {
      canvas: r.canvas, ctx: r.ctx, scrollX: r.scrollX,
      currentTime: r.currentTime, selected: r.selectedNoteIndex, loop: r.loopEnabled,
      forPrint: r.forPrint
    };
    const urls = [];
    try {
      r.canvas = strip;
      r.ctx = strip.getContext('2d');
      r.forPrint = true; // 印刷用パレット (白地・濃色) で描く
      r.selectedNoteIndex = -1;
      r.currentTime = -1; // 再生カーソルを印刷に出さない
      r.loopEnabled = false;
      for (let s = 0; s < systems; s++) {
        strip.width = Math.round(stripCssW * dpr); // サイズ設定で ctx 状態はリセットされる
        strip.height = Math.round(stripCssH * dpr);
        r.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        r.scrollX = (firstStart + s * systemDur) * r.pixelsPerSecond;

        const out = document.createElement('canvas');
        out.width = Math.round(stripCssW * dpr);
        out.height = Math.round(stripCssH * dpr);
        const octx = out.getContext('2d');
        octx.fillStyle = '#ffffff'; // 紙の白地
        octx.fillRect(0, 0, out.width, out.height);

        r.render();
        octx.drawImage(strip, 0, 0);
        urls.push(out.toDataURL('image/png'));
      }
    } finally {
      r.canvas = saved.canvas;
      r.ctx = saved.ctx;
      r.scrollX = saved.scrollX;
      r.currentTime = saved.currentTime;
      r.selectedNoteIndex = saved.selected;
      r.loopEnabled = saved.loop;
      r.forPrint = saved.forPrint;
      r.resizeCanvas();
      r.render();
    }
    return urls;
  }

  /**
   * TABを印刷する (ブラウザの印刷ダイアログからPDF保存も可能)。
   * 印刷時のみ表示される #tabPrintArea に画像を差し込んでから print() を呼ぶ。
   */
  printTab() {
    if (!this.tabRenderer || !this.currentTabNotes || this.currentTabNotes.length === 0) {
      this.showToast('印刷するTABがありません');
      return;
    }
    let dataUrls = null;
    try {
      dataUrls = this.buildPrintImages();
    } catch (err) {
      console.error('print image failed:', err);
    }
    const area = this.domPrintArea || document.getElementById('tabPrintArea');
    if (!dataUrls || dataUrls.length === 0 || !area) {
      this.showToast('印刷用画像の生成に失敗しました');
      return;
    }
    const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const { bpm } = this.editGridTempo();
    const dateStr = new Date().toLocaleDateString('ja-JP');
    area.innerHTML =
      `<h1 style="font:700 18px sans-serif;margin:0 0 4px;">${escHtml(this.currentTrackTitle || 'BassTab')}</h1>` +
      `<p style="font:12px sans-serif;margin:0 0 10px;">BPM ${Math.round(bpm)} / ${escHtml(this.timeSignature || '4/4')} / ` +
      `${this.tuning === '5' ? '5弦' : '4弦'}ベース / ${this.currentTabNotes.length}音 / ${dateStr} (BassTab AI)</p>` +
      dataUrls.map((u) =>
        `<img src="${u}" alt="TAB譜" style="width:100%;display:block;break-inside:avoid;page-break-inside:avoid;margin:0 0 6px;">`
      ).join('');
    const imgs = area.querySelectorAll('img');
    let printed = false;
    const doPrint = () => { if (!printed) { printed = true; window.print(); } };
    const lastImg = imgs.length > 0 ? imgs[imgs.length - 1] : null;
    if (lastImg && lastImg.complete) setTimeout(doPrint, 50);
    else if (lastImg) { lastImg.onload = doPrint; setTimeout(doPrint, 1500); }
    else doPrint();
  }

  // ---- TAB編集の純粋ロジック (UIなしで単体検証できるよう静的メソッドにする) ----

  static slotStepSec(bpm) { return (60 / bpm) / 4; }

  static slotIndexOf(time, bpm, offset) {
    return Math.round((time - offset) / BassTabApp.slotStepSec(bpm));
  }

  // 時間順に整え、隣の音と重ならないよう duration を丸める (量子化時と同じ規則)
  static normalizeEditedNotes(notes) {
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      if (next && cur.time + cur.duration > next.time) {
        cur.duration = Math.max(0.06, next.time - cur.time);
      }
      if (!(cur.duration > 0)) cur.duration = 0.06;
    }
    return sorted;
  }

  /**
   * ノートを16分グリッドで前後に移動する。
   * 移動先スロットに別の音がある場合は単音化ルール (1スロット1音) で移動音を優先する。
   * @returns {{notes: Array, index: number}|null} 移動後の列と移動音の新しいインデックス
   */
  static moveNoteBySlots(notes, index, deltaSlots, bpm, offset) {
    if (!notes || index < 0 || index >= notes.length || !bpm || !deltaSlots) return null;
    const target = notes[index];
    const fromSlot = BassTabApp.slotIndexOf(target.time, bpm, offset);
    const toSlot = Math.max(0, fromSlot + deltaSlots);
    if (toSlot === fromSlot) return null;
    const kept = notes.filter((n, i) =>
      i !== index && BassTabApp.slotIndexOf(n.time, bpm, offset) !== toSlot);
    target.time = offset + toSlot * BassTabApp.slotStepSec(bpm);
    const out = BassTabApp.normalizeEditedNotes([...kept, target]);
    return { notes: out, index: out.indexOf(target) };
  }

  /**
   * 選択ノートの直後で空いている最初のスロットに、同じ音のコピーを追加する。
   * @returns {{notes: Array, index: number}|null}
   */
  static insertNoteAfter(notes, index, bpm, offset) {
    if (!notes || index < 0 || index >= notes.length || !bpm) return null;
    const step = BassTabApp.slotStepSec(bpm);
    const ref = notes[index];
    const occupied = new Set(notes.map(n => BassTabApp.slotIndexOf(n.time, bpm, offset)));
    let slot = BassTabApp.slotIndexOf(ref.time, bpm, offset) + 1;
    let guard = 0;
    while (occupied.has(slot) && guard < 64) { slot++; guard++; }
    if (occupied.has(slot)) return null;
    const note = { ...ref, time: offset + slot * step, duration: step };
    const out = BassTabApp.normalizeEditedNotes([...notes, note]);
    return { notes: out, index: out.indexOf(note) };
  }

  /**
   * 同じ音高を別弦で鳴らす割当てへ循環的に変更する (運指マッパーの候補を使う)。
   * 候補が2つ未満なら null。
   */
  static cycleStringAssignment(note, mapper) {
    if (!note || !mapper) return null;
    const cands = mapper.getCandidates(note.midi);
    if (cands.length < 2) return null;
    const cur = cands.findIndex(c => c.string === note.string && c.fret === note.fret);
    const next = cands[(cur + 1) % cands.length];
    note.string = next.string;
    note.fret = next.fret;
    return note;
  }

  // ---- MusicXML 生成 (純粋ロジック) ----

  /**
   * currentTabNotes から MusicXML (score-partwise 4.0) を生成する。
   * 16分グリッド (divisions=4) で音高・タイミング・弦/フレット (technical) を表現する。
   * 小節をまたぐ音はタイで分割する。各小節の合計 duration は必ず小節長と一致する。
   */
  static buildMusicXml(notes, bpm, offset, title, timeSignature) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tsMap = {
      '4/4': { beats: 4, type: 4, slots: 16 },
      '3/4': { beats: 3, type: 4, slots: 12 },
      '6/8': { beats: 6, type: 8, slots: 12 }
    };
    const ts = tsMap[timeSignature] || tsMap['4/4'];
    const stepNames = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
      ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
    const typeMap = { 1: ['16th', 0], 2: ['eighth', 0], 3: ['eighth', 1], 4: ['quarter', 0],
      6: ['quarter', 1], 8: ['half', 0], 12: ['half', 1], 16: ['whole', 0] };
    const typeOf = (slots) => {
      if (typeMap[slots]) return typeMap[slots];
      for (const s of [16, 12, 8, 6, 4, 3, 2, 1]) if (s < slots) return typeMap[s];
      return typeMap[1];
    };

    const sorted = [...(notes || [])]
      .filter(n => typeof n.midi === 'number')
      .sort((a, b) => a.time - b.time);

    // スロット単位のイベント列 (重なりは次の音の開始で丸める)
    const events = [];
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      const start = Math.max(0, BassTabApp.slotIndexOf(n.time, bpm, offset));
      let dur = Math.max(1, Math.round((n.duration || 0) / BassTabApp.slotStepSec(bpm)));
      const next = sorted[i + 1];
      if (next) {
        const nextStart = Math.max(0, BassTabApp.slotIndexOf(next.time, bpm, offset));
        if (start + dur > nextStart) dur = Math.max(1, nextStart - start);
      }
      events.push({ start, dur, note: n });
    }

    // 小節をまたぐ音をタイ付きセグメントに分割する
    const segments = [];
    for (const ev of events) {
      let s = ev.start, remaining = ev.dur, first = true;
      while (remaining > 0) {
        const barEnd = (Math.floor(s / ts.slots) + 1) * ts.slots;
        const segDur = Math.min(remaining, barEnd - s);
        segments.push({
          start: s, dur: segDur, note: ev.note,
          tieStop: !first, tieStart: remaining - segDur > 0
        });
        s += segDur; remaining -= segDur; first = false;
      }
    }
    segments.sort((a, b) => a.start - b.start);

    const lastEnd = events.reduce((m, e) => Math.max(m, e.start + e.dur), 0);
    const numBars = Math.max(1, Math.ceil(lastEnd / ts.slots));

    const restXml = (dur) => {
      const [type, dots] = typeOf(dur);
      return `<note><rest/><duration>${dur}</duration><voice>1</voice><type>${type}</type>${dots ? '<dot/>' : ''}</note>`;
    };
    const noteXml = (seg, withTechnical) => {
      const n = seg.note;
      const pc = ((n.midi % 12) + 12) % 12;
      const [step, sharp] = stepNames[pc];
      const octave = Math.floor(n.midi / 12) - 1;
      const [type, dots] = typeOf(seg.dur);
      let xml = '<note>';
      xml += `<pitch><step>${step}</step>${sharp ? '<alter>1</alter>' : ''}<octave>${octave}</octave></pitch>`;
      xml += `<duration>${seg.dur}</duration>`;
      if (seg.tieStop) xml += '<tie type="stop"/>';
      if (seg.tieStart) xml += '<tie type="start"/>';
      xml += `<voice>1</voice><type>${type}</type>${dots ? '<dot/>' : ''}`;
      const notations = [];
      if (seg.tieStop) notations.push('<tied type="stop"/>');
      if (seg.tieStart) notations.push('<tied type="start"/>');
      let notationXml = '';
      if (notations.length) notationXml += notations.join('');
      if (withTechnical && typeof n.string === 'number' && typeof n.fret === 'number') {
        notationXml += `<technical><string>${n.string}</string><fret>${n.fret}</fret></technical>`;
      }
      if (notationXml) xml += `<notations>${notationXml}</notations>`;
      xml += '</note>';
      return xml;
    };

    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
    lines.push('<score-partwise version="4.0">');
    lines.push(`<work><work-title>${esc(title || 'BassTab')}</work-title></work>`);
    lines.push('<part-list><score-part id="P1"><part-name>Electric Bass</part-name></score-part></part-list>');
    lines.push('<part id="P1">');
    for (let bar = 0; bar < numBars; bar++) {
      const barStart = bar * ts.slots;
      const barEnd = barStart + ts.slots;
      lines.push(`<measure number="${bar + 1}">`);
      if (bar === 0) {
        lines.push(`<attributes><divisions>4</divisions><key><fifths>0</fifths></key>` +
          `<time><beats>${ts.beats}</beats><beat-type>${ts.type}</beat-type></time>` +
          `<clef><sign>F</sign><line>4</line></clef></attributes>`);
        lines.push(`<sound tempo="${Math.round(bpm)}"/>`);
      }
      let cursor = barStart;
      for (const seg of segments) {
        if (seg.start < barStart || seg.start >= barEnd) continue;
        if (seg.start > cursor) lines.push(restXml(seg.start - cursor));
        lines.push(noteXml(seg, !seg.tieStop));
        cursor = seg.start + seg.dur;
      }
      if (cursor < barEnd) lines.push(restXml(barEnd - cursor));
      lines.push('</measure>');
    }
    lines.push('</part>');
    lines.push('</score-partwise>');
    return lines.join('\n') + '\n';
  }

  static buildMidiBytes(notes, bpm, title) {
    const PPQ = 480;
    const secPerTick = (60 / bpm) / PPQ;
    const vlq = (v) => {
      const buf = [v & 0x7f];
      v >>= 7;
      while (v > 0) { buf.unshift((v & 0x7f) | 0x80); v >>= 7; }
      return buf;
    };
    const events = []; // { tick, prio, bytes }
    const mpq = Math.round(60000000 / bpm);
    events.push({ tick: 0, prio: 0, bytes: [0xff, 0x51, 0x03, (mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff] });
    const nameBytes = Array.from(new TextEncoder().encode(String(title).slice(0, 60)));
    events.push({ tick: 0, prio: 0, bytes: [0xff, 0x03, nameBytes.length, ...nameBytes] });
    for (const n of notes) {
      if (typeof n.midi !== 'number') continue;
      const on = Math.max(0, Math.round(n.time / secPerTick));
      const off = Math.max(on + 1, Math.round((n.time + Math.max(n.duration || 0.1, 0.03)) / secPerTick));
      const vel = Math.min(127, Math.max(1, Math.round((n.velocity || 0.8) * 127)));
      events.push({ tick: on, prio: 2, bytes: [0x90, n.midi & 0x7f, vel] });
      events.push({ tick: off, prio: 1, bytes: [0x80, n.midi & 0x7f, 0] });
    }
    events.sort((a, b) => a.tick - b.tick || a.prio - b.prio);
    const track = [];
    let last = 0;
    for (const e of events) {
      track.push(...vlq(e.tick - last), ...e.bytes);
      last = e.tick;
    }
    track.push(0x00, 0xff, 0x2f, 0x00);
    const header = [
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, // MThd
      0, 0, 0, 1, // format 0, 1 track
      (PPQ >> 8) & 0xff, PPQ & 0xff
    ];
    const trackHeader = [
      0x4d, 0x54, 0x72, 0x6b,
      (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff
    ];
    return new Uint8Array([...header, ...trackHeader, ...track]);
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
    this.currentRawNotes = null;
    this.estimatedTempo = payload.tempo || null;
    if (this.domExtra && this.domExtra.bpmInput && payload.tempo) this.domExtra.bpmInput.value = payload.tempo.bpm;
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

  /**
   * 現在のTABを曲ライブラリに保存する (同タイトルは差し替え)
   */
  saveToLibrary() {
    if (!this.isGeneratedTab || !Array.isArray(this.currentTabNotes) || this.currentTabNotes.length === 0) {
      this.showToast('先に音声ファイルを解析してください');
      return;
    }
    const entry = {
      id: Date.now(),
      version: 1,
      title: this.currentTrackTitle || '無題',
      tempo: this.currentTempo,
      timeSignature: this.timeSignature,
      tuning: this.tuning,
      sensitivity: this.sensitivity,
      notes: this.currentTabNotes,
      savedAt: Date.now()
    };
    const result = upsertLibraryEntry(localStorage, entry);
    if (!result) {
      this.showToast('保存できませんでした（ブラウザの保存容量が不足しています）', 4000);
      return;
    }
    this.showToast(result.updated
      ? `💾 ライブラリの「${entry.title}」を更新しました`
      : `💾 ライブラリに「${entry.title}」を保存しました`);
  }

  /**
   * 曲ライブラリのモーダルを開く (一覧・読み込み・削除)
   */
  openLibrary() {
    this.closeLibrary();
    const overlay = document.createElement('div');
    overlay.id = 'libraryOverlay';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:1200; background:rgba(2,20,35,0.55); display:flex; align-items:center; justify-content:center; padding:16px;';
    const card = document.createElement('div');
    card.style.cssText = 'background:#0d1526; color:#e2e8f0; border:1px solid rgba(56,189,248,0.4); border-radius:14px; max-width:520px; width:100%; max-height:80vh; overflow:auto; padding:18px;';
    const renderList = () => {
      const entries = loadLibraryEntries(localStorage);
      card.innerHTML = '';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;';
      head.innerHTML = '<strong style="font-size:16px;">📚 曲ライブラリ</strong>';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '✕ 閉じる';
      closeBtn.style.cssText = 'padding:6px 12px; border-radius:999px; border:1px solid rgba(255,255,255,0.3); background:rgba(255,255,255,0.06); color:#e2e8f0; cursor:pointer;';
      closeBtn.addEventListener('click', () => this.closeLibrary());
      head.appendChild(closeBtn);
      card.appendChild(head);
      if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'font-size:13px; color:#94a3b8; line-height:1.7;';
        empty.textContent = '保存された曲はまだありません。曲を解析したら「💾 ライブラリに保存」で残しておけます（原曲音声は保存されないため、読み込み後はシンセ再生のみになります）。';
        card.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:8px; align-items:center; padding:9px 4px; border-top:1px solid rgba(148,163,184,0.18);';
        const info = document.createElement('div');
        info.style.cssText = 'flex:1; min-width:0;';
        const d = new Date(entry.savedAt || 0);
        const dateStr = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
        const bpm = entry.tempo && entry.tempo.bpm ? Math.round(entry.tempo.bpm) : '-';
        info.innerHTML = `<div style="font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></div><div style="font-size:12px; color:#94a3b8;">${dateStr} • ${entry.notes.length}音符 • ${bpm} BPM</div>`;
        info.firstChild.textContent = entry.title || '無題';
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.textContent = '開く';
        openBtn.style.cssText = 'padding:6px 14px; border-radius:999px; border:1px solid rgba(56,189,248,0.7); background:rgba(56,189,248,0.15); color:#7dd3fc; cursor:pointer;';
        openBtn.addEventListener('click', () => { this.loadLibraryEntry(entry.id); this.closeLibrary(); });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = '削除';
        delBtn.style.cssText = 'padding:6px 12px; border-radius:999px; border:1px solid rgba(255,255,255,0.25); background:transparent; color:#94a3b8; cursor:pointer;';
        delBtn.addEventListener('click', () => {
          if (removeLibraryEntry(localStorage, entry.id)) {
            this.showToast(`ライブラリから「${entry.title || '無題'}」を削除しました`);
            renderList();
          }
        });
        row.appendChild(info);
        row.appendChild(openBtn);
        row.appendChild(delBtn);
        card.appendChild(row);
      }
    };
    renderList();
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeLibrary(); });
    document.body.appendChild(overlay);
    this.domLibrary = overlay;
  }

  closeLibrary() {
    if (this.domLibrary) { this.domLibrary.remove(); this.domLibrary = null; }
  }

  /**
   * ライブラリの曲を読み込む (復元と同じ手順。原曲音源はないためシンセ再生のみ)
   */
  loadLibraryEntry(id) {
    const entry = loadLibraryEntries(localStorage).find(e => e.id === id);
    if (!entry) { this.showToast('その曲はライブラリに見つかりませんでした'); return; }
    this.player.stop();
    this.hideTabNotice();
    this.currentTrackTitle = entry.title || 'ライブラリの曲';
    this.currentAudioBuffer = null;
    this.lastPair = null;
    this.updateStemButton();
    this.currentTabNotes = entry.notes;
    this.currentTempo = entry.tempo || null;
    this.currentRawNotes = null;
    this.estimatedTempo = entry.tempo || null;
    if (this.domExtra && this.domExtra.bpmInput && entry.tempo) this.domExtra.bpmInput.value = entry.tempo.bpm;
    this.isGeneratedTab = true;
    if (entry.tuning) {
      this.tuning = entry.tuning === '5' ? '5' : '4';
      this.mapper.setTuning(this.tuning);
      if (this.tabRenderer) this.tabRenderer.setTuning(this.tuning);
      if (this.fretboard) this.fretboard.setTuning(this.tuning);
      if (this.domExtra && this.domExtra.tuningSelect) this.domExtra.tuningSelect.value = this.tuning;
    }
    if (entry.sensitivity) {
      this.sensitivity = entry.sensitivity;
      if (this.domExtra && this.domExtra.sensSelect) this.domExtra.sensSelect.value = entry.sensitivity;
    }
    const lastNote = entry.notes[entry.notes.length - 1];
    const duration = lastNote ? lastNote.time + lastNote.duration + 1.5 : 10;
    this.player.loadTrack(null, this.currentTabNotes);
    const bpm = (this.currentTempo && this.currentTempo.bpm) || 120;
    const beatOffset = (this.currentTempo && this.currentTempo.offset) || 0;
    this.tabRenderer.setTabNotes(this.currentTabNotes, duration, bpm, beatOffset);
    this.setTimeSignatureUI(entry.timeSignature || '4/4');
    this.updateTrackInfo(this.currentTrackTitle,
      `ライブラリから読み込み • ${entry.notes.length}音符 • 推定 ${Math.round(bpm)} BPM (原曲音源なし・シンセ再生のみ)`);
    this.controls.updateTimeDisplay(0, duration);
    this.saveGeneratedTab();
    this.showToast(`📚 「${this.currentTrackTitle}」を読み込みました`);
  }

  /**
   * マイク録音の開始/停止トグル。停止したら録音をそのまま解析フローへ渡す。
   * 録音上限 (RECORD_MAX_SEC) に達したら自動で停止して採譜する。
   */
  async toggleRecording() {
    if (!this.micRecorder) this.micRecorder = new MicRecorder();
    const rec = this.micRecorder;
    if (rec.recording) { await this.finishRecording(); return; }
    if (!MicRecorder.isSupported()) {
      this.showToast('このブラウザはマイク録音に対応していません', 4000);
      return;
    }
    try {
      await rec.start(this.analyzer.getAudioContext());
    } catch (e) {
      console.warn('マイク録音を開始できませんでした:', e);
      this.showToast('マイクを使えませんでした。ブラウザのマイク許可を確認してください', 4500);
      return;
    }
    this.player.stop();
    const btn = this.domExtra && this.domExtra.recordBtn;
    if (btn) { btn.textContent = '⏹ 録音を止めて採譜 (0:00)'; btn.setAttribute('aria-pressed', 'true'); }
    this.showToast('🔴 録音中… 演奏してください（もう一度押すと止めて採譜します）', 4000);
    this.recordTimer = setInterval(() => {
      const sec = Math.floor(rec.elapsedSec());
      if (btn) btn.textContent = `⏹ 録音を止めて採譜 (${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')})`;
      if (sec >= RECORD_MAX_SEC) this.finishRecording();
    }, 500);
  }

  async finishRecording() {
    const rec = this.micRecorder;
    if (!rec) return;
    if (this.recordTimer) { clearInterval(this.recordTimer); this.recordTimer = null; }
    const btn = this.domExtra && this.domExtra.recordBtn;
    if (btn) { btn.textContent = '🎤 録音して採譜'; btn.setAttribute('aria-pressed', 'false'); }
    const file = await rec.stop();
    if (!file || file.size === 0) {
      this.showToast('録音データが空でした');
      return;
    }
    this.processUploadedFile(file);
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
    this.currentRawNotes = null;
    this.estimatedTempo = null;
    if (this.domExtra && this.domExtra.bpmInput) this.domExtra.bpmInput.value = preset.bpm;
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

  /**
   * ペア表示用の注記。ステムがペアになっている間だけ返す。
   */
  pairMetaNote() {
    return (this.lastPair && this.lastPair.stem) ? ' • ペア：ステム使用中' : '';
  }

  /**
   * 「ベースステムを追加」ボタンの表示/ラベルを現在のペア状態に合わせる。
   * 原曲が読み込まれている間だけ出し、ステム設定済みなら「変更」に切り替える。
   */
  updateStemButton() {
    const btn = this.domExtra && this.domExtra.stemBtn;
    if (!btn) return;
    const hasOriginal = !!(this.lastPair && this.lastPair.original);
    btn.style.display = hasOriginal ? '' : 'none';
    btn.textContent = (this.lastPair && this.lastPair.stem)
      ? '🎚 ステムを変更'
      : '🎚 ベースステムを追加';
  }

  /**
   * 読み込み済みの原曲にベースステムを後付けし、ペアとして再解析する。
   */
  addStemFile(stemFile) {
    if (!stemFile) return;
    if (!this.lastPair || !this.lastPair.original) {
      this.showToast('先に原曲を読み込んでください');
      return;
    }
    return this.processUploadedFile(this.lastPair.original, stemFile);
  }

  /**
   * 音声ファイルを取り込んで解析する。stemFile があればペア取り込み:
   * 再生・長さ表示は原曲、音符検出はステム側で行う。
   */
  async processUploadedFile(file, stemFile = null) {
    if (!file) return;
    this.player.stop();
    this.hideTabNotice();
    this.lastPair = { original: file, stem: stemFile || null }; // 感度・チューニング変更後の再解析用
    this.updateStemButton();

    const fileName = file.name.replace(/\.[^/.]+$/, "");
    this.currentTrackTitle = fileName;
    // 解析キャンセル用トークン (進捗画面のボタンで cancelled を立てる)
    const cancelToken = { cancelled: false };
    const throwIfCancelled = () => {
      if (cancelToken.cancelled) {
        const e = new Error('解析がキャンセルされました');
        e.code = 'ANALYSIS_CANCELLED';
        throw e;
      }
    };
    this.controls.showProgress(0.05, 'オーディオファイルをデコード中...', () => { cancelToken.cancelled = true; });

    try {
      // 1. デコード (再生・表示用は原曲。解析用はステムがあればステム)
      const audioBuffer = await this.analyzer.decodeAudio(file);
      this.currentAudioBuffer = audioBuffer;
      throwIfCancelled();

      let analysisBuffer = audioBuffer;
      if (stemFile) {
        this.controls.showProgress(0.15, 'ベースステムをデコード中...');
        analysisBuffer = await this.analyzer.decodeAudio(stemFile);
        throwIfCancelled();
        // 長さのずれが大きいペアは別曲の可能性もあるため警告だけ出して続行する
        if (shouldWarnPairMismatch(audioBuffer.duration, analysisBuffer.duration)) {
          this.showToast(`⚠️ 原曲とステムの長さが約${pairDurationDiffSec(audioBuffer.duration, analysisBuffer.duration).toFixed(1)}秒ずれています。このまま解析します`, 5000);
        }
      }

      // 2. ベース帯域抽出 (解析用バッファから。単体時もステム時も同じ経路を通す)
      this.controls.showProgress(0.25, 'ベース周波数帯域を抽出中...');
      const bassBuffer = await this.analyzer.filterBassBand(analysisBuffer);
      throwIfCancelled();

      // 3. ピッチ＆ノート検出 (感度・チューニング設定を反映)
      const rawNotes = await this.analyzer.analyzeBassline(bassBuffer, (pct) => {
        this.controls.showProgress(0.3 + pct * 0.5, 'ベース音程とリズムを採譜中...');
      }, { sensitivity: this.sensitivity, tuning: this.tuning, cancelToken });

      // 4. テンポ推定とリズム量子化 (拍グリッドへ吸着させ、小節線とリズムを一致させる)
      const tempo = this.analyzer.estimateTempo(rawNotes);
      const quantizedNotes = this.analyzer.quantizeNotes(rawNotes, tempo.bpm, tempo.offset);
      this.currentTempo = tempo;
      this.currentRawNotes = rawNotes;
      this.estimatedTempo = tempo;
      if (this.domExtra && this.domExtra.bpmInput) this.domExtra.bpmInput.value = tempo.bpm;

      // 5. 最適運指決定 (4弦TAB譜化)
      this.controls.showProgress(0.88, '最適なベース運指ポジションを計算中...');
      const tabNotes = this.mapper.mapNotesToTab(quantizedNotes);
      this.currentTabNotes = tabNotes;

      // 検出 0 件は成功扱いにせず、理由候補と対処法を譜面エリアに残し続ける
      if (tabNotes.length === 0) {
        this.isGeneratedTab = false;
        this.player.loadTrack(audioBuffer, []);
        this.tabRenderer.setTabNotes([], audioBuffer.duration, tempo.bpm, tempo.offset);
        this.updateTrackInfo(fileName, `AI自動採譜 • 検出 0 件${this.pairMetaNote()}`);
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
                if (this.lastPair) this.processUploadedFile(this.lastPair.original, this.lastPair.stem);
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

      this.updateTrackInfo(fileName, `AI自動採譜 • ${tabNotes.length}音符検出 • 推定 ${Math.round(tempo.bpm)} BPM • 長さ ${this.controls.formatTime(audioBuffer.duration)}${this.pairMetaNote()}`);
      this.controls.updateTimeDisplay(0, audioBuffer.duration);

      this.controls.hideProgress();
      this.showToast(`🎉 「${fileName}」のベースTAB譜を生成しました！`);
      this.flashTabReady();

    } catch (err) {
      // ユーザーがキャンセルした場合は失敗扱いにせず、静かに戻る
      if (err && err.code === 'ANALYSIS_CANCELLED') {
        this.controls.hideProgress();
        this.showToast('解析をキャンセルしました');
        return;
      }
      console.error('Audio processing error:', err);
      this.controls.hideProgress();
      this.showMessage('音声の解析に失敗しました', [
        `エラー内容: ${err.message || '不明なエラー'}`,
        '対応形式は MP3 / WAV などの一般的な音声ファイルです。ファイルが破損していないか、別のファイルでもお試しください。'
      ]);
    }
  }

  /**
   * BPMの手動上書き: 推定が外れたときに、検出済みノートを保ったまま
   * 指定BPMで再量子化して譜面を作り直す (再解析は不要)
   */
  applyManualBpm(bpm, isReset) {
    if (!this.currentRawNotes || this.currentRawNotes.length === 0) {
      this.showToast('先に音声ファイルを解析してください（保存済みTABの復元時は再配置できません）');
      return;
    }
    if (!isFinite(bpm) || bpm < 40 || bpm > 280) {
      this.showToast('BPMは 40〜280 の範囲で指定してください');
      return;
    }
    const offset = (this.currentTempo && this.currentTempo.offset) || 0;
    const quantizedNotes = this.analyzer.quantizeNotes(this.currentRawNotes, bpm, offset);
    const tabNotes = this.mapper.mapNotesToTab(quantizedNotes);
    this.currentTabNotes = tabNotes;
    this.currentTempo = { bpm, offset };
    if (this.domExtra && this.domExtra.bpmInput) this.domExtra.bpmInput.value = bpm;
    const duration = this.currentAudioBuffer ? this.currentAudioBuffer.duration : 0;
    if (this.currentAudioBuffer) this.player.loadTrack(this.currentAudioBuffer, tabNotes);
    this.tabRenderer.setTabNotes(tabNotes, duration, bpm, offset);
    if (this.isGeneratedTab) this.saveGeneratedTab();
    this.updateTrackInfo(this.currentTrackTitle,
      `AI自動採譜 • ${tabNotes.length}音符検出 • BPM ${Math.round(bpm * 10) / 10}${isReset ? ' (推定)' : ' (手動)'} • 長さ ${this.controls.formatTime(duration)}${this.pairMetaNote()}`);
    this.showToast(isReset ? `推定BPM ${Math.round(bpm * 10) / 10} に戻しました` : `BPMを ${Math.round(bpm * 10) / 10} に変更しました`);
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

  // TAB譜生成完了時のフィードバック (U6): TABビューを一度だけ光らせて
  // 生成が終わったことを目で伝える。CSS側の .tab-view-container.tab-ready
  // (MOTION-PATCH.md) がアニメーションを担い、ここではクラスの付け外しだけ行う。
  flashTabReady() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('tabViewContainer');
    if (!el || !el.classList) return;
    el.classList.add('tab-ready');
    if (this._tabReadyTimer) clearTimeout(this._tabReadyTimer);
    // CSSのアニメーションは 1.4s × 2回 = 2.8s で終わるので、合わせて外す
    this._tabReadyTimer = setTimeout(() => el.classList.remove('tab-ready'), 2800);
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

