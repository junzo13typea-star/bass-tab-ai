/**
 * 曲ライブラリ: 解析したTABを複数曲ぶん localStorage に保存し、再解析なしで呼び出す。
 * 保存するのはTABデータのみ (原曲音声は保存しないため、読み込み後はシンセ再生のみ)。
 * storage を引数で受ける純粋関数群にして、Nodeテストから検証できるようにしている。
 */

export const LIBRARY_KEY = 'basstab.library.v1';
export const LIBRARY_MAX = 20;

/** ライブラリ一覧を読む (破損データや未保存なら空配列) */
export function loadLibraryEntries(storage) {
  try {
    const list = JSON.parse(storage.getItem(LIBRARY_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter(e => e && Array.isArray(e.notes) && e.notes.length > 0);
  } catch (e) {
    return [];
  }
}

/**
 * 曲を保存する。同タイトルがあれば差し替え (更新)、なければ先頭に追加。
 * 上限を超えたら古いものから落とす。
 * @returns {{ list: Array, updated: boolean } | null} 保存できたら結果、容量超過などで失敗したら null
 */
export function upsertLibraryEntry(storage, entry) {
  const list = loadLibraryEntries(storage);
  const idx = list.findIndex(e => e.title === entry.title);
  let updated = false;
  if (idx >= 0) {
    entry.id = list[idx].id; // IDは維持して差し替える
    list[idx] = entry;
    updated = true;
  } else {
    list.unshift(entry);
  }
  while (list.length > LIBRARY_MAX) list.pop();
  try {
    storage.setItem(LIBRARY_KEY, JSON.stringify(list));
  } catch (e) {
    return null;
  }
  return { list, updated };
}

/** 曲を削除する。削除できたら true */
export function removeLibraryEntry(storage, id) {
  const list = loadLibraryEntries(storage);
  const next = list.filter(e => e.id !== id);
  if (next.length === list.length) return false;
  try {
    storage.setItem(LIBRARY_KEY, JSON.stringify(next));
  } catch (e) {
    return false;
  }
  return true;
}
