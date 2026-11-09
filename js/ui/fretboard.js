/**
 * BassTab AI - Interactive Electric Bass Fretboard UI
 * 
 * 4弦ベースのリアルな指板（0〜24フレット、ポジションマーク）を描画し、
 * 再生中の運指ポジションをネオン発光でリアルタイム可視化。
 * フレットを直接タップしてベース音を鳴らせるバーチャルベース機能も搭載。
 */

export class FretboardUI {
  constructor(containerElement, onFretClick = null) {
    this.container = containerElement;
    this.onFretClick = onFretClick; // (stringNum, fret) => {}
    this.numFrets = 24;
    this.stringCount = 4; // チューニング連動 ('5' でB弦行を追加)

    // 開放弦のMIDIピッチ (4弦=28, 3弦=33, 2弦=38, 1弦=43 / 5弦=23)
    this.openMidi = { 1: 43, 2: 38, 3: 33, 4: 28, 5: 23 };
    this.activeMarkers = new Set(); // 現在発光中の "string-fret" キー

    this.render();
  }

  /**
   * チューニングを設定し、弦の行数を連動させる ('4' = 4行 / '5' = B弦行を追加)
   * 注: .fret-cell.string-5 の見た目は Mac 側 CSS の対応が必要 (UI-FIXLOG のTODO参照)
   */
  setTuning(tuning) {
    const count = tuning === '5' ? 5 : 4;
    if (count !== this.stringCount) {
      this.stringCount = count;
      this.render();
    }
  }

  render() {
    this.container.innerHTML = '';
    const boardWrap = document.createElement('div');
    boardWrap.className = 'fretboard-wrap';

    // 0(ナット) から 24フレットまでのグリッド
    const fretboard = document.createElement('div');
    fretboard.className = 'fretboard-grid';

    // ポジションマークのあるフレット
    const singleDots = [3, 5, 7, 9, 15, 17, 19, 21];
    const doubleDots = [12, 24];

    // 各フレット列の生成
    for (let f = 0; f <= this.numFrets; f++) {
      const fretCol = document.createElement('div');
      fretCol.className = `fret-col ${f === 0 ? 'fret-nut' : ''}`;
      fretCol.setAttribute('data-fret', f);

      // フレット番号ラベル
      const label = document.createElement('span');
      label.className = 'fret-number-label';
      label.textContent = f === 0 ? 'NUT' : f;
      fretCol.appendChild(label);

      // ポジションマーク (インレイ・ドット)
      if (singleDots.includes(f)) {
        const dot = document.createElement('div');
        dot.className = 'fret-inlay-dot';
        fretCol.appendChild(dot);
      } else if (doubleDots.includes(f)) {
        const dotTop = document.createElement('div');
        dotTop.className = 'fret-inlay-dot double-top';
        const dotBtm = document.createElement('div');
        dotBtm.className = 'fret-inlay-dot double-btm';
        fretCol.appendChild(dotTop);
        fretCol.appendChild(dotBtm);
      }

      // 弦と交差するセル (上から1弦G, 2弦D, 3弦A, 4弦E / 5弦時は最下行に5弦B)
      for (let s = 1; s <= this.stringCount; s++) {
        const cell = document.createElement('div');
        cell.className = `fret-cell string-${s}`;
        cell.setAttribute('data-string', s);
        cell.setAttribute('data-fret', f);
        cell.id = `fb-cell-${s}-${f}`;

        // タップしたときに音を鳴らす
        cell.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.triggerFret(s, f);
        });

        // 弦の線 (CSSで描画)
        fretCol.appendChild(cell);
      }

      fretboard.appendChild(fretCol);
    }

    boardWrap.appendChild(fretboard);
    this.container.appendChild(boardWrap);
  }

  /**
   * フレットの直接タップ・クリック処理
   */
  triggerFret(stringNum, fret) {
    this.highlightFret(stringNum, fret, 0.4);
    if (this.onFretClick) {
      this.onFretClick(stringNum, fret);
    }
  }

  /**
   * 特定の弦・フレットをネオン発光させる
   */
  highlightFret(stringNum, fret, durationSec = 0.3) {
    const cellId = `fb-cell-${stringNum}-${fret}`;
    const cell = document.getElementById(cellId);
    if (!cell) return;

    cell.classList.add('hit-active');
    setTimeout(() => {
      cell.classList.remove('hit-active');
    }, durationSec * 1000);
  }

  /**
   * 全発光クリア
   */
  clearAllHighlights() {
    this.container.querySelectorAll('.fret-cell.hit-active').forEach(c => {
      c.classList.remove('hit-active');
    });
  }
}

