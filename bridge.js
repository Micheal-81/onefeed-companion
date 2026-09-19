// Page <-> worker bridge. A web page cannot always reach the worker directly:
// externally_connectable is picky about patterns, and some browsers do not
// expose chrome.runtime to pages at all. A content script is part of the
// extension, so it can always message the worker. The page posts on window,
// we forward it, and post the answer back. Runs only on the allowlisted
// origins in manifest.json.
(function () {
  const IN = 'onefeed-page', OUT = 'onefeed-ext';
  const ALLOWED = /^onefeed-(ping|fetch|import|open)$/;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== IN || typeof d.id !== 'string' || !d.msg) return;
    const reply = (response) => {
      try { window.postMessage({ source: OUT, id: d.id, response }, event.origin); } catch (e) {}
    };
    const msg = d.msg;
    if (!msg || typeof msg.type !== 'string' || !ALLOWED.test(msg.type)) {
      reply({ ok: false, error: 'unknown request' });
      return;
    }
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        const dead = chrome.runtime.lastError;
        reply(dead ? { ok: false, error: String(dead.message || dead) } : (r || { ok: false, error: 'no answer' }));
      });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || 'bridge failed') });
    }
  });
})();
