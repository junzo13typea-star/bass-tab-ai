// BassTab ペア取り込み (原曲＋ベースステム) テスト (Node)
// 使い方: node pair-test.mjs
// 検証範囲:
//  1. resolvePairFiles: 1ファイル/2ファイル (名前ヒューリスティクス有無) /3つ以上の割り当て
//  2. shouldWarnPairMismatch: 長さのずれ 0.5 秒超で警告する境界
//  3. processUploadedFile のルーティング: 解析はステム、再生・長さ表示は原曲、
//     lastPair の保持、ペア注記、ずれ警告トースト、単体フロー不変
//     (DOM/WebAudio はスタブし、デコード済みバッファにタグを付けて追跡する)
// 実音声でのペア解析の一致 (ステム単体指標の再現) は eval ハーネス側で別途確認する。
globalThis.window = { addEventListener() {} };

const { BassTabApp, resolvePairFiles, isStemLikeName, pairDurationDiffSec, shouldWarnPairMismatch } =
  await import('./js/app.js');

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };
const file = (name) => ({ name });

// --- 1. ファイル割り当て ---
{
  check('ステムらしい名前を判定', isStemLikeName('song_bass.mp3') && isStemLikeName('song (stem).wav') && isStemLikeName('曲_ベース.mp3') && !isStemLikeName('song.mp3'));

  const single = resolvePairFiles([file('song.mp3')]);
  check('1ファイルは原曲のみ', single.original.name === 'song.mp3' && single.stem === null);

  const named = resolvePairFiles([file('song.mp3'), file('song_bass.mp3')]);
  check('2ファイル: bass 名をステムに', named.original.name === 'song.mp3' && named.stem.name === 'song_bass.mp3');

  const namedFirst = resolvePairFiles([file('song_stem.mp3'), file('song.mp3')]);
  check('2ファイル: 先頭が stem 名なら入れ替える', namedFirst.original.name === 'song.mp3' && namedFirst.stem.name === 'song_stem.mp3');

  const ambiguous = resolvePairFiles([file('a.mp3'), file('b.mp3')]);
  check('2ファイル: 判別不能なら並び順 [0]=原曲 [1]=ステム', ambiguous.original.name === 'a.mp3' && ambiguous.stem.name === 'b.mp3');

  const three = resolvePairFiles([file('a.mp3'), file('a_bass.mp3'), file('extra.mp3')]);
  check('3つ以上は先頭2つだけ使う', three.original.name === 'a.mp3' && three.stem.name === 'a_bass.mp3');

  check('空なら null', resolvePairFiles([]) === null && resolvePairFiles(null) === null);
}

// --- 2. 長さのずれ警告の境界 ---
{
  check('ずれ 0.2 秒は警告しない', !shouldWarnPairMismatch(106.6, 106.4));
  check('ずれ ちょうど 0.5 秒は警告しない', !shouldWarnPairMismatch(106.6, 106.1));
  check('ずれ 0.7 秒は警告する', shouldWarnPairMismatch(106.6, 105.9));
  check('ずれ量の算出', Math.abs(pairDurationDiffSec(100, 97.5) - 2.5) < 1e-9);
  check('不正な長さは警告しない', !shouldWarnPairMismatch(NaN, 100));
}

// --- 3. processUploadedFile のルーティングと状態 ---
function makeApp(buffersByName) {
  const app = new BassTabApp();
  const seen = { analyzedTag: null, playbackTag: null, toasts: [], meta: null, tabDuration: null };
  app.player = {
    stop() {},
    loadTrack(buf) { seen.playbackTag = buf && buf._tag; }
  };
  app.controls = {
    showProgress() {}, hideProgress() {},
    updateTimeDisplay() {}, formatTime: (s) => `${Math.floor(s)}s`
  };
  app.hideTabNotice = () => {};
  app.showTabNotice = () => {};
  app.showToast = (msg) => { seen.toasts.push(msg); };
  app.saveGeneratedTab = () => {};
  app.updateTrackInfo = (title, meta) => { seen.meta = meta; };
  app.analyzer.decodeAudio = async (f) => buffersByName[f.name];
  app.analyzer.filterBassBand = async (buf) => buf;
  app.analyzer.analyzeBassline = async (buf) => {
    seen.analyzedTag = buf._tag;
    return [{ time: 0, duration: 0.4, midi: 40, confidence: 0.95 }];
  };
  app.analyzer.estimateTempo = () => ({ bpm: 172.1, offset: 0 });
  app.analyzer.quantizeNotes = (notes) => notes;
  app.mapper = { mapNotesToTab: (notes) => notes };
  app.tabRenderer = { setTabNotes(notes, duration) { seen.tabDuration = duration; } };
  return { app, seen };
}
const buf = (tag, duration) => ({ _tag: tag, duration, sampleRate: 44100, length: Math.floor(duration * 44100), numberOfChannels: 1, getChannelData: () => new Float32Array(1) });

{ // ペア: 解析はステム、再生と長さは原曲、注記あり、ずれ警告なし (0.2秒)
  const { app, seen } = makeApp({ 'song.mp3': buf('original', 106.6), 'song_bass.mp3': buf('stem', 106.4) });
  await app.processUploadedFile(file('song.mp3'), file('song_bass.mp3'));
  check('ペア: 解析はステム側', seen.analyzedTag === 'stem');
  check('ペア: 再生は原曲側', seen.playbackTag === 'original');
  check('ペア: 譜面の長さは原曲 (106.6)', seen.tabDuration === 106.6);
  check('ペア: lastPair に両方保持', app.lastPair.original.name === 'song.mp3' && app.lastPair.stem.name === 'song_bass.mp3');
  check('ペア: 曲名は原曲名', app.currentTrackTitle === 'song');
  check('ペア: メタに「ペア：ステム使用中」', typeof seen.meta === 'string' && seen.meta.includes('ペア：ステム使用中'));
  check('ペア: ずれ 0.2 秒では警告なし', !seen.toasts.some(t => t.includes('ずれています')));
}

{ // ペア: ずれ 1.6 秒 → 警告トーストを出して続行する
  const { app, seen } = makeApp({ 'song.mp3': buf('original', 106.6), 'song_bass.mp3': buf('stem', 105.0) });
  await app.processUploadedFile(file('song.mp3'), file('song_bass.mp3'));
  check('ペア: ずれ 1.6 秒で警告して続行', seen.toasts.some(t => t.includes('ずれています')) && seen.analyzedTag === 'stem');
}

{ // 単体: 従来どおり原曲を解析し、ペア注記は付かない
  const { app, seen } = makeApp({ 'song.mp3': buf('original', 106.6) });
  await app.processUploadedFile(file('song.mp3'));
  check('単体: 解析は原曲側', seen.analyzedTag === 'original');
  check('単体: lastPair.stem は null', app.lastPair.original.name === 'song.mp3' && app.lastPair.stem === null);
  check('単体: ペア注記なし', typeof seen.meta === 'string' && !seen.meta.includes('ペア：ステム使用中'));
}

{ // addStemFile: 後付けでペア化し、原曲で再解析される
  const { app, seen } = makeApp({ 'song.mp3': buf('original', 106.6), 'late_bass.mp3': buf('stem', 106.5) });
  await app.processUploadedFile(file('song.mp3'));
  await app.addStemFile(file('late_bass.mp3'));
  check('後付け: ステムで再解析される', seen.analyzedTag === 'stem' && app.lastPair.stem.name === 'late_bass.mp3');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
