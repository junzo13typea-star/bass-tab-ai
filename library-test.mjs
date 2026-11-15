// BassTab 曲ライブラリ テスト (Node)
// 使い方: node library-test.mjs
// js/library.js の保存・差し替え・上限・削除・破損データ耐性を検証する。
import { loadLibraryEntries, upsertLibraryEntry, removeLibraryEntry, LIBRARY_KEY, LIBRARY_MAX } from './js/library.js';

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}
const entry = (id, title, n = 3) => ({
  id, title, version: 1, tempo: { bpm: 120, offset: 0 }, timeSignature: '4/4',
  tuning: '4', sensitivity: 'normal',
  notes: Array.from({ length: n }, (_, i) => ({ time: i * 0.5, duration: 0.4, midi: 40 + i })),
  savedAt: id
});

// 空の状態
{
  const s = fakeStorage();
  check('未保存なら空配列', loadLibraryEntries(s).length === 0);
}

// 追加と読み戻し
{
  const s = fakeStorage();
  const r1 = upsertLibraryEntry(s, entry(1, 'Song A'));
  check('新規保存できる', !!r1 && r1.updated === false && r1.list.length === 1);
  upsertLibraryEntry(s, entry(2, 'Song B'));
  const list = loadLibraryEntries(s);
  check('新しい曲が先頭に来る', list.length === 2 && list[0].title === 'Song B');
}

// 同タイトルは差し替え (ID維持・件数は増えない)
{
  const s = fakeStorage();
  upsertLibraryEntry(s, entry(10, 'Same', 3));
  const r = upsertLibraryEntry(s, entry(99, 'Same', 7));
  const list = loadLibraryEntries(s);
  check('同タイトルは差し替え', !!r && r.updated === true && list.length === 1);
  check('差し替えでIDが維持され内容が更新される', list[0].id === 10 && list[0].notes.length === 7);
}

// 上限を超えたら古いものから落ちる
{
  const s = fakeStorage();
  for (let i = 1; i <= LIBRARY_MAX + 3; i++) upsertLibraryEntry(s, entry(i, `S${i}`));
  const list = loadLibraryEntries(s);
  check(`上限 ${LIBRARY_MAX} 件に保たれる`, list.length === LIBRARY_MAX);
  check('最新の曲が残る', list[0].title === `S${LIBRARY_MAX + 3}`);
  check('最古の曲が落ちる', !list.some(e => e.title === 'S1'));
}

// 削除
{
  const s = fakeStorage();
  upsertLibraryEntry(s, entry(1, 'A'));
  upsertLibraryEntry(s, entry(2, 'B'));
  check('削除できる', removeLibraryEntry(s, 1) === true && loadLibraryEntries(s).length === 1);
  check('存在しないIDの削除は false', removeLibraryEntry(s, 999) === false);
}

// 破損データ・不正データへの耐性
{
  const s = fakeStorage();
  s.setItem(LIBRARY_KEY, '{broken json');
  check('破損JSONでも空配列', loadLibraryEntries(s).length === 0);
  s.setItem(LIBRARY_KEY, JSON.stringify([{ title: 'no notes' }, entry(5, 'OK')]));
  const list = loadLibraryEntries(s);
  check('notes のないエントリは除外される', list.length === 1 && list[0].title === 'OK');
}

// 容量超過 (setItem が throw) では null を返し、例外を漏らさない
{
  const s = fakeStorage();
  s.setItem = () => { throw new Error('QuotaExceeded'); };
  check('容量超過では null', upsertLibraryEntry(s, entry(1, 'X')) === null);
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
