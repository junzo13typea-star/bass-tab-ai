/**
 * BassTab AI - Smart 4-String Fretboard Mapper
 * 
 * 4弦エレキベース (E - A - D - G) の開放弦ピッチ基準に基づいて、
 * MIDIノート列から最も人間の手の動きとして自然で弾きやすい
 * 弦 (String: 1〜4) と フレット (Fret: 0〜24) を最適化決定する。
 */

export class FretMapper {
  constructor() {
    // 4弦ベースの標準チューニング (開放弦のMIDIノート番号)
    // 弦番号: 1弦=G(43), 2弦=D(38), 3弦=A(33), 4弦=E(28)
    this.STRING_OPEN_MIDI = {
      1: 43, // 1弦 G2
      2: 38, // 2弦 D2
      3: 33, // 3弦 A1
      4: 28  // 4弦 E1
    };
    this.MAX_FRETS = 24;
  }

  /**
   * 単一のMIDIノート番号から、演奏可能なすべての (弦, フレット) 候補を返す
   * @param {number} midi MIDIノート番号 (28〜67)
   * @returns {Array<{ string: number, fret: number }>}
   */
  getCandidates(midi) {
    const candidates = [];
    for (let stringNum = 4; stringNum >= 1; stringNum--) {
      const openMidi = this.STRING_OPEN_MIDI[stringNum];
      const fret = midi - openMidi;
      if (fret >= 0 && fret <= this.MAX_FRETS) {
        candidates.push({ string: stringNum, fret: fret });
      }
    }
    return candidates;
  }

  /**
   * ノート列全体に動的計画法 (Viterbi) を適用し、
   * 手のポジション移動が最小となる最適なTAB譜データを割り当てる
   * @param {Array<{ time: number, duration: number, midi: number, velocity?: number }>} notes 
   * @returns {Array<{ time: number, duration: number, midi: number, string: number, fret: number, noteName: string }>}
   */
  mapNotesToTab(notes) {
    if (!notes || notes.length === 0) return [];

    const n = notes.length;
    // 各ノートの候補リスト
    const allCandidates = notes.map(note => {
      let cands = this.getCandidates(note.midi);
      // 万が一音域外の場合は最も近いフレットにクリップ
      if (cands.length === 0) {
        if (note.midi < 28) cands = [{ string: 4, fret: 0 }];
        else cands = [{ string: 1, fret: 24 }];
      }
      return cands;
    });

    // DPテーブル: dp[i][k] = ノートiで候補kを選んだ時の最小累積コスト
    const dp = [];
    const parent = [];

    // 初期化 (i = 0)
    dp[0] = [];
    parent[0] = [];
    for (let k = 0; k < allCandidates[0].length; k++) {
      const cand = allCandidates[0][k];
      // 初期ハンドポジションはローポジション (1〜5F) を好む
      let initCost = 0;
      if (cand.fret > 0) {
        initCost = Math.abs(cand.fret - 3) * 0.5;
      }
      dp[0][k] = initCost;
      parent[0][k] = -1;
    }

    // DP 遷移 (i = 1 to n-1)
    for (let i = 1; i < n; i++) {
      dp[i] = [];
      parent[i] = [];
      const prevCands = allCandidates[i - 1];
      const curCands = allCandidates[i];
      const timeDelta = notes[i].time - (notes[i - 1].time + notes[i - 1].duration);

      for (let curIdx = 0; curIdx < curCands.length; curIdx++) {
        const cur = curCands[curIdx];
        let minCost = Infinity;
        let bestPrev = 0;

        for (let prevIdx = 0; prevIdx < prevCands.length; prevIdx++) {
          const prev = prevCands[prevIdx];
          const transitionCost = this.calculateTransitionCost(prev, cur, timeDelta);
          const totalCost = dp[i - 1][prevIdx] + transitionCost;

          if (totalCost < minCost) {
            minCost = totalCost;
            bestPrev = prevIdx;
          }
        }

        dp[i][curIdx] = minCost;
        parent[i][curIdx] = bestPrev;
      }
    }

    // バックトラックで最適経路を復元
    let bestFinalIdx = 0;
    let minFinalCost = Infinity;
    for (let k = 0; k < dp[n - 1].length; k++) {
      if (dp[n - 1][k] < minFinalCost) {
        minFinalCost = dp[n - 1][k];
        bestFinalIdx = k;
      }
    }

    const optimalPath = new Array(n);
    let curPathIdx = bestFinalIdx;
    for (let i = n - 1; i >= 0; i--) {
      optimalPath[i] = allCandidates[i][curPathIdx];
      curPathIdx = parent[i][curPathIdx];
    }

    // 結果のTAB譜ノートオブジェクト列を構築
    return notes.map((note, i) => {
      const opt = optimalPath[i];
      return {
        ...note,
        string: opt.string,
        fret: opt.fret,
        noteName: this.midiToNoteName(note.midi)
      };
    });
  }

  /**
   * 前の音 (prev) から 次の音 (cur) への移動コストを計算
   */
  calculateTransitionCost(prev, cur, timeDelta) {
    let cost = 0;

    // 開放弦(0F) の特殊扱い
    const isPrevOpen = prev.fret === 0;
    const isCurOpen = cur.fret === 0;

    if (!isPrevOpen && !isCurOpen) {
      // 1. フレット移動距離コスト (手の横移動)
      const fretDistance = Math.abs(prev.fret - cur.fret);
      cost += fretDistance * 2.2;

      // 4フレット幅を超える大きなジャンプは高コスト
      if (fretDistance > 4) {
        cost += (fretDistance - 4) * 4.0;
      }
    } else if (isCurOpen && !isPrevOpen) {
      // 開放弦は左手を移動させずに鳴らせるので低コスト
      cost += 0.8;
    } else if (!isCurOpen && isPrevOpen) {
      cost += Math.abs(cur.fret - 3) * 0.8;
    }

    // 2. 弦移動コスト (隣の弦は低コスト、2弦以上離れると高コスト)
    const stringDistance = Math.abs(prev.string - cur.string);
    if (stringDistance === 0) {
      // 同一弦での移動
      cost += 0.5;
    } else if (stringDistance === 1) {
      // 隣接弦 (人差し指・中指のオルタネイトに最適)
      cost += 0.2;
    } else {
      // 弦飛び (4弦から2弦、または1弦へ)
      cost += stringDistance * 2.5;
    }

    // 3. ハイポジション (12フレット以上) のペナルティ (ベースはロー〜ミドルが主戦場)
    if (cur.fret > 12) {
      cost += (cur.fret - 12) * 1.5;
    }

    // テンポが速い（timeDeltaが短い）場合、手の大きな移動はさらにペナルティ
    if (timeDelta < 0.2 && !isPrevOpen && !isCurOpen) {
      const dist = Math.abs(prev.fret - cur.fret);
      if (dist > 3) cost += dist * 3.0;
    }

    return cost;
  }

  midiToNoteName(midi) {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const name = noteNames[midi % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}`;
  }
}

