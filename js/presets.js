/**
 * BassTab AI - Presets Library
 * 
 * すぐに試せる本格ベースライン・プリセット集
 * （ロック8ビート、スラップ・ファンク、ウォーキング・ジャズ、ネオソウル）
 */

export const PRESETS = [
  {
    id: "rock-drive",
    title: "🎸 Classic Rock Drive (8ビート王道ルート弾き)",
    genre: "Rock",
    bpm: 128,
    desc: "Am ➔ F ➔ C ➔ G の疾走感あふれる8ビート・ストレートドライブ。ピック弾きや指弾きの練習に最適！",
    notes: [
      // M.1 (Am) A1 = 33 (3弦0F または 4弦5F)
      { time: 0.00, duration: 0.22, midi: 33, string: 3, fret: 0, noteName: "A1" },
      { time: 0.23, duration: 0.22, midi: 33, string: 3, fret: 0, noteName: "A1" },
      { time: 0.46, duration: 0.22, midi: 33, string: 3, fret: 0, noteName: "A1" },
      { time: 0.70, duration: 0.22, midi: 33, string: 3, fret: 0, noteName: "A1" },
      { time: 0.93, duration: 0.22, midi: 33, string: 3, fret: 0, noteName: "A1" },
      { time: 1.17, duration: 0.22, midi: 33, string: 3, fret: 0, noteName: "A1" },
      { time: 1.40, duration: 0.22, midi: 33, string: 3, fret: 0, noteName: "A1" },
      { time: 1.64, duration: 0.20, midi: 35, string: 3, fret: 2, noteName: "B1" }, // パッシング

      // M.2 (F) F1 = 29 (4弦1F)
      { time: 1.87, duration: 0.22, midi: 29, string: 4, fret: 1, noteName: "F1" },
      { time: 2.10, duration: 0.22, midi: 29, string: 4, fret: 1, noteName: "F1" },
      { time: 2.34, duration: 0.22, midi: 29, string: 4, fret: 1, noteName: "F1" },
      { time: 2.57, duration: 0.22, midi: 29, string: 4, fret: 1, noteName: "F1" },
      { time: 2.81, duration: 0.22, midi: 29, string: 4, fret: 1, noteName: "F1" },
      { time: 3.04, duration: 0.22, midi: 29, string: 4, fret: 1, noteName: "F1" },
      { time: 3.28, duration: 0.22, midi: 29, string: 4, fret: 1, noteName: "F1" },
      { time: 3.51, duration: 0.20, midi: 31, string: 4, fret: 3, noteName: "G1" },

      // M.3 (C) C2 = 36 (3弦3F)
      { time: 3.75, duration: 0.22, midi: 36, string: 3, fret: 3, noteName: "C2" },
      { time: 3.98, duration: 0.22, midi: 36, string: 3, fret: 3, noteName: "C2" },
      { time: 4.21, duration: 0.22, midi: 36, string: 3, fret: 3, noteName: "C2" },
      { time: 4.45, duration: 0.22, midi: 36, string: 3, fret: 3, noteName: "C2" },
      { time: 4.68, duration: 0.22, midi: 36, string: 3, fret: 3, noteName: "C2" },
      { time: 4.92, duration: 0.22, midi: 36, string: 3, fret: 3, noteName: "C2" },
      { time: 5.15, duration: 0.22, midi: 36, string: 3, fret: 3, noteName: "C2" },
      { time: 5.39, duration: 0.20, midi: 35, string: 3, fret: 2, noteName: "B1" },

      // M.4 (G) G1 = 31 (4弦3F)
      { time: 5.62, duration: 0.22, midi: 31, string: 4, fret: 3, noteName: "G1" },
      { time: 5.85, duration: 0.22, midi: 31, string: 4, fret: 3, noteName: "G1" },
      { time: 6.09, duration: 0.22, midi: 31, string: 4, fret: 3, noteName: "G1" },
      { time: 6.32, duration: 0.22, midi: 31, string: 4, fret: 3, noteName: "G1" },
      { time: 6.56, duration: 0.22, midi: 31, string: 4, fret: 3, noteName: "G1" },
      { time: 6.79, duration: 0.22, midi: 31, string: 4, fret: 3, noteName: "G1" },
      { time: 7.03, duration: 0.22, midi: 31, string: 4, fret: 3, noteName: "G1" },
      { time: 7.26, duration: 0.20, midi: 32, string: 4, fret: 4, noteName: "G#1" }
    ]
  },

  {
    id: "funk-slap",
    title: "⚡️ Funky Slap Groove (スラップ＆プル)",
    genre: "Funk",
    bpm: 104,
    desc: "親指サムピングの重低音(Low-E)と人差し指プル(Octave)のキレ味抜群なファンク・グルーヴ！",
    notes: [
      // M.1 E7#9
      { time: 0.00, duration: 0.26, midi: 28, string: 4, fret: 0, noteName: "E1" },  // Thumb
      { time: 0.29, duration: 0.16, midi: 40, string: 2, fret: 2, noteName: "E2" },  // Pop
      { time: 0.58, duration: 0.18, midi: 28, string: 4, fret: 0, noteName: "E1" },  // Thumb
      { time: 0.86, duration: 0.16, midi: 43, string: 1, fret: 0, noteName: "G2" },  // Pop
      { time: 1.15, duration: 0.26, midi: 28, string: 4, fret: 0, noteName: "E1" },  // Thumb
      { time: 1.44, duration: 0.18, midi: 45, string: 1, fret: 2, noteName: "A2" },  // Pop
      { time: 1.73, duration: 0.18, midi: 46, string: 1, fret: 3, noteName: "A#2" }, // Hammer
      { time: 2.02, duration: 0.24, midi: 45, string: 1, fret: 2, noteName: "A2" },

      // M.2
      { time: 2.30, duration: 0.26, midi: 28, string: 4, fret: 0, noteName: "E1" },
      { time: 2.59, duration: 0.16, midi: 40, string: 2, fret: 2, noteName: "E2" },
      { time: 2.88, duration: 0.18, midi: 33, string: 3, fret: 0, noteName: "A1" },
      { time: 3.17, duration: 0.18, midi: 34, string: 3, fret: 1, noteName: "A#1" },
      { time: 3.46, duration: 0.22, midi: 35, string: 3, fret: 2, noteName: "B1" },
      { time: 3.75, duration: 0.26, midi: 38, string: 2, fret: 0, noteName: "D2" },
      { time: 4.04, duration: 0.35, midi: 40, string: 2, fret: 2, noteName: "E2" }
    ]
  },

  {
    id: "jazz-walk",
    title: "🎷 Walking Jazz Bass (4ビート・スイング)",
    genre: "Jazz",
    bpm: 120,
    desc: "Fブルース進行を4分音符で優雅に歩くウォーキング・ベースライン。コードトーンとアプローチノートの極意。",
    notes: [
      // M.1 (F7)
      { time: 0.00, duration: 0.46, midi: 29, string: 4, fret: 1, noteName: "F1" }, // Root
      { time: 0.50, duration: 0.46, midi: 33, string: 3, fret: 0, noteName: "A1" }, // 3rd
      { time: 1.00, duration: 0.46, midi: 36, string: 3, fret: 3, noteName: "C2" }, // 5th
      { time: 1.50, duration: 0.46, midi: 37, string: 2, fret: 0, noteName: "D#2" }, // b7th
      
      // M.2 (Bb7)
      { time: 2.00, duration: 0.46, midi: 34, string: 3, fret: 1, noteName: "Bb1" },
      { time: 2.50, duration: 0.46, midi: 38, string: 2, fret: 0, noteName: "D2" },
      { time: 3.00, duration: 0.46, midi: 41, string: 2, fret: 3, noteName: "F2" },
      { time: 3.50, duration: 0.46, midi: 40, string: 2, fret: 2, noteName: "E2" }, // Chromatic approach

      // M.3 (F7)
      { time: 4.00, duration: 0.46, midi: 41, string: 2, fret: 3, noteName: "F2" },
      { time: 4.50, duration: 0.46, midi: 36, string: 3, fret: 3, noteName: "C2" },
      { time: 5.00, duration: 0.46, midi: 33, string: 3, fret: 0, noteName: "A1" },
      { time: 5.50, duration: 0.46, midi: 31, string: 4, fret: 3, noteName: "G1" },

      // M.4 (C7)
      { time: 6.00, duration: 0.46, midi: 36, string: 3, fret: 3, noteName: "C2" },
      { time: 6.50, duration: 0.46, midi: 40, string: 2, fret: 2, noteName: "E2" },
      { time: 7.00, duration: 0.46, midi: 31, string: 4, fret: 3, noteName: "G1" },
      { time: 7.50, duration: 0.46, midi: 30, string: 4, fret: 2, noteName: "F#1" }
    ]
  },

  {
    id: "neo-soul",
    title: "✨ Neo-Soul / City Groove (レイドバック・ファンク)",
    genre: "Neo-Soul",
    bpm: 88,
    desc: "後ろノリのレイドバック感と艶やかな高音ダブルストップ。モダンで洗練されたオシャレなベースライン。",
    notes: [
      // M.1 (Dbmaj7)
      { time: 0.00, duration: 0.45, midi: 37, string: 3, fret: 4, noteName: "Db2" },
      { time: 0.68, duration: 0.28, midi: 44, string: 2, fret: 6, noteName: "Ab2" },
      { time: 1.02, duration: 0.48, midi: 48, string: 1, fret: 5, noteName: "C3" },
      { time: 1.70, duration: 0.30, midi: 49, string: 1, fret: 6, noteName: "Db3" },

      // M.2 (Bbm7)
      { time: 2.72, duration: 0.50, midi: 34, string: 3, fret: 1, noteName: "Bb1" },
      { time: 3.40, duration: 0.32, midi: 41, string: 2, fret: 3, noteName: "F2" },
      { time: 3.75, duration: 0.40, midi: 44, string: 2, fret: 6, noteName: "Ab2" },
      { time: 4.42, duration: 0.35, midi: 46, string: 1, fret: 3, noteName: "Bb2" },

      // M.3 (Ebm7 - Ab7)
      { time: 5.45, duration: 0.48, midi: 39, string: 2, fret: 1, noteName: "Eb2" },
      { time: 6.13, duration: 0.30, midi: 46, string: 1, fret: 3, noteName: "Bb2" },
      { time: 6.81, duration: 0.50, midi: 32, string: 4, fret: 4, noteName: "Ab1" },
      { time: 7.50, duration: 0.35, midi: 44, string: 2, fret: 6, noteName: "Ab2" }
    ]
  }
];
