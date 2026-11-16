// BassTab 低信頼の音符の一括削除テスト (Node)
// 使い方: node lowconf-test.mjs
// 検証範囲:
//  1. partitionLowConfidenceNotes: しきい値 0.8 の境界 (琥珀色判定と一致)、
//     confidence が無い音符は残す、空配列
//  2. deleteLowConfidenceNotes: 未読込時は何もしない / 低信頼なしは通知のみ /
//     確認でキャンセルしたら消さない / 確認したら件数分だけ消えて同期される
let confirmResult = true;
let confirmCalls = 0;
globalThis.window = {
  addEventListener() {},
  confirm() { confirmCalls++; return confirmResult; },
};

const { BassTabApp, partitionLowConfidenceNotes, LOW_CONFIDENCE_THRESHOLD } =
  await import('./js/app.js');

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };
const note = (confidence) => (confidence === undefined ? {} : { confidence });

// --- 1. 仕分け (純関数) ---
{
  check('しきい値は 0.8 (描画側の琥珀色判定と一致)', LOW_CONFIDENCE_THRESHOLD === 0.8);

  const notes = [note(0.5), note(0.79), note(0.8), note(0.95), note(undefined), note(0)];
  const { kept, removed } = partitionLowConfidenceNotes(notes);
  check('0.8 未満だけが removed (0.79/0.5/0)', removed.length === 3 && removed.every((n) => n.confidence < 0.8));
  check('0.8 ちょうどは残る', kept.some((n) => n.confidence === 0.8));
  check('confidence 無しは残る', kept.some((n) => n.confidence === undefined));
  check('合計は元の件数と一致', kept.length + removed.length === notes.length);
  check('元の配列は変更しない', notes.length === 6);

  const empty = partitionLowConfidenceNotes([]);
  check('空配列は kept/removed とも空', empty.kept.length === 0 && empty.removed.length === 0);
  const nullish = partitionLowConfidenceNotes(null);
  check('null でも落ちない', nullish.kept.length === 0 && nullish.removed.length === 0);
}

// --- 2. メソッドの振る舞い ---
function makeApp(notes) {
  const app = Object.create(BassTabApp.prototype);
  app.currentTabNotes = notes;
  app.selectedNoteIndex = notes.length > 0 ? 0 : -1;
  app.toasts = [];
  app.showToast = (msg) => app.toasts.push(msg);
  app.syncCount = 0;
  app.syncNotesAfterEdit = () => { app.syncCount++; };
  app.updateEditBar = () => {};
  app.rendererSelection = null;
  app.tabRenderer = { setSelectedNote: (i) => { app.rendererSelection = i; } };
  return app;
}

{
  confirmCalls = 0;
  const app = makeApp([]);
  app.deleteLowConfidenceNotes();
  check('未読込時: 通知のみで確認は出ない', app.toasts.length === 1 && confirmCalls === 0);
}

{
  confirmCalls = 0;
  const app = makeApp([note(0.9), note(0.85)]);
  app.deleteLowConfidenceNotes();
  check('低信頼なし: 通知のみ、音符は不変', app.toasts.length === 1 && app.currentTabNotes.length === 2 && confirmCalls === 0 && app.syncCount === 0);
}

{
  confirmResult = false;
  const app = makeApp([note(0.5), note(0.9), note(0.7)]);
  app.deleteLowConfidenceNotes();
  check('確認キャンセル: 音符は不変、同期しない', app.currentTabNotes.length === 3 && app.syncCount === 0);
}

{
  confirmResult = true;
  const app = makeApp([note(0.5), note(0.9), note(0.7), note(0.99)]);
  app.deleteLowConfidenceNotes();
  check('確認OK: 低信頼2件だけ消える', app.currentTabNotes.length === 2 && app.currentTabNotes.every((n) => n.confidence >= 0.8));
  check('確認OK: 選択は解除され同期される', app.selectedNoteIndex === -1 && app.rendererSelection === -1 && app.syncCount === 1);
  check('確認OK: 件数入りの完了通知', app.toasts.some((t) => t.includes('2 件削除')));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
