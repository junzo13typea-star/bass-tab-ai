/**
 * Service Worker の登録と更新通知 (ビズロギアで実績のある方式の横展開)。
 * 新バージョンがインストールされたら onUpdate を呼び、SWが制御を引き継いだら
 * 1回だけ自動で再読み込みする。初回インストール時 (controller がまだ無い) は
 * 再読み込みしない。ブラウザAPIは globalThis 経由で参照し、Nodeテスト可能にしている。
 */
export function registerServiceWorker(onUpdate) {
  const nav = globalThis.navigator;
  if (!nav || !('serviceWorker' in nav)) return;
  const sw = nav.serviceWorker;
  const hadController = !!sw.controller;
  let refreshing = false;
  sw.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    globalThis.location.reload();
  });
  sw.register('./service-worker.js')
    .then(reg => {
      if (typeof reg.update === 'function') reg.update();
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && sw.controller) onUpdate();
        });
      });
    })
    .catch(err => console.log('SW registration failed:', err));
}
