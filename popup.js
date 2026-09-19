// OneFeed Companion popup. Talks to background.js over internal messaging:
// 'onefeed-status' for session badges, 'onefeed-import' to run an import.
// Nothing here touches the network directly.

(function () {
  const $ = (id) => document.getElementById(id);
  // [platform, label, argHint?]. argHint means the list hangs off a profile
  // page, so the user has to type a handle (or id) into the box first.
  const PLATFORMS = [
    ['twitter', 'Twitter / X'],
    ['instagram', 'Instagram'],
    ['tiktok', 'TikTok', 'tiktok handle'],
    ['youtube', 'YouTube'],
    ['twitch', 'Twitch'],
    ['reddit', 'Reddit'],
  ];
  const BADGE = { on: 'logged in', off: 'log in first', public: 'public list', tab: 'via tab' };
  // Endpoint importers are one click; everything else is open then import.
  const APIS = new Set(['twitter', 'instagram', 'pixiv', 'letterboxd']);
  const opened = {};

  let lastRows = [];

  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  const status = (msg, cls) => {
    const el = $('status');
    el.textContent = msg || '';
    el.className = 'status muted' + (cls ? ' ' + cls : '');
  };

  // Green countdown while an import runs, so a long scrape visibly is alive.
  let etaTimer = null;
  const countdown = (sec) => {
    clearInterval(etaTimer);
    let left = sec;
    const tick = () => {
      status(left > 0 ? 'importing. about ' + left + 's left' : 'still working. big lists take a while', 'ok');
      left--;
    };
    tick();
    etaTimer = setInterval(tick, 1000);
  };
  const stopCountdown = () => clearInterval(etaTimer);

  // One row per platform: name, session badge, import button.
  const rowsEl = $('platforms');
  const badges = {};
  for (const [platform, name, argHint] of PLATFORMS) {
    const row = document.createElement('div');
    row.className = 'platform-row';

    const label = document.createElement('span');
    label.className = 'platform-name';
    label.textContent = name;
    row.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'session';
    badge.textContent = '…';
    badges[platform] = badge;
    row.appendChild(badge);

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = APIS.has(platform) ? 'import' : 'open';
    btn.addEventListener('click', () => doImport(platform, argHint, btn));
    row.appendChild(btn);

    rowsEl.appendChild(row);
  }

  // Session badges from the background worker, plus which platforms already
  // have a tab open, reopening the popup should say import, not open again.
  chrome.runtime.sendMessage({ type: 'onefeed-status' }, (r) => {
    void chrome.runtime.lastError;
    const s = (r && r.sessions) || {};
    const openNow = (r && r.open) || {};
    for (const [platform] of PLATFORMS) {
      const state = s[platform] || 'off';
      badges[platform].textContent = BADGE[state] || BADGE.off;
      badges[platform].className = 'session' + (state === 'on' ? ' on' : '');
      if (!APIS.has(platform) && openNow[platform] && opened[platform] === undefined) {
        opened[platform] = null;
        const b = badges[platform].parentNode.querySelector('.btn');
        if (b) b.textContent = 'import';
      }
    }
  });

  async function doImport(platform, argHint, btn) {
    let arg = opened[platform];
    if (argHint && arg === undefined) {
      arg = $('arg-input').value.trim().replace(/^@/, '');
      if (!arg) {
        $('arg-input').placeholder = 'type ' + argHint + ' here';
        $('arg-input').focus();
        status('type ' + argHint + ' first', 'err');
        return;
      }
    }
    // Phase one for the scrapers: put the list page on screen, then wait for
    // the second click to actually read it.
    if (!APIS.has(platform) && opened[platform] === undefined) {
      opened[platform] = arg || null;
      status('opening ' + platform + '…');
      chrome.runtime.sendMessage({ type: 'onefeed-open', platform, arg }, (r) => {
        const dead = chrome.runtime.lastError;
        if (dead || !r || !r.ok) {
          delete opened[platform];
          status((r && r.error) || (dead && 'the background worker did not answer. reload the extension') || 'could not open the page', 'err');
          return;
        }
        btn.textContent = 'import';
        status(platform + ' is open in a tab. log in there if it asks, then press import');
      });
      return;
    }
    btn.classList.add('busy');
    btn.textContent = '…';
    countdown(APIS.has(platform) ? 20 : 60);
    chrome.runtime.sendMessage({ type: 'onefeed-import', platform, arg }, (r) => {
      const dead = chrome.runtime.lastError;
      stopCountdown();
      btn.classList.remove('busy');
      // A finished scrape closes its tab, so the cycle starts back at open.
      delete opened[platform];
      btn.textContent = APIS.has(platform) ? 'import' : 'open';
      if (dead) {
        lastRows = [];
        $('copy').disabled = true;
        status('the background worker did not answer. reload the extension on the extensions page', 'err');
        return;
      }
      if (!r || !r.ok) {
        lastRows = [];
        $('copy').disabled = true;
        status((r && r.error) || 'that did not work', 'err');
        return;
      }
      lastRows = r.rows || [];
      $('copy').disabled = !lastRows.length;
      if (lastRows.length) {
        // The handoff is the clipboard: copy now, then the button below opens
        // onefeed's settings where the red paste box takes them.
        const text = lastRows.map((row) => row.label || row.value).join('\n');
        navigator.clipboard.writeText(text).then(
          () => status('done. ' + lastRows.length + ' follows copied. open onefeed and paste them in the red box', 'ok'),
          () => status('done. ' + lastRows.length + ' follows. hit copy list, then paste them in the red box on onefeed', 'ok'));
      } else {
        status('found 0 follows on that page', 'ok');
      }
    });
  }

  $('copy').addEventListener('click', async () => {
    if (!lastRows.length) return;
    // Label, not value: a youtube channel id or lemmy name@instance is not a
    // handle, so prepending '@' would corrupt it.
    const text = lastRows.map((r) => r.label || r.value).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      status('copied ' + lastRows.length + ' handles', 'ok');
    } catch (e) {
      status('could not reach the clipboard', 'err');
    }
  });

  async function openSite() {
    chrome.tabs.create({ url: 'https://onefeed.online/app/#/settings' });
  }

  $('open').addEventListener('click', openSite);
})();
