// Take Five Agent — the isolated-world half of the page side (t-4202).
//
// Holds the extension port and shuttles messages between the panel and
// page-endpoint.js (MAIN world) over window.postMessage. It reads nothing from
// the page and decides nothing; it is a pipe. Injected into the one tab the
// owner clicked "Attach this tab" on; a second injection adds no second pipe.
(() => {
  if (globalThis.__takeFivePageRelay) return;
  globalThis.__takeFivePageRelay = true;
  const PAGE_SOURCE = 'take-five-bridge/page';
  const EXT_SOURCE = 'take-five-bridge/ext';
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'take-five-bridge') return;
    const fromPage = (ev) => {
      if (ev.source !== window || !ev.data || ev.data.source !== PAGE_SOURCE) return;
      try { port.postMessage(ev.data); } catch {}
    };
    window.addEventListener('message', fromPage);
    port.onMessage.addListener((msg) => window.postMessage(Object.assign({}, msg, { source: EXT_SOURCE }), '*'));
    port.onDisconnect.addListener(() => {
      window.removeEventListener('message', fromPage);
      window.postMessage({ source: EXT_SOURCE, type: 'detach' }, '*');
    });
  });
})();
