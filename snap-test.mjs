// BassTab 「8ビートに整える」テスト (Node)
// 使い方: node snap-test.mjs
// 検証範囲:
//  1. snapNotesToEighthGrid: 長い音の分割 (打ち直し)、16分の統合 (重なり大が勝つ/
//     同点は早い方)、オフグリッドの吸着、オフセット、休符 (間隔) の保持、無効入力
//  2. snapToEighthGrid メソッド: 未読込/整形済みは通知のみ、キャンセルで不変、
//     確認で適用され件数が通知される
let confirmResult = true;
let confirmCalls = 0;
globalThis.window = {
  addEventListener() {},
  confirm() { confirmCalls++; return confirmResult; },
};

const { BassTabApp, snapNotesToEighthGrid } = await import('./js/app.js');

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };
const approx = (a, b) => Math.abs(a - b) < 1e-9;
// bpm=120 → 8分 = 0.25s, offset=0 で検証する
const N = (time, duration, midi, extra = {}) => ({ time, duration, midi, string: 4, fret: 0, noteName: 'X', confidence: 0.9, ...extra });

// --- 1. 純関数 ---
{
  const straight = [N(0, 0.25, 33), N(0.25, 0.25, 33), N(0.5, 0.25, 35)];
  const out = snapNotesToEighthGrid(straight, 120, 0);
  check('整形済みはそのまま', out.length === 3 && out.every((n, i) => approx(n.time, straight[i].time) && approx(n.duration, 0.25) && n.midi === straight[i].midi));
}
{
  const out = snapNotesToEighthGrid([N(0, 1.0, 33)], 120, 0);
  check('長い音は8分ごとに打ち直し (4音に分割)', out.length === 4 && out.every((n) => n.midi === 33 && approx(n.duration, 0.25)));
  check('分割位置はグリッド上', out.map((n) => n.time).join(',') === '0,0.25,0.5,0.75');
}
{
  const out = snapNotesToEighthGrid([N(0, 0.125, 40), N(0.125, 0.125, 45)], 120, 0);
  check('16分2つは1音に統合 (同点は早い方)', out.length === 1 && out[0].midi === 40 && approx(out[0].time, 0));
}
{
  const out = snapNotesToEighthGrid([N(0, 0.06, 40), N(0.05, 0.2, 45)], 120, 0);
  check('重なりが大きい方が勝つ', out.length === 1 && out[0].midi === 45);
}
{
  const out = snapNotesToEighthGrid([N(0.31, 0.2, 38)], 120, 0);
  check('オフグリッドの発音は最寄りの8分へ吸着', out.length === 1 && approx(out[0].time, 0.25));
}
{
  const out = snapNotesToEighthGrid([N(0.1, 0.25, 33), N(0.35, 0.25, 33)], 120, 0.1);
  check('オフセットを基準に吸着', out.length === 2 && approx(out[0].time, 0.1) && approx(out[1].time, 0.35));
}
{
  const out = snapNotesToEighthGrid([N(0, 0.25, 33), N(0.75, 0.25, 35)], 120, 0);
  check('休符の間隔は埋めない', out.length === 2 && approx(out[1].time, 0.75));
}
{
  const src = N(0, 1.0, 33, { string: 3, fret: 5, noteName: 'A1', confidence: 0.77 });
  const out = snapNotesToEighthGrid([src], 120, 0);
  check('運指・名前・信頼度は元の音符から引き継ぐ', out[0].string === 3 && out[0].fret === 5 && out[0].noteName === 'A1' && out[0].confidence === 0.77);
  check('元の音符オブジェクトは書き換えない', src.time === 0 && src.duration === 1.0);
}
{
  check('空配列は空', snapNotesToEighthGrid([], 120, 0).length === 0);
  check('null は空', snapNotesToEighthGrid(null, 120, 0).length === 0);
  check('bpm 不正は空', snapNotesToEighthGrid([N(0, 0.25, 33)], 0, 0).length === 0);
}

// --- 2. メソッド ---
function makeApp(notes) {
  const app = Object.create(BassTabApp.prototype);
  app.currentTabNotes = notes;
  app.selectedNoteIndex = notes.length > 0 ? 0 : -1;
  app.toasts = [];
  app.showToast = (msg) => app.toasts.push(msg);
  app.syncCount = 0;
  app.syncNotesAfterEdit = () => { app.syncCount++; };
  app.updateEditBar = () => {};
  app.editGridTempo = () => ({ bpm: 120, offset: 0 });
  app.rendererSelection = null;
  app.tabRenderer = { setSelectedNote: (i) => { app.rendererSelection = i; } };
  return app;
}
{
  confirmCalls = 0;
  const app = makeApp([]);
  app.snapToEighthGrid();
  check('未読込時: 通知のみで確認は出ない', app.toasts.length === 1 && confirmCalls === 0);
}
{
  confirmCalls = 0;
  const app = makeApp([N(0, 0.25, 33), N(0.25, 0.25, 33)]);
  app.snapToEighthGrid();
  check('整形済み: 「すでに整っています」通知のみ', app.toasts.some((t) => t.includes('すでに')) && confirmCalls === 0 && app.syncCount === 0);
}
{
  confirmResult = false;
  const app = makeApp([N(0, 1.0, 33)]);
  app.snapToEighthGrid();
  check('確認キャンセル: 音符は不変', app.currentTabNotes.length === 1 && app.currentTabNotes[0].duration === 1.0 && app.syncCount === 0);
}
{
  confirmResult = true;
  const app = makeApp([N(0, 1.0, 33), N(1.0, 0.125, 40), N(1.125, 0.125, 45)]);
  app.snapToEighthGrid();
  check('確認OK: 3音 → 5音 (分割4+統合1)', app.currentTabNotes.length === 5);
  check('確認OK: 全音がグリッド上で8分長', app.currentTabNotes.every((n) => approx(n.duration, 0.25) && approx(n.time / 0.25, Math.round(n.time / 0.25))));
  check('確認OK: 選択解除と同期', app.selectedNoteIndex === -1 && app.rendererSelection === -1 && app.syncCount === 1);
  check('確認OK: 件数入りの完了通知', app.toasts.some((t) => t.includes('3音 → 5音')));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
