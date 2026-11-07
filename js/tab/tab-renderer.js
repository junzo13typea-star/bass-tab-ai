/**
 * BassTab AI - Interactive 4-String TAB Notation Canvas Renderer
 * 
 * 4弦エレキベースの本格TAB譜（小節線・拍・フレット番号・音価・カーソル）を
 * 60fpsで滑らかに同期スクロールレンダリングする。
 */

export class TabRenderer {
  constructor(canvasElement, containerElement) {
    this.canvas = canvasElement;
    this.container = containerElement;
    this.ctx = canvasElement.getContext('2d');

    this.tabNotes = [];
    this.duration = 0;
    this.bpm = 120; // デフォルト推定テンポ

    // 描画幾何パラメータ
    this.pixelsPerSecond = 120; // 1秒あたりの横幅(px)
    this.staffTop = 45;         // TAB最上部Y
    this.lineSpacing = 28;      // 弦と弦の間隔(px)
    this.leftPadding = 70;      // 左端TABロゴ用マージン
    this.totalHeight = 180;

    this.currentTime = 0;
    this.scrollX = 0;
    this.isAutoScroll = true;

    // A-Bループ
    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    // シークイベント
    this.onSeek = null; // (seconds) => {}

    this.initEvents();
  }

  initEvents() {
    // クリックした場所へシーク
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
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
    this.canvas.width = width * dpr;
    this.canvas.height = this.totalHeight * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${this.totalHeight}px`;
    this.ctx.scale(dpr, dpr);
  }

  setTabNotes(notes, duration = 0, bpm = 120) {
    this.tabNotes = notes || [];
    this.duration = duration > 0 ? duration : (notes.length > 0 ? notes[notes.length - 1].time + 3 : 30);
    this.bpm = bpm || 120;
    this.currentTime = 0;
    this.scrollX = 0;
    this.render();
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

    if (this.isAutoScroll) {
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
      const loopX1 = (this.loopStart * this.pixelsPerSecond) + this.leftPadding - this.scrollX;
      const loopX2 = (this.loopEnd * this.pixelsPerSecond) + this.leftPadding - this.scrollX;
      ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
      ctx.fillRect(loopX1, this.staffTop - 15, loopX2 - loopX1, this.lineSpacing * 3 + 30);

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(loopX1, this.staffTop - 15);
      ctx.lineTo(loopX1, this.staffTop + this.lineSpacing * 3 + 15);
      ctx.moveTo(loopX2, this.staffTop - 15);
      ctx.lineTo(loopX2, this.staffTop + this.lineSpacing * 3 + 15);
      ctx.stroke();
    }

    // 2. 拍グリッド ＆ 小節線の描画
    this.renderBeatsAndBars(ctx, width, height);

    // 3. 4本のTAB弦 (1弦G, 2弦D, 3弦A, 4弦E)
    const stringLabels = ['G (1弦)', 'D (2弦)', 'A (3弦)', 'E (4弦)'];
    for (let stringNum = 1; stringNum <= 4; stringNum++) {
      const y = this.staffTop + (stringNum - 1) * this.lineSpacing;
      
      // 弦の太さ (4弦Eが最も太い)
      const stringThickness = 1.0 + (stringNum - 1) * 0.8;
      ctx.strokeStyle = stringNum === 4 ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = stringThickness;

      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      // 弦名ラベル (左固定エリア)
      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(stringLabels[stringNum - 1], this.leftPadding - 18, y + 3.5);
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
    const beatInterval = 60.0 / this.bpm; // 1拍の秒数
    const beatsPerBar = 4;
    const barInterval = beatInterval * beatsPerBar;

    const startSec = Math.max(0, (this.scrollX - this.leftPadding) / this.pixelsPerSecond);
    const endSec = (this.scrollX + width - this.leftPadding) / this.pixelsPerSecond;

    const startBar = Math.floor(startSec / barInterval);
    const endBar = Math.ceil(endSec / barInterval);

    for (let bar = startBar; bar <= endBar; bar++) {
      const barTime = bar * barInterval;
      const barX = (barTime * this.pixelsPerSecond) + this.leftPadding - this.scrollX;

      if (barX >= this.leftPadding && barX <= width) {
        // 小節線
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(barX, this.staffTop);
        ctx.lineTo(barX, this.staffTop + this.lineSpacing * 3);
        ctx.stroke();

        // 小節番号
        ctx.fillStyle = '#94a3b8';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`M.${bar + 1}`, barX + 6, this.staffTop - 12);
      }

      // 各拍の点線
      for (let beat = 1; beat < beatsPerBar; beat++) {
        const beatTime = barTime + beat * beatInterval;
        const beatX = (beatTime * this.pixelsPerSecond) + this.leftPadding - this.scrollX;
        if (beatX >= this.leftPadding && beatX <= width) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(beatX, this.staffTop);
          ctx.lineTo(beatX, this.staffTop + this.lineSpacing * 3);
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

      const stringNum = note.string || 4; // 1〜4
      const noteY = this.staffTop + (stringNum - 1) * this.lineSpacing;
      const isCurrentlyPlaying = (this.currentTime >= note.time && this.currentTime <= note.time + note.duration);

      // フレット番号の背景円 (弦の線を隠して数字を読みやすく)
      ctx.fillStyle = isCurrentlyPlaying ? '#0284c7' : '#0f172a';
      ctx.beginPath();
      ctx.arc(noteX, noteY, 11, 0, Math.PI * 2);
      ctx.fill();

      // フレット円の枠線
      ctx.strokeStyle = isCurrentlyPlaying ? '#38bdf8' : 'rgba(56, 189, 248, 0.5)';
      ctx.lineWidth = isCurrentlyPlaying ? 2.5 : 1.5;
      if (isCurrentlyPlaying) {
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
      if (note.noteName) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px monospace';
        ctx.fillText(note.noteName, noteX, noteY - 14);
      }
    }
  }
}
