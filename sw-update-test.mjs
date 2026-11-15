// BassTab SW更新通知 テスト (Node)
// 使い方: node sw-update-test.mjs
// navigator.serviceWorker をスタブして js/sw-update.js の
// 更新検知→通知、制御引き継ぎ→1回だけ再読み込み、初回は再読み込みしない、を検証する。
import { registerServiceWorker } from './js/sw-update.js';

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };
const flush = () => new Promise(r => setTimeout(r, 0));

function setup({ hasController }) {
  const listeners = {};
  const workerListeners = {};
  const regListeners = {};
  const worker = {
    state: 'installing',
    addEventListener: (ev, fn) => { workerListeners[ev] = fn; }
  };
  const reg = {
    installing: worker,
    updateCalled: false,
    update() { this.updateCalled = true; },
    addEventListener: (ev, fn) => { regListeners[ev] = fn; }
  };
  let reloads = 0;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: {
      serviceWorker: {
        controller: hasController ? {} : null,
        addEventListener: (ev, fn) => { listeners[ev] = fn; },
        register: async () => reg
      }
    }
  });
  globalThis.location = { reload: () => { reloads++; } };
  return { listeners, workerListeners, regListeners, worker, reg, reloads: () => reloads };
}

// ケース1: 既存SWあり + 新バージョン installed → 通知され、controllerchange で1回だけ再読み込み
{
  const s = setup({ hasController: true });
  let notified = 0;
  registerServiceWorker(() => { notified++; });
  await flush();
  check('登録時に reg.update() が呼ばれる', s.reg.updateCalled === true);
  s.regListeners.updatefound();
  s.worker.state = 'installed';
  s.workerListeners.statechange();
  check('新バージョンで通知される', notified === 1);
  s.listeners.controllerchange();
  s.listeners.controllerchange();
  check('controllerchange で再読み込みは1回だけ', s.reloads() === 1);
}

// ケース2: 初回インストール (controller なし) → 通知されず、再読み込みもしない
{
  const s = setup({ hasController: false });
  let notified = 0;
  registerServiceWorker(() => { notified++; });
  await flush();
  s.regListeners.updatefound();
  s.worker.state = 'installed';
  s.workerListeners.statechange();
  check('初回は通知されない', notified === 0);
  s.listeners.controllerchange();
  check('初回は再読み込みしない', s.reloads() === 0);
}

// ケース3: まだ installing の間は通知されない
{
  const s = setup({ hasController: true });
  let notified = 0;
  registerServiceWorker(() => { notified++; });
  await flush();
  s.regListeners.updatefound();
  s.worker.state = 'installing';
  s.workerListeners.statechange();
  check('installing 中は通知されない', notified === 0);
}

// ケース4: serviceWorker 非対応なら何も起きない (例外なし)
{
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {} });
  let ok = true;
  try { registerServiceWorker(() => {}); } catch (e) { ok = false; }
  check('非対応環境でも例外なし', ok);
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
