/**
 * OneFeed browser extension companion.
 *
 * An extension's background worker is not subject to CORS at all: with
 * host_permissions it can read any site, exactly like the iOS app does. The
 * page asks the extension to fetch, the extension fetches, the page gets the
 * text back. Nothing is proxied through anyone else's server, and it is the
 * only option here with no rate limit and no third party involved.
 *
 * The page never depends on this. fetchers.js probes for it once and adds it to
 * the front of the chain if present, so someone without it just uses the other
 * relays.
 *
 * INSTALL (unpacked, no store listing needed)
 *   1. chrome://extensions  ->  turn on Developer mode
 *   2. Load unpacked  ->  select this deploy/extension folder
 *   3. Copy the extension ID it shows
 *   4. Put that ID in public/js/config.js as EXTENSION_ID
 *
 * The sites allowed to talk to it are pinned in manifest.json under
 * externally_connectable. Add your domain there if it changes.
 */

const TIMEOUT_MS = 15000;
const MAX_BYTES = 6 * 1024 * 1024;
const UA_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8';


// Headers a specific host insists on. Instagram's web API answers 400
// {"message":"useragent mismatch"} without the app id its own web client sends.
// Fixed per-host map, so callers cannot forge arbitrary headers through us.
const HOST_HEADERS = [
  [/(^|\.)instagram\.com$/i, { 'x-ig-app-id': '936619743392459' }],
];
function extraHeaders(hostname) {
  for (const [re, h] of HOST_HEADERS) if (re.test(hostname)) return h;
  return null;
}

function blockedHost(hostname) {
  const h = String(hostname).toLowerCase();
  // new URL() reports ipv6 literals bracketed ([::1], [::ffff:c0a8:101]), so
  // any hostname containing a colon is an ip literal form. None of them are
  // feed hosts: refuse the lot rather than enumerate v6 ranges.
  if (h.indexOf(':') !== -1) return true;
  // Bare names resolve on the local network (router, nas, wpad).
  if (h.indexOf('.') === -1) return true;
  const LOCAL_SUFFIXES = ['.localhost', '.internal', '.local', '.lan', '.corp', '.intranet', '.localdomain', '.home.arpa'];
  for (const s of LOCAL_SUFFIXES) if (h === s.slice(1) || h.endsWith(s)) return true;
  // Wildcard dns: a name like 192.168.1.1.nip.io resolves to that private ip
  // while passing the literal checks below. Block the known services and any
  // hostname that begins with an ip literal plus a suffix.
  const WILDCARD_DNS = ['nip.io', 'sslip.io', 'xip.io', 'lvh.me', 'localtest.me', 'vcap.me', 'nip.re', 'traefik.me'];
  for (const w of WILDCARD_DNS) if (h === w || h.endsWith('.' + w)) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(\.|$)/);
  if (m) {
    // An ip literal followed by a suffix (10.0.0.1.example.com) is never a
    // real feed host, so it is refused outright. A bare literal is checked
    // against the private ranges.
    if (m[5]) return true;
    const p = [+m[1], +m[2], +m[3], +m[4]];
    if (p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  }
  return false;
}

// fetch() follows a 302 wherever it leads and forwards caller set headers
// (x-csrftoken and friends) across origins, so redirects are walked one hop
// at a time: every Location is re-checked against blockedHost, and callers
// that asked for sameHostOnly (the session requests) stop at any cross host
// hop instead of carrying cookies and tokens somewhere new.
async function fetchFollow(u, opts, sameHostOnly) {
  let cur = u;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(cur.toString(), Object.assign({}, opts, { redirect: 'manual' }));
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('location');
    if (!loc) return res;
    let next;
    try { next = new URL(loc, cur); } catch (e) { return res; }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return res;
    if (blockedHost(next.hostname) || next.username || next.password) return res;
    if (sameHostOnly && next.hostname !== cur.hostname) return res;
    cur = next;
  }
  throw new Error('too many redirects');
}

// Twitter replies, using YOUR logged-in session
// Twitter stopped serving conversations to logged-out clients, which is what
// killed every Nitter instance. A logged-in client can still read them, and
// this extension runs in your browser, so it can ask as you.
//
// OFF BY DEFAULT. Nothing uses your Twitter session unless you set this to true.
// When on: requests to api.twitter.com are sent with your x.com cookies and the
// CSRF token those cookies carry. It reads that token via the cookies
// permission; it never sends your session anywhere except to Twitter itself,
// and never to the OneFeed server.
const USE_TWITTER_SESSION = false;

const TW_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

async function twitterCsrf() {
  try {
    const c = await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' })
           || await chrome.cookies.get({ url: 'https://twitter.com', name: 'ct0' });
    return c && c.value ? c.value : null;
  } catch (e) { return null; }
}

// True when this url needs the logged-in treatment.
const isTwitterApi = (h) => /(^|\.)(twitter|x)\.com$/i.test(h);

async function twitterSessionFetch(u) {
  const csrf = await twitterCsrf();
  if (!csrf) throw new Error('not logged in to x.com');
  const res = await fetchFollow(u, {
    method: 'GET',
    credentials: 'include',          // send the x.com cookies, only to x.com
    headers: {
      authorization: 'Bearer ' + TW_BEARER,
      'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      accept: '*/*',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }, true);
  return res;
}

// follow-list import, using YOUR logged-in session
// The page sends {type:'onefeed-import', platform} and gets back
// [{value,label}], handle names only. Cookies never leave this worker: they
// are sent to the platform's own domain and nowhere else, which is exactly
// what the user's browser would do with the same request anyway.
//
// Why this exists: none of these three offer a free OAuth that returns a
// follow list. X charges per profile read, instagram exposes the list through
// no public API at all, and tiktok's only follow endpoint sits inside their
// academic research program. This is the automated version of a person
// scrolling their own Following page and writing the names down.

async function cookieValue(origin, name) {
  try {
    const c = await chrome.cookies.get({ url: origin, name });
    return c && c.value ? c.value : null;
  } catch (e) { return null; }
}

// Paged API calls go out one breath at a time, not in a burst. A burst is how
// you earn a rate limit; a person paging through a list looks like this.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_GAP_MS = 700;

// api.twitter.com, read as the logged-in visitor, json out.
async function twJson(url) {
  const res = await twitterSessionFetch(url); // throws when not logged in
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) throw new Error('twitter http ' + res.status);
  return j;
}

async function importTwitter() {
  if (!await cookieValue('https://x.com', 'auth_token')) {
    throw new Error('you are not logged in to x.com in this browser');
  }
  // The twid cookie carries "u=<numeric id>", so most of the time no account
  // lookup call is needed at all.
  let uid = '';
  const twid = await cookieValue('https://x.com', 'twid');
  const m = twid && decodeURIComponent(twid).match(/u=(\d+)/);
  if (m) uid = m[1];
  if (!uid) {
    const me = await twJson('https://api.twitter.com/1.1/account/settings.json');
    if (!me.screen_name) throw new Error('twitter did not say who you are');
    const u = await twJson('https://api.twitter.com/1.1/users/show.json?screen_name=' + encodeURIComponent(me.screen_name));
    uid = u && u.id_str;
  }
  if (!uid) throw new Error('could not find your twitter user id');
  const rows = [];
  let cursor = '-1';
  for (let page = 0; page < 20 && cursor && cursor !== '0'; page++) {
    const j = await twJson('https://api.twitter.com/1.1/friends/list.json?count=200&skip_status=true&include_user_entities=false&user_id='
      + encodeURIComponent(uid) + '&cursor=' + encodeURIComponent(cursor));
    (j.users || []).forEach((u) => { if (u.screen_name) rows.push({ value: u.screen_name, label: '@' + u.screen_name }); });
    cursor = j.next_cursor_str || '0';
    if (cursor && cursor !== '0') await sleep(PAGE_GAP_MS);
  }
  if (!rows.length) throw new Error('no follows came back from twitter');
  return rows;
}

async function importInstagram() {
  const ORIGIN = 'https://www.instagram.com';
  if (!await cookieValue(ORIGIN, 'sessionid')) {
    throw new Error('you are not logged in to instagram in this browser');
  }
  const csrf = await cookieValue(ORIGIN, 'csrftoken');
  const headers = { 'x-ig-app-id': '936619743392459', 'x-asbd-id': '129477' };
  if (csrf) headers['x-csrftoken'] = csrf;
  const get = async (url) => {
    const res = await fetchFollow(new URL(url), { credentials: 'include', headers, signal: AbortSignal.timeout(TIMEOUT_MS) }, true);
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) throw new Error('instagram http ' + res.status);
    return j;
  };
  let pk = await cookieValue(ORIGIN, 'ds_user_id');
  if (!pk) {
    // The id normally sits in the ds_user_id cookie; if it is missing, the
    // logged-in home page embeds the same id as "viewerId".
    const res = await fetchFollow(new URL(ORIGIN + '/'), { credentials: 'include', headers, signal: AbortSignal.timeout(TIMEOUT_MS) }, true);
    const m = (await res.text()).match(/"viewerId"\s*:\s*"?(\d{3,})"?/);
    if (m) pk = m[1];
  }
  if (!pk) throw new Error('could not find your instagram user id');
  const rows = [];
  let maxId = '';
  for (let page = 0; page < 30; page++) {
    const j = await get(ORIGIN + '/api/v1/friendships/' + encodeURIComponent(pk) + '/following/?count=50'
      + (maxId ? '&max_id=' + encodeURIComponent(maxId) : ''));
    (j.users || []).forEach((u) => { if (u.username) rows.push({ value: u.username, label: '@' + u.username }); });
    maxId = j.next_max_id || '';
    if (!maxId) break;
    await sleep(PAGE_GAP_MS);
  }
  if (!rows.length) throw new Error('no follows came back from instagram');
  return rows;
}

// Pixiv's ajax API serves the following list as JSON. It is public when the
// user shares it, and the logged-in session cookie unlocks your own either
// way. arg is the numeric user id, which is the value our pixiv source takes.
async function importPixiv(uid) {
  if (!/^\d{1,10}$/.test(String(uid || ''))) throw new Error('need your numeric pixiv user id');
  const rows = [];
  for (let off = 0; off < 5000; off += 24) {
    const res = await fetch('https://www.pixiv.net/ajax/user/' + encodeURIComponent(uid) + '/following?offset=' + off + '&limit=24',
      { credentials: 'include', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) throw new Error('pixiv http ' + res.status + (res.status === 403 ? ' (that list may be private)' : ''));
    const users = (j.body && j.body.users) || j.users || [];
    users.forEach((u) => { if (u.userId) rows.push({ value: String(u.userId), label: (u.userName || u.userId) + ' pixiv' }); });
    if (users.length < 24) break;
    await sleep(PAGE_GAP_MS);
  }
  if (!rows.length) throw new Error('no follows came back from pixiv');
  return rows;
}

// Letterboxd's following list is public HTML, so no session and no tab: just
// fetch the pages and pull the profile links out of each person card.
async function importLetterboxd(handle) {
  if (!/^[A-Za-z0-9_]{2,20}$/.test(String(handle || ''))) throw new Error('need a letterboxd username');
  const seen = new Set();
  const rows = [];
  for (let page = 1; page <= 40; page++) {
    const res = await fetch('https://letterboxd.com/' + encodeURIComponent(handle) + '/following/page/' + page + '/',
      { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) break;
    if (!res.ok) throw new Error('letterboxd http ' + res.status);
    const html = await res.text();
    const before = seen.size;
    // a.name inside each person card links to /username/. Attribute order has
    // shifted between builds, so match both.
    html.replace(/<a[^>]+class="[^"]*name[^"]*"[^>]+href="\/([A-Za-z0-9_]+)\/"/g, (m, u) => { seen.add(u); return m; });
    html.replace(/<a[^>]+href="\/([A-Za-z0-9_]+)\/"[^>]+class="[^"]*name[^"]*"/g, (m, u) => { seen.add(u); return m; });
    if (seen.size === before) break;
    await sleep(PAGE_GAP_MS);
  }
  seen.forEach((u) => rows.push({ value: u, label: '@' + u }));
  if (!rows.length) throw new Error('no follows came back from letterboxd');
  return rows;
}

// generic scroll-and-collect scrape
// Everything else has no usable endpoint at all, so the same routine covers
// all of them: open the follow-list page in a background tab, scroll until it
// stops growing, and harvest profile links. Each site is just a row in
// SCRAPES, url, what to click first, which links count, which values to drop.

function waitForTab(tab) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('the page took too long to load')), 40000);
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); res(); };
    const onUpd = (id, info) => { if (id === tab.id && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    // A cached page can finish before the listener lands; check once directly
    // rather than waiting out the whole timeout.
    chrome.tabs.get(tab.id).then((cur) => { if (cur && cur.status === 'complete') done(); }).catch(() => {});
  });
}

// Runs inside the scraped tab, fully self contained, nothing from the
// worker's scope is visible in there. cfg travels as a plain object.
async function scrapeLinksInTab(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const drop = new Set((cfg.drop || []).map((d) => d.toLowerCase()));
  // A link entry is a regex string, or {re, pre} where pre is the label
  // prefix ('r/' for reddit, '' when the bare id should show as-is).
  const specs = cfg.links.map((l) => {
    const o = typeof l === 'string' ? { re: l } : l;
    return { re: new RegExp(o.re, 'i'), pre: o.pre === undefined ? '@' : o.pre };
  });
  const seen = new Map(); // value -> label
  const collect = (root) => {
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      for (const s of specs) {
        const m = href.match(s.re);
        if (!m) continue;
        let value = m[1];
        if (cfg.join) value = m[1] + cfg.join + (m[2] || cfg.joinFallback || '');
        if (!value || drop.has(m[1].toLowerCase()) || drop.has(value.toLowerCase())) return;
        if (!seen.has(value)) seen.set(value, s.pre + value);
        return;
      }
    });
  };
  // Some lists sit behind a click first (tiktok's Following modal).
  if (cfg.click) {
    const btn = document.querySelector(cfg.click)
      || [...document.querySelectorAll('a,strong,span,div,h3')].find((e) => cfg.clickText && (e.textContent || '').trim() === cfg.clickText);
    if (btn) btn.click();
  }
  // Wait for the list to exist. 'modal' scopes collection to the dialog so
  // suggested accounts on the page behind it can never leak in.
  let root = document;
  const waitSel = cfg.wait || 'a[href]';
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (cfg.scope === 'modal') {
      const dlg = document.querySelector('div[role="dialog"]');
      if (dlg && dlg.querySelector(waitSel)) { root = dlg; break; }
    } else if (document.querySelector(waitSel)) break;
  }
  collect(root);
  let stable = 0;
  for (let i = 0; i < 200 && stable < 6; i++) {
    let box = null, h = 0;
    root.querySelectorAll('*').forEach((n) => {
      if (n.scrollHeight > n.clientHeight + 40 && n.clientHeight > h) { box = n; h = n.clientHeight; }
    });
    const beforeTop = box ? box.scrollTop : 0;
    if (box) box.scrollTop = box.scrollHeight;
    if (cfg.window) window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(500);
    const size = seen.size;
    collect(root);
    stable = ((box && box.scrollTop !== beforeTop) || seen.size > size) ? 0 : stable + 1;
  }
  return {
    rows: [...seen].map(([value, label]) => ({ value, label })),
    url: location.href,
    anchors: document.querySelectorAll('a[href]').length,
  };
}

const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };

// platform -> tabId for tabs this import flow has driven. A login wall can
// bounce the tab to another host (accounts.google.com), after which a host
// match finds nothing and would open a second tab, the tracked id survives
// the redirect, so open/import always reuse the same tab. Kept in session
// storage because the worker can be put to sleep between clicks.
const tabById = (id) => (id == null ? Promise.resolve(null) : chrome.tabs.get(id).catch(() => null));
let importTabsCache = null;
async function importTabId(platform) {
  if (importTabsCache === null) {
    const s = await chrome.storage.session.get('ofImportTabs').catch(() => ({}));
    importTabsCache = (s && s.ofImportTabs) || {};
  }
  return importTabsCache[platform];
}
async function setImportTab(platform, id) {
  await importTabId(platform);
  if (id == null) delete importTabsCache[platform]; else importTabsCache[platform] = id;
  try { await chrome.storage.session.set({ ofImportTabs: importTabsCache }); } catch (e) {}
}

async function tabScrape(platform, url, cfg) {
  // A visible tab, on purpose: the user watches it scroll, which is the
  // progress bar, and a hidden tab can be throttled so hard the list never
  // renders. The tracked tab is reused and navigated over, so a retry never
  // spawns a second tab.
  const base = url.split('?')[0];
  let tab = await tabById(await importTabId(platform));
  if (!tab) {
    // Only reuse a tab already sitting on the exact list page, never take
    // over some other youtube tab the user happens to have open.
    const all = await chrome.tabs.query({});
    tab = all.find((t) => t.url && t.url.indexOf(base) === 0);
  }
  const ours = !tab;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: true });
    await waitForTab(tab);
  } else {
    const cur = await chrome.tabs.get(tab.id).catch(() => null);
    if (!cur || !cur.url || cur.url.indexOf(base) !== 0) {
      await chrome.tabs.update(tab.id, { url, active: true });
      await waitForTab(tab);
    } else {
      await chrome.tabs.update(tab.id, { active: true });
      if (cur.status !== 'complete') await waitForTab(tab);
    }
  }
  await setImportTab(platform, tab.id);
  // The page can still move after it reports complete (meta refresh, script
  // redirects), so re-check where the tab actually is right before injecting.
  // A different host means a login wall or a redirect, and the scraper must
  // never run on an origin it was not pointed at.
  const landed = await chrome.tabs.get(tab.id).catch(() => null);
  if (!landed || hostOf(landed.url || '') !== hostOf(url)) {
    throw new Error('left the tab open for you. log in there if it asks, then try again');
  }
  const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeLinksInTab, args: [cfg] });
  const result = out && out[0] && out[0].result;
  if (result && result.error) throw new Error(result.error);
  const rows = (result && result.rows) || [];
  // Any failure leaves the tab open: a login wall or a broken page is
  // something the user can see and fix, then click import again and the same
  // tab gets reused. Only success closes it, and only if we opened it.
  if (!rows.length) {
    const seen = (result && typeof result.anchors === 'number') ? result.anchors : 0;
    throw new Error('left the tab open for you. log in there if it asks, then try again (' + seen + ' links seen)');
  }
  if (ours) { try { chrome.tabs.remove(tab.id); } catch (e) {} await setImportTab(platform, null); }
  return rows;
}

// {arg} is replaced by what the user typed. join/joinFallback builds values
// like lemmy's name@instance. drop lists site chrome paths that would
// otherwise be read as usernames.
const SCRAPES = {
  tiktok: {
    url: 'https://www.tiktok.com/@{arg}',
    arg: /^[A-Za-z0-9._]{1,24}$/, argName: 'a tiktok handle',
    click: '[data-e2e="following-count"]', clickText: 'Following',
    scope: 'modal', wait: 'a[href^="/@"]',
    links: ['^/@([A-Za-z0-9._]{1,24})/?$'],
  },
  youtube: {
    url: 'https://www.youtube.com/feed/channels',
    window: true, wait: 'a[href^="/@"], a[href^="/channel/"]',
    links: [
      { re: '^/@([A-Za-z0-9._-]{2,64})/?$', pre: '@' },
      { re: '^/channel/(UC[A-Za-z0-9_-]{22})/?$', pre: '' },
      { re: '^/c/([A-Za-z0-9._-]{2,64})/?$', pre: '@' },
      { re: '^/user/([A-Za-z0-9._-]{2,64})/?$', pre: '@' },
    ],
  },
  reddit: {
    // old.reddit still serves the subscription list as plain HTML.
    url: 'https://old.reddit.com/subreddits/mine/',
    window: true, wait: 'a[href^="/r/"]',
    links: [{ re: '^/r/([A-Za-z0-9_]{2,21})/?$', pre: 'r/' }],
    drop: ['all', 'popular', 'mod', 'create', 'coins', 'premium'],
  },
  twitch: {
    url: 'https://www.twitch.tv/subscriptions',
    window: true, wait: 'a[href^="/"]',
    links: ['^/([a-zA-Z0-9_]{3,25})/?$'],
    drop: ['subscriptions', 'directory', 'settings', 'wallet', 'inventory', 'drops', 'store', 'prime', 'turbo', 'search', 'login', 'signup', 'downloads', 'p', 'jobs', 'help', 'privacy', 'terms', 'about', 'blog', 'press', 'partners', 'advertise', 'dev', 'security', 'legal', 'activate', 'redeem', 'friends', 'messages', 'dashboard', 'moderator', 'creator', 'popout', 'embed', 'videos', 'clips', 'collections', 'events', 'music', 'subs', 'gifts', 'loot', 'whispers', 'notifications', 'following'],
  },
  tumblr: {
    url: 'https://www.tumblr.com/following',
    window: true, wait: 'a[href]',
    links: ['^https://([a-zA-Z0-9-]+)\\.tumblr\\.com/?$', '^https://www\\.tumblr\\.com/([a-zA-Z0-9-]+)/?$'],
    drop: ['www', 'explore', 'dashboard', 'blog', 'new', 'settings', 'following', 'followers', 'likes', 'inbox', 'search', 'tagged', 'policy', 'about', 'apps', 'help', 'register', 'login', 'jobs', 'press', 'staff', 'changes', 'theme', 'messages', 'activity', 'customize', 'docs', 'developers', 'legal', 'privacy', 'terms', 'shop', 'live', 'blaze', 'tips', 'text', 'photo', 'link', 'quote', 'chat', 'audio', 'video', 'ask'],
  },
  pinterest: {
    url: 'https://www.pinterest.com/{arg}/following/',
    arg: /^[A-Za-z0-9_]{2,30}$/, argName: 'a pinterest username',
    window: true, wait: 'a[href]',
    links: ['^/([A-Za-z0-9_]{2,30})/?$'],
    drop: ['ideas', 'search', 'settings', 'notifications', 'messages', 'pin-builder', 'today', 'watch', 'shop', 'about', 'business', 'blog', 'careers', 'developers', 'privacy', 'terms', 'help', 'login', 'signup', 'password', 'find-friends', 'following', 'followers', 'homefeed', 'news', 'videos', 'boards', 'pins', 'saved', 'created', 'analytics', 'ads', 'policy', 'engineering', 'brand', 'community', 'discovery'],
  },
  substack: {
    url: 'https://substack.com/@{arg}',
    arg: /^[A-Za-z0-9._-]{2,32}$/, argName: 'a substack handle',
    click: 'a[href$="/following"]', window: true, wait: 'a[href^="/@"]',
    links: ['^/@([A-Za-z0-9._-]{2,32})/?$'],
  },
  note: {
    url: 'https://note.com/{arg}/following',
    arg: /^[a-zA-Z0-9_]{3,16}$/, argName: 'a note.com username',
    window: true, wait: 'a[href]',
    links: ['^/([a-zA-Z0-9_]{3,16})/?$'],
    drop: ['hashtag', 'm', 'event', 'official', 'info', 'help', 'search', 'membership', 'magazine', 'n', 'premium', 'settings', 'notifications', 'about', 'terms', 'login', 'signup', 'go', 'embed', 'api', 'explore', 'following', 'followers', 'law', 'privacy', 'tokushoho', 'inquiry', 'contact', 'corp', 'creators'],
  },
  deviantart: {
    url: 'https://www.deviantart.com/{arg}/about',
    arg: /^[a-zA-Z0-9-]{2,20}$/, argName: 'a deviantart username',
    click: 'a[href*="watching"]', window: true, wait: 'a[href*=".deviantart.com"]',
    links: ['^https://([a-zA-Z0-9-]+)\\.deviantart\\.com/?$'],
    drop: ['www', 'about', 'jobs', 'shop', 'core', 'developers', 'advertise', 'help', 'support', 'policy', 'join', 'login', 'logout', 'watch', 'forum', 'groups', 'portfolio', 'prints', 'premium', 'sta', 'chat', 'daily', 'topics', 'whats-hot', 'status'],
  },
  lemmy: {
    // arg is you@instance; the url template gets both halves.
    url: 'https://{inst}/u/{arg}',
    arg: /^[A-Za-z0-9._-]{2,20}@[A-Za-z0-9.-]+\.[a-z]{2,}$/, argName: 'you@instance, like me@lemmy.world',
    click: 'a[href*="subscription" i]', window: true, wait: 'a[href^="/c/"]',
    links: [{ re: '^/c/([a-zA-Z0-9_.]+)(?:@([a-zA-Z0-9.-]+))?$', pre: '!' }], join: '@',
    drop: ['modlog', 'search', 'settings', 'login', 'signup', 'create_community', 'communities', 'donate', 'join-lemmy', 'instances', 'docs', 'code', 'legal', 'privacy', 'support', 'apps'],
  },
  threads: {
    url: 'https://www.threads.net/@{arg}',
    arg: /^[A-Za-z0-9._]{1,30}$/, argName: 'a threads handle',
    click: 'a[href*="following" i]', scope: 'modal', wait: 'a[href^="/@"]',
    links: ['^/@([A-Za-z0-9._]{1,30})/?$'],
  },
  kick: {
    url: 'https://kick.com/{arg}',
    arg: /^[a-zA-Z0-9_-]{3,25}$/, argName: 'a kick username',
    click: 'a[href*="following" i]', window: true, wait: 'a[href]',
    links: ['^/([a-zA-Z0-9_-]{3,25})/?$'],
    drop: ['categories', 'following', 'followers', 'videos', 'clips', 'settings', 'wallet', 'privacy', 'terms', 'about', 'help', 'login', 'signup', 'search', 'dashboard', 'subscriptions', 'messages', 'notifications', 'stream-manager', 'achievements', 'rules', 'guidelines', 'careers', 'press', 'merch', 'app', 'api', 'live', 'multiview', 'drops', 'store', 'download', 'creator'],
  },
  zenn: {
    url: 'https://zenn.dev/{arg}/following',
    arg: /^[a-zA-Z0-9_-]{2,50}$/, argName: 'a zenn username',
    window: true, wait: 'a[href]',
    links: ['^/([a-zA-Z0-9_-]{2,50})/?$'],
    drop: ['articles', 'books', 'scraps', 'explore', 'search', 'settings', 'login', 'signup', 'notifications', 'dashboard', 'about', 'faq', 'terms', 'privacy', 'media', 'tech', 'ideas', 'events', 'topics', 'api', 'mypage', 'feed', 'publications', 'enter', 'logout'],
  },
};

// {arg} is what the user typed. Returns the page url plus the lemmy instance
// half, which the scraper uses as joinFallback for bare community links.
// The lemmy url template embeds the instance from the arg, and an arbitrary
// host there would let a caller steer the open and scrape flow at any
// domain, so only known instances are accepted.
const LEMMY_INSTANCES = /^(lemmy\.world|lemm\.ee|lemmy\.ml|beehaw\.org|sh\.itjust\.works|programming\.dev|sopuli\.xyz|lemmy\.ca|feddit\.(de|nl|uk)|discuss\.tchncs\.de|lemmy\.one|lemmy\.today|lemmings\.world)$/i;
function scrapeUrl(platform, arg) {
  const cfg = SCRAPES[platform];
  if (!cfg) return null;
  let user = String(arg || '').trim().replace(/^@/, ''), inst = '';
  if (cfg.arg) {
    if (platform === 'lemmy' && cfg.arg.test(user)) {
      const parts = user.split('@');
      inst = parts.pop(); user = parts.join('@');
      if (!LEMMY_INSTANCES.test(inst)) throw new Error('unsupported lemmy instance');
    }
    if (!cfg.arg.test(platform === 'lemmy' ? user + '@' + inst : user)) {
      throw new Error('need ' + (cfg.argName || 'a username'));
    }
  }
  const url = cfg.url.replace('{arg}', encodeURIComponent(user)).replace('{inst}', encodeURIComponent(inst));
  return { url, inst };
}

function scrapeImporter(platform) {
  const cfg = SCRAPES[platform];
  return async (arg) => {
    const { url, inst } = scrapeUrl(platform, arg);
    return tabScrape(platform, url, Object.assign({}, cfg, { joinFallback: inst }));
  };
}

// Phase one of the two step import: just get the list page onto the screen so
// the user can see it and log in there. A tab already on that page is focused
// instead of duplicated.
async function openImportTab(platform, arg) {
  if (Date.now() - lastOpenAt < 2000) return { ok: false, error: 'slow down a moment' };
  const built = scrapeUrl(platform, arg);
  if (!built) return { ok: false, error: 'no page to open for ' + platform };
  lastOpenAt = Date.now();
  // The tracked tab wins: it may be parked on a login page on another domain,
  // and re-navigating it beats spawning a second tab. Otherwise only a tab
  // already on the exact list url is reused, other tabs on the site are the
  // user's business, not ours.
  const base = built.url.split('?')[0];
  let tab = await tabById(await importTabId(platform));
  if (!tab) {
    const all = await chrome.tabs.query({});
    tab = all.find((t) => t.url && t.url.indexOf(base) === 0);
  }
  if (tab) await chrome.tabs.update(tab.id, { url: built.url, active: true });
  else tab = await chrome.tabs.create({ url: built.url, active: true });
  await setImportTab(platform, tab.id);
  return { ok: true };
}

const IMPORTERS = {
  twitter: importTwitter, instagram: importInstagram,
  pixiv: importPixiv, letterboxd: importLetterboxd,
};
Object.keys(SCRAPES).forEach((p) => { IMPORTERS[p] = scrapeImporter(p); });

// import guardrails
// externally_connectable already pins which origins can reach us; this is the
// same list again so a manifest mistake never becomes an open door.
// Match patterns cannot carry ports, so the manifest allows localhost on
// every port. This check is narrower on purpose: only the dev server's own
// port is honored, so other local apps cannot drive the worker.
const ALLOWED_SENDERS = /^(https:\/\/onefeed\.online|http:\/\/localhost:8791|http:\/\/127\.0\.0\.1:8791)$/;
function senderAllowed(sender) {
  try { return ALLOWED_SENDERS.test(new URL((sender && (sender.origin || sender.url)) || '').origin); }
  catch (e) { return false; }
}

// One import at a time, with a breather between runs on the same platform. A
// hostile or buggy page should not be able to turn us into a scraper hammer.
const MAX_ROWS = 5000;
const MIN_GAP_MS = 4000;
const lastRun = {};
let importBusy = false;

// 'open' gets its own breather too: without one a caller could flood the
// user with tabs.
let lastOpenAt = 0;

async function runImport(msg, sendResponse, forPage) {
  const platform = String(msg.platform || '');
  const fn = IMPORTERS[platform];
  if (!fn) { sendResponse({ ok: false, error: 'unknown platform' }); return; }
  if (importBusy) { sendResponse({ ok: false, error: 'another import is already running' }); return; }
  const wait = MIN_GAP_MS - (Date.now() - (lastRun[platform] || 0));
  if (wait > 0) { sendResponse({ ok: false, error: 'give it a few seconds between imports' }); return; }
  importBusy = true;
  lastRun[platform] = Date.now();
  try {
    const rows = (await fn(msg.arg)).slice(0, MAX_ROWS);
    sendResponse({ ok: true, rows });
  } catch (e) {
    const err = String((e && e.message) || 'import failed');
    // Login wording names the platform's session state, which a page could
    // use as a fingerprint. Pages get a generic failure; the popup keeps
    // the detailed wording for the person holding it.
    sendResponse({ ok: false, error: forPage && /logged in|log in/i.test(err) ? 'import failed' : err });
  } finally {
    importBusy = false;
  }
}

// Which sessions look live, used by the popup to badge the buttons. A probe
// is a cookie that only exists while logged in; 'public' means no login is
// needed at all, 'tab' means the site keeps its token in localStorage where
// we cannot check it from here. Never answered for external callers.
const SESSION_PROBES = {
  twitter:    [['https://x.com', 'auth_token']],
  instagram:  [['https://www.instagram.com', 'sessionid']],
  tiktok:     [['https://www.tiktok.com', 'sessionid'], ['https://www.tiktok.com', 'sid_tt']],
  youtube:    [['https://www.youtube.com', 'LOGIN_INFO']],
  twitch:     [['https://www.twitch.tv', 'auth-token']],
  reddit:     [['https://www.reddit.com', 'token'], ['https://www.reddit.com', 'reddit_session']],
  tumblr:     [['https://www.tumblr.com', 'tumblr_auth'], ['https://www.tumblr.com', 'logged_in']],
  pinterest:  [['https://www.pinterest.com', '_pinterest_sess'], ['https://www.pinterest.com', '_auth']],
  substack:   [['https://www.substack.com', 'substack.sid'], ['https://substack.com', 'substack.sid']],
  threads:    [['https://www.threads.net', 'sessionid'], ['https://www.threads.net', 'th_cookies']],
  note:       [['https://note.com', '_note_session_v5']],
  deviantart: [['https://www.deviantart.com', 'auth'], ['https://www.deviantart.com', 'auth_secure']],
  pixiv:      [['https://www.pixiv.net', 'PHPSESSID']],
  kick:       [['https://kick.com', 'session'], ['https://kick.com', 'XSRF-TOKEN']],
  zenn:       [['https://zenn.dev', '_zenn']],
  lemmy:      [], // its jwt lives in localStorage, not a cookie
  letterboxd: [], // the following list is public
};

async function sessionStatus() {
  const out = {};
  for (const [p, probes] of Object.entries(SESSION_PROBES)) {
    if (!probes.length) { out[p] = p === 'lemmy' ? 'tab' : 'public'; continue; }
    let on = false;
    for (const [origin, name] of probes) { if (await cookieValue(origin, name)) { on = true; break; } }
    out[p] = on ? 'on' : 'off';
  }
  return out;
}

// Which scrape platforms already have a tab on their site, lets the popup
// reopen and still say 'import' rather than 'open' again.
async function openPlatforms() {
  const all = await chrome.tabs.query({});
  const out = {};
  for (const [p, cfg] of Object.entries(SCRAPES)) {
    // A template url ({inst} for lemmy) has no fixed base to match against,
    // so only the tracked tab counts for those.
    const hasTemplate = cfg.url.indexOf('{') !== -1;
    const base = cfg.url.split('{')[0].split('?')[0];
    out[p] = (await tabById(await importTabId(p)) != null) ||
      (!hasTemplate && all.some((t) => t.url && t.url.indexOf(base) === 0));
  }
  return out;
}

const VERSION = '1.2.7';

// Only so many relay requests run at once; the rest wait in a bounded queue.
// A burst from the site drains in order, and a hostile caller cannot open
// unlimited parallel requests through the user's connection.
const FETCH_INFLIGHT_MAX = 16;
const FETCH_QUEUE_MAX = 600;
let fetchInflight = 0;
const fetchQueue = [];
function fetchSlotAcquire() {
  if (fetchInflight < FETCH_INFLIGHT_MAX) { fetchInflight++; return Promise.resolve(true); }
  if (fetchQueue.length >= FETCH_QUEUE_MAX) return Promise.resolve(false);
  return new Promise((res) => fetchQueue.push(() => res(true)));
}
function fetchSlotRelease() {
  const next = fetchQueue.shift();
  if (next) next(); else fetchInflight--;
}

// Reads the body while counting bytes, so an oversized response is cut off
// mid stream instead of buffering fully and being refused afterwards.
async function readBodyCapped(res) {
  const len = +(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('response too large');
  if (!res.body) {
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('response too large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.byteLength;
    if (size > MAX_BYTES) { try { await reader.cancel(); } catch (e) {} throw new Error('response too large'); }
    chunks.push(r.value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

// The plain GET relay. Shared by both message paths; caller has already
// checked the sender is allowed.
function doFetch(target, sendResponse) {
  if (!target || target.length > 2048) { sendResponse({ ok: false, error: 'bad url' }); return; }
  let u;
  try { u = new URL(target); } catch (e) { sendResponse({ ok: false, error: 'bad url' }); return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { sendResponse({ ok: false, error: 'bad scheme' }); return; }
  if (u.username || u.password) { sendResponse({ ok: false, error: 'bad url' }); return; }
  if (blockedHost(u.hostname)) { sendResponse({ ok: false, error: 'blocked host' }); return; }

  (async () => {
    if (!await fetchSlotAcquire()) { sendResponse({ ok: false, error: 'too many requests queued' }); return; }
    try {
      // Twitter only, only when you've switched it on: ask as the logged-in
      // you, which is the one way replies are readable. Everything else stays
      // credentials:'omit' and sends no cookies at all.
      const res = (USE_TWITTER_SESSION && isTwitterApi(u.hostname))
        ? await twitterSessionFetch(u)
        : await fetchFollow(u, {
            method: 'GET',
            credentials: 'omit',                 // never send the user's cookies
            headers: Object.assign({ accept: UA_ACCEPT }, extraHeaders(u.hostname) || {}),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          }, false);
      const text = await readBodyCapped(res);
      sendResponse({
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        body: text,
      });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || 'fetch failed') });
    } finally {
      fetchSlotRelease();
    }
  })();
}

// Internal callers: the popup, and the content-script bridge running on an
// allowlisted page. sender.url is the page's url for a content script and our
// own extension url for the popup, so both are checked the same way.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) { sendResponse({ ok: false, error: 'unknown request' }); return false; }
  const ownPage = /^chrome-extension:/.test(sender.url || '');
  if (!ownPage && !senderAllowed(sender)) { sendResponse({ ok: false, error: 'sender not allowed' }); return false; }
  if (msg.type === 'onefeed-ping') { sendResponse({ ok: true, version: VERSION }); return false; }
  if (msg.type === 'onefeed-status') {
    // Session detection stays private to the popup; pages never get it.
    if (!ownPage) { sendResponse({ ok: false, error: 'not for pages' }); return false; }
    Promise.all([sessionStatus(), openPlatforms()])
      .then(([s, o]) => sendResponse({ ok: true, sessions: s, open: o }))
      .catch(() => sendResponse({ ok: true, sessions: {}, open: {} }));
    return true;
  }
  if (msg.type === 'onefeed-import') { runImport(msg, sendResponse, !ownPage); return true; }
  if (msg.type === 'onefeed-open') {
    openImportTab(String(msg.platform || ''), msg.arg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || 'could not open the page') }));
    return true;
  }
  if (msg.type === 'onefeed-fetch') { doFetch(String(msg.url || ''), sendResponse); return true; }
  sendResponse({ ok: false, error: 'unknown request' });
  return false;
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // Only the origins listed in manifest.json can even reach this, but be strict
  // about what we'll do for them regardless.
  if (!msg || (msg.type !== 'onefeed-fetch' && msg.type !== 'onefeed-import' && msg.type !== 'onefeed-open')) {
    if (msg && msg.type === 'onefeed-ping') { sendResponse({ ok: true, version: VERSION }); return false; }
    sendResponse({ ok: false, error: 'unknown request' });
    return false;
  }
  if (!senderAllowed(sender)) { sendResponse({ ok: false, error: 'sender not allowed' }); return false; }

  if (msg.type === 'onefeed-import') { runImport(msg, sendResponse, true); return true; }
  if (msg.type === 'onefeed-open') {
    openImportTab(String(msg.platform || ''), msg.arg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || 'could not open the page') }));
    return true;
  }
  doFetch(String(msg.url || ''), sendResponse);
  return true; // keep the message channel open for the async reply
});
