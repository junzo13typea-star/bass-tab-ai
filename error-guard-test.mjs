// BassTab グローバルエラーハンドラ (U3) テスト (Node)
// 使い方: node error-guard-test.mjs
// 検証範囲:
//  1. isActionableErrorEvent: リソース失敗・詳細不明のクロスオリジンエラーを除外する境界
//  2. isActionableRejection: AbortError / NotAllowedError を正常系として除外する境界
//  3. installErrorGuard + イベント発火: バナーが1回だけ出る、再読み込みボタンが
//     location.reload を呼ぶ、×ボタンで消える (DOM はスタブ)

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    attrs: {},
    listeners: {},
    textContent: '',
    id: '',
    type: '',
    parentNode: null,
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    setAttribute(k, v) { el.attrs[k] = v; },
    remove() {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      }
    },
    click() { (el.listeners.click || []).slice().forEach((fn) => fn({})); },
  };
  return el;
}

const winListeners = {};
globalThis.window = {
  addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
};
globalThis.document = {
  createElement: (tag) => makeEl(tag),
  body: makeEl('body'),
  addEventListener() {},
};
let reloadCount = 0;
globalThis.location = { reload() { reloadCount++; } };

let errLogs = 0;
const origConsoleError = console.error;
console.error = () => { errLogs++; };

const { installErrorGuard, isActionableErrorEvent, isActionableRejection } =
  await import('./js/error-guard.js');

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };
const dispatch = (type, event) => (winListeners[type] || []).slice().forEach((fn) => fn(event));
const body = globalThis.document.body;

// --- 1. error イベントの判定 ---
check('null イベントは対象外', isActionableErrorEvent(null) === false);
check('message なし (リソース失敗) は対象外', isActionableErrorEvent({}) === false);
check('詳細不明の Script error. は対象外', isActionableErrorEvent({ message: 'Script error.' }) === false);
check('filename 付き Script error. は対象', isActionableErrorEvent({ message: 'Script error.', filename: 'app.js' }) === true);
check('通常の例外は対象', isActionableErrorEvent({ message: 'boom', filename: 'app.js' }) === true);

// --- 2. rejection の判定 ---
check('AbortError は対象外', isActionableRejection({ name: 'AbortError' }) === false);
check('NotAllowedError は対象外', isActionableRejection({ name: 'NotAllowedError' }) === false);
check('通常の Error は対象', isActionableRejection(new Error('x')) === true);

// --- 3. インストールと発火 ---
installErrorGuard();
check('error リスナが登録された', (winListeners.error || []).length === 1);
check('unhandledrejection リスナが登録された', (winListeners.unhandledrejection || []).length === 1);

dispatch('unhandledrejection', { reason: { name: 'AbortError' } });
check('AbortError の rejection ではバナーを出さない', body.children.length === 0);

dispatch('error', { message: '' });
check('message 空の error ではバナーを出さない', body.children.length === 0);

dispatch('error', { message: 'boom', filename: 'app.js', error: new Error('boom') });
check('例外でバナーが1つ出る', body.children.length === 1 && body.children[0].id === 'globalErrorBanner');
check('例外が console.error に記録される', errLogs >= 1);

dispatch('error', { message: 'boom2', filename: 'app.js', error: new Error('boom2') });
check('2回目の例外でもバナーは1つのまま', body.children.length === 1);

const banner = body.children[0];
const reloadBtn = banner.children.find((c) => c.textContent === '再読み込み');
const closeBtn = banner.children.find((c) => c.textContent === '×');
check('再読み込みボタンがある', !!reloadBtn);
check('×ボタンがある', !!closeBtn);

reloadBtn.click();
check('再読み込みボタンで location.reload が呼ばれる', reloadCount === 1);

closeBtn.click();
check('×ボタンでバナーが消える', body.children.length === 0);

console.error = origConsoleError;
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
