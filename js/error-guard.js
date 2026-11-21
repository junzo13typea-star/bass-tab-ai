/**
 * グローバルエラーハンドラ (U3: 市販化ブラッシュアップのエラー耐性)。
 * 未捕捉の例外 / Promise 拒否で画面が真っ白・無反応になるのを防ぐため、
 * 画面下部に控えめなバナー (再読み込みボタン付き) を1回だけ出す。
 * SW更新トースト (#toast) とは別要素・別位置 (下部) なので競合しない。
 * ブラウザAPIは globalThis 経由で参照し、Nodeテスト可能にしている (sw-update.js と同じ流儀)。
 * ハンドラ自体は絶対に例外を投げない (全処理を try/catch で包む)。
 */

/** リソース読み込み失敗やクロスオリジンの詳細不明エラーは対象外にする */
export function isActionableErrorEvent(event) {
  if (!event || !event.message) return false;
  if (event.message === 'Script error.' && !event.filename) return false;
  return true;
}

/** 再生の中断 (AbortError) や自動再生制限 (NotAllowedError) は正常系として扱う */
export function isActionableRejection(reason) {
  const name = reason && reason.name;
  return name !== 'AbortError' && name !== 'NotAllowedError';
}

let bannerShown = false;
let bannerPending = false;

export function showErrorBanner() {
  const doc = globalThis.document;
  if (bannerShown || !doc || typeof doc.createElement !== 'function') return;
  if (!doc.body) {
    // <head> 相当のタイミングでエラーが起きた場合は DOM 構築後に表示する
    if (!bannerPending && typeof doc.addEventListener === 'function') {
      bannerPending = true;
      doc.addEventListener('DOMContentLoaded', showErrorBanner);
    }
    return;
  }
  bannerShown = true;
  try {
    const bar = doc.createElement('div');
    bar.id = 'globalErrorBanner';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));z-index:10010;display:flex;align-items:center;gap:12px;max-width:min(92vw,560px);background:rgba(10,15,29,0.96);color:#e2e8f0;border:1px solid rgba(34,211,238,0.55);border-radius:14px;padding:10px 16px;font-size:0.85rem;font-weight:700;box-shadow:0 8px 30px rgba(0,0,0,0.55);';
    const text = doc.createElement('span');
    text.textContent = '問題が発生しました';
    const reloadBtn = doc.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.textContent = '再読み込み';
    reloadBtn.style.cssText = 'background:#22d3ee;color:#082f3a;border:none;border-radius:999px;padding:6px 14px;font-size:0.82rem;font-weight:800;cursor:pointer;white-space:nowrap;';
    reloadBtn.addEventListener('click', () => {
      try { globalThis.location.reload(); } catch (e) { /* 何もしない */ }
    });
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.style.cssText = 'background:transparent;color:#94a3b8;border:none;font-size:1rem;line-height:1;cursor:pointer;padding:4px 6px;';
    closeBtn.addEventListener('click', () => {
      try { bar.remove(); } catch (e) { /* 何もしない */ }
    });
    bar.appendChild(text);
    bar.appendChild(reloadBtn);
    bar.appendChild(closeBtn);
    doc.body.appendChild(bar);
  } catch (e) { /* バナーが出なくてもアプリは止めない */ }
}

export function installErrorGuard() {
  const target = globalThis.window || globalThis;
  if (!target || typeof target.addEventListener !== 'function') return;
  target.addEventListener('error', (event) => {
    try {
      if (!isActionableErrorEvent(event)) return;
      console.error('[BassTab] uncaught error:', (event && event.error) || (event && event.message));
      showErrorBanner();
    } catch (e) { /* ハンドラ自体は絶対に投げない */ }
  });
  target.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event && event.reason;
      if (!isActionableRejection(reason)) return;
      console.error('[BassTab] unhandled rejection:', reason);
      showErrorBanner();
    } catch (e) { /* ハンドラ自体は絶対に投げない */ }
  });
}
