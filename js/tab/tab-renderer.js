/**
 * BassTab AI - Interactive TAB Notation Canvas Renderer
 *
 * エレキベースの本格TAB譜（小節線・拍・フレット番号・音価・カーソル）を
 * 60fpsで滑らかに同期スクロールレンダリングする。
 * 弦数はチューニングに連動する (4弦 / 5弦時はB弦行を追加)。
 */

export class TabRenderer {
  constructor(canvasElement, containerElement) {
    this.canvas = canvasElement;
    this.container = containerElement;
    this.ctx = canvasElement.getContext('2d');

    this.tabNotes = [];
    this.duration = 0;
    this.bpm = 120; // デフォルト推定テンポ
    this.beatOffset = 0; // 最初の拍の時刻 (秒)
    this.timeSignature = '4/4'; // 拍子 ('4/4' | '3/4' | '6/8')

    // 音符選択 (編集用)
    this.selectedNoteIndex = -1;
    this.onNoteSelect = null; // (index, note|null) => {}

    // 描画幾何パラメータ
    this.pixelsPerSecond = 120; // 1秒あたりの横幅(px) (画面幅で可変: resizeCanvas 参照)
    this.staffTop = 45;         // TAB最上部Y
    this.lineSpacing = 28;      // 弦と弦の間隔(px)
    this.leftPadding = 70;      // 左端TABロゴ用マージン

    // 弦数 (チューニング連動: '4' = 4行 / '5' = B弦行を追加して5行)
    this.tuning = '4';
    this.stringCount = 4;
    this.totalHeight = this.computeTotalHeight();

    this.currentTime = 0;
    this.scrollX = 0;
    this.isAutoScroll = true;

    // ドラッグスクロール用
    this.dragState = null;      // { startX, startScrollX, moved }
    this.suppressClick = false; // ドラッグ直後の click (シーク) を1回抑止

    // A-Bループ
    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    // シークイベント
    this.onSeek = null; // (seconds) => {}

    this.initEvents();
  }

  // キャンバス高さ: 最下弦の下に 51px の余白 (4弦時 = 従来の 180px と一致)
  computeTotalHeight() {
    return this.staffTop + (this.stringCount - 1) * this.lineSpacing + 51;
  }

  /**
   * チューニングを設定し、弦の行数を連動させる ('4' = 4行 / '5' = B弦行を追加)
   * 5弦表示では string=5 の音が本来のB弦行に描かれ、4弦行へのクランプは解消される
   */
  setTuning(tuning) {
    const count = tuning === '5' ? 5 : 4;
    this.tuning = count === 5 ? '5' : '4';
    if (count !== this.stringCount) {
      this.stringCount = count;
      this.totalHeight = this.computeTotalHeight();
      this.resizeCanvas();
    }
    this.render();
  }

  /**
   * 自動スクロール追従の ON/OFF
   */
  setAutoScroll(enabled) {
    this.isAutoScroll = !!enabled;
  }

  initEvents() {
    // タッチ/ペンでもポインタドラッグで譜面をスクロールできるようにする
    this.canvas.style.touchAction = 'none';

    // ドラッグ: 譜面を左右にスクロール (スクラブ) する
    this.canvas.addEventListener('pointerdown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.dragState = {
        startX: e.clientX - rect.left,
        startScrollX: this.scrollX,
        moved: false
      };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 未対応環境では無視 */ }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragState) return;
      const rect = this.canvas.getBoundingClientRect();
      const dx = (e.clientX - rect.left) - this.dragState.startX;
      if (Math.abs(dx) > 4) this.dragState.moved = true;
      if (this.dragState.moved) {
        const maxScroll = Math.max(0, this.duration * this.pixelsPerSecond);
        this.scrollX = Math.min(maxScroll, Math.max(0, this.dragState.startScrollX - dx));
        this.render();
      }
    });
    const endDrag = () => {
      if (!this.dragState) return;
      // ドラッグ後の click で意図しないシーク/選択が起きないよう1回だけ抑止
      if (this.dragState.moved) this.suppressClick = true;
      this.dragState = null;
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    // クリック: 音符の近傍なら選択を優先し、それ以外はシーク
    this.canvas.addEventListener('click', (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      const hitIndex = this.findNoteAtPosition(clickX, clickY);
      if (hitIndex >= 0) {
        this.setSelectedNote(hitIndex);
        return;
      }

      this.setSelectedNote(-1);
      const targetTime = Math.max(0, (clickX + this.scrollX - this.leftPadding) / this.pixelsPerSecond);
      if (this.onSeek) {
        this.onSeek(targetTime);
      }
    });

    // リサイズ監視
    window.addEventListener('resize', () => {
      this.resizeCanvas();
      this.render();
    });
    this.resizeCanvas();
  }

  resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.container ? this.container.clientWidth : window.innerWidth;
    // 画面幅に応じて密度を調整 (小画面では1秒あたりの幅を狭め、詰め込みすぎない)
    this.pixelsPerSecond = width < 480 ? 84 : (width < 768 ? 100 : 120);
    this.canvas.width = width * dpr;
    this.canvas.height = this.totalHeight * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${this.totalHeight}px`;
    this.ctx.scale(dpr, dpr);
  }

  setTabNotes(notes, duration = 0, bpm = 120, beatOffset = 0) {
    this.tabNotes = notes || [];
    this.duration = duration > 0 ? duration : (notes.length > 0 ? notes[notes.length - 1].time + 3 : 30);
    this.bpm = bpm || 120;
    this.beatOffset = beatOffset || 0;
    this.selectedNoteIndex = -1;
    if (this.onNoteSelect) this.onNoteSelect(-1, null);
    this.currentTime = 0;
    this.scrollX = 0;
    this.render();
  }

  /**
   * 編集後のノート列を、再生位置やスクロールを保ったまま差し替える
   */
  updateTabNotes(notes) {
    this.tabNotes = notes || [];
    if (this.selectedNoteIndex >= this.tabNotes.length) {
      this.selectedNoteIndex = -1;
    }
    this.render();
  }

  /**
   * 音符の選択状態を更新し、コールバックへ通知する
   */
  setSelectedNote(index) {
    this.selectedNoteIndex = (index >= 0 && index < this.tabNotes.length) ? index : -1;
    if (this.onNoteSelect) {
      this.onNoteSelect(this.selectedNoteIndex, this.selectedNoteIndex >= 0 ? this.tabNotes[this.selectedNoteIndex] : null);
    }
    this.render();
  }

  /**
   * 拍子を設定する ('4/4' | '3/4' | '6/8')
   */
  setTimeSignature(sig) {
    this.timeSignature = ['4/4', '3/4', '6/8'].includes(sig) ? sig : '4/4';
    this.render();
  }

  // 1小節の長さ (4分音符換算の拍数): 6/8 は4分音符3つ分
  getBarBeatCount() {
    return { '4/4': 4, '3/4': 3, '6/8': 3 }[this.timeSignature] || 4;
  }

  // 小節内の拍点線の位置 (4分音符単位): 6/8 は付点4分×2 の境界のみ
  getBeatSubdivisions() {
    return { '4/4': [1, 2, 3], '3/4': [1, 2], '6/8': [1.5] }[this.timeSignature] || [1, 2, 3];
  }

  /**
   * キャンバス座標 (CSSピクセル) から最も近い音符のインデックスを返す。なければ -1
   */
  findNoteAtPosition(clickX, clickY) {
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    let bestIndex = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.tabNotes.length; i++) {
      const note = this.tabNotes[i];
      const noteX = (note.time * this.pixelsPerSecond) + this.leftPadding - this.scrollX;
      if (noteX < this.leftPadding - 30 || noteX > width + 30) continue;
      // 表示行は現在の弦数にクランプ (5弦表示時は string=5 がそのままB弦行に当たる)
      const displayString = Math.max(1, Math.min(note.string || 4, this.stringCount));
      const noteY = this.staffTop + (displayString - 1) * this.lineSpacing;
      const dx = clickX - noteX;
      const dy = clickY - noteY;
      // タップ判定は指操作向けに拡大 (横 ±22px / 縦 ±16px、最近傍を採用)
      if (Math.abs(dx) <= 22 && Math.abs(dy) <= 16) {
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) { bestDist = dist; bestIndex = i; }
      }
    }
    return bestIndex;
  }

  setLoop(enabled, start, end) {
    this.loopEnabled = enabled;
    this.loopStart = start;
    this.loopEnd = end;
    this.render();
  }

  updateTime(currentTime) {
    this.currentTime = currentTime;

    // 自動スクロール追従: 再生カーソルが画面の35%を超えたらスクロール
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const cursorScreenX = (this.currentTime * this.pixelsPerSecond) + this.leftPadding - this.scrollX;

    if (this.isAutoScroll && !this.dragState) {
      const targetScreenX = width * 0.35;
      if (cursorScreenX > targetScreenX) {
        this.scrollX = (this.currentTime * this.pixelsPerSecond) + this.leftPadding - targetScreenX;
      } else if (cursorScreenX < this.leftPadding) {
        this.scrollX = Math.max(0, (this.currentTime * this.pixelsPerSecond));
      }
    }

    this.render();
  }

  render() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.totalHeight;
    const ctx = this.ctx;

    // 背景クリア (ダークスタジオ調)
    ctx.clearRect(0, 0, width, height);

    // 1. A-Bループ区間のハイライト背景
    if (this.loopEnabled && this.loopEnd > this.loopStart) {
      const staffBottom = this.staffTop + this.lineSpacing * (this.stringCount - 1);
      const loopX1 = (this.loopStart * this.pixelsPerSecond) + this.leftPadding - this.scrollX;
      const loopX2 = (this.loopEnd * this.pixelsPerSecond) + this.leftPadding - this.scrollX;
      ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
      ctx.fillRect(loopX1, this.staffTop - 15, loopX2 - loopX1, (staffBottom - this.staffTop) + 30);

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(loopX1, this.staffTop - 15);
      ctx.lineTo(loopX1, staffBottom + 15);
      ctx.moveTo(loopX2, this.staffTop - 15);
      ctx.lineTo(loopX2, staffBottom + 15);
      ctx.stroke();
    }

    // 2. 拍グリッド ＆ 小節線の描画
    this.renderBeatsAndBars(ctx, width, height);

    // 3. TAB弦 (1弦G, 2弦D, 3弦A, 4弦E / 5弦時は最下行にB)
    const stringLabels = { 1: 'G (1弦)', 2: 'D (2弦)', 3: 'A (3弦)', 4: 'E (4弦)', 5: 'B (5弦)' };
    for (let stringNum = 1; stringNum <= this.stringCount; stringNum++) {
      const y = this.staffTop + (stringNum - 1) * this.lineSpacing;

      // 弦の太さ (最下弦が最も太い)
      const stringThickness = 1.0 + (stringNum - 1) * 0.8;
      ctx.strokeStyle = stringNum === this.stringCount ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = stringThickness;

      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      // 弦名ラベル (左固定エリア) — 背景 #0a0f1d に対し 4.5:1 以上を確保した明度
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(stringLabels[stringNum], this.leftPadding - 18, y + 3.5);
    }

    // 4. 左端 TAB 縦文字ロゴ
    this.renderTabLogo(ctx);

    // 5. ノート（フレット数字）の描画
    this.renderNotes(ctx, width);

    // 6. 再生カーソル (縦の赤いシークバー)
    const cursorX = (this.currentTime * this.pixelsPerSecond) + this.leftPadding - this.scrollX;
    if (cursorX >= this.leftPadding && cursorX <= width) {
      // 発光エフェクト
      ctx.shadowColor = '#f43f5e';
      ctx.shadowBlur = 8;
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 2.5;

      ctx.beginPath();
      ctx.moveTo(cursorX, 10);
      ctx.lineTo(cursorX, height - 10);
      ctx.stroke();

      // カーソル上のインジケータ三角形
      ctx.fillStyle = '#f43f5e';
      ctx.beginPath();
      ctx.moveTo(cursorX - 6, 12);
      ctx.lineTo(cursorX + 6, 12);
      ctx.lineTo(cursorX, 22);
      ctx.fill();

      // リセット
      ctx.shadowBlur = 0;
    }
  }

  renderBeatsAndBars(ctx, width, height) {
    const beatInterval = 60.0 / this.bpm; // 1拍 (4分音符) の秒数
    const beatsPerBar = this.getBarBeatCount();
    const barInterval = beatInterval * beatsPerBar;

    const startSec = Math.max(0, (this.scrollX - this.leftPadding) / this.pixelsPerSecond);
    const endSec = (this.scrollX + width - this.leftPadding) / this.pixelsPerSecond;

    const startBar = Math.floor((startSec - this.beatOffset) / barInterval);
    const endBar = Math.ceil((endSec - this.beatOffset) / barInterval);

    for (let bar = startBar; bar <= endBar; bar++) {
      const barTime = this.beatOffset + bar * barInterval;
      const barX = (barTime * this.pixelsPerSecond) + this.leftPadding - this.scrollX;

      if (barX >= this.leftPadding && barX <= width) {
        // 小節線
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(barX, this.staffTop);
        ctx.lineTo(barX, this.staffTop + this.lineSpacing * (this.stringCount - 1));
        ctx.stroke();

        // 小節番号 (拍オフセット前のピックアップ小節は番号なし)
        if (bar >= 0) {
          ctx.fillStyle = '#94a3b8';
          ctx.font = 'bold 11px monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`M.${bar + 1}`, barX + 6, this.staffTop - 12);
        }
      }

      // 各拍の点線
      for (const beatPos of this.getBeatSubdivisions()) {
        const beatTime = barTime + beatPos * beatInterval;
        const beatX = (beatTime * this.pixelsPerSecond) + this.leftPadding - this.scrollX;
        if (beatX >= this.leftPadding && beatX <= width) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(beatX, this.staffTop);
          ctx.lineTo(beatX, this.staffTop + this.lineSpacing * (this.stringCount - 1));
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }

  renderTabLogo(ctx) {
    // 左端の背景プレート
    ctx.fillStyle = '#0a0f1d';
    ctx.fillRect(0, 0, this.leftPadding - 8, this.totalHeight);

    // 境界線
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(this.leftPadding - 8, 15);
    ctx.lineTo(this.leftPadding - 8, this.totalHeight - 15);
    ctx.stroke();

    // TAB文字
    ctx.fillStyle = '#38bdf8';
    ctx.font = '900 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('T', 20, this.staffTop + this.lineSpacing * 0 + 6);
    ctx.fillText('A', 20, this.staffTop + this.lineSpacing * 1 + 6);
    ctx.fillText('B', 20, this.staffTop + this.lineSpacing * 2 + 6);
  }

  renderNotes(ctx, width) {
    for (let i = 0; i < this.tabNotes.length; i++) {
      const note = this.tabNotes[i];
      const noteX = (note.time * this.pixelsPerSecond) + this.leftPadding - this.scrollX;

      // 画面外はスキップ
      if (noteX < this.leftPadding - 30 || noteX > width + 30) continue;

      const stringNum = note.string || 4; // 1〜5
      // 表示行は現在の弦数にクランプ (5弦表示時は string=5 も本来のB弦行に描く)
      const displayString = Math.max(1, Math.min(stringNum, this.stringCount));
      const noteY = this.staffTop + (displayString - 1) * this.lineSpacing;
      const isCurrentlyPlaying = (this.currentTime >= note.time && this.currentTime <= note.time + note.duration);
      const isSelected = (i === this.selectedNoteIndex);

      // フレット番号の背景円 (弦の線を隠して数字を読みやすく)
      ctx.fillStyle = isCurrentlyPlaying ? '#0284c7' : '#0f172a';
      ctx.beginPath();
      ctx.arc(noteX, noteY, 11, 0, Math.PI * 2);
      ctx.fill();

      // フレット円の枠線 (選択中は白リング＋シアンのグローで基調色に統一して明示)
      ctx.strokeStyle = isSelected ? '#ffffff' : (isCurrentlyPlaying ? '#38bdf8' : 'rgba(56, 189, 248, 0.5)');
      ctx.lineWidth = isSelected ? 3.5 : (isCurrentlyPlaying ? 2.5 : 1.5);
      if (isCurrentlyPlaying || isSelected) {
        ctx.shadowColor = '#38bdf8';
        ctx.shadowBlur = 10;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // フレット番号テキスト
      ctx.fillStyle = isCurrentlyPlaying ? '#ffffff' : '#f1f5f9';
      ctx.font = 'bold 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(note.fret), noteX, noteY + 0.5);

      // 音価ライン (音の長さを表す水平バー)
      const noteWidth = Math.max(6, note.duration * this.pixelsPerSecond - 4);
      if (noteWidth > 14) {
        ctx.strokeStyle = isCurrentlyPlaying ? '#38bdf8' : 'rgba(56, 189, 248, 0.35)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(noteX + 12, noteY);
        ctx.lineTo(noteX + noteWidth, noteY);
        ctx.stroke();
      }

      // 音名表示 (音符の上に小さく "A1", "D2" 等)
      // 全音符に出すと密集して読みにくいため、音程が変わった音符と選択中の音符だけに絞る
      if (note.noteName) {
        const prevNote = i > 0 ? this.tabNotes[i - 1] : null;
        const pitchChanged = !prevNote || prevNote.midi !== note.midi;
        if (pitchChanged || isSelected) {
          ctx.fillStyle = isSelected ? '#e0f2fe' : '#94a3b8';
          ctx.font = '10px monospace';
          ctx.fillText(note.noteName, noteX, noteY - 14);
        }
      }
    }
  }
}

