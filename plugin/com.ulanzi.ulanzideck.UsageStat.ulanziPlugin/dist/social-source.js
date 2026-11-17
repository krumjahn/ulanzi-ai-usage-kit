'use strict';
/*
 * Social follower count source for the AI Usage plugin.
 *
 * Two ways to get the number:
 *   1. Graph API — exact, but needs a Meta access token that expires.
 *   2. Headless Chrome render of the public profile — no credentials at all,
 *      which may fail when the public page changes.
 *
 * The API is tried first when a token is present; if it fails, the scrape
 * takes over instead of the button showing KEY? / BADKEY.
 *
 * Config in ~/.ulanzi/stats.json (mode 600):
 *
 *   {
 *     "social": {
 *       "platform": "threads",          // threads | instagram
 *       "token": "<long-lived token>",  // optional
 *       "userId": "<threads_user_id>",  // optional, for the API
 *       "handle": "your-handle",        // username, used by the scrape
 *       "label": "Threads"              // optional button label
 *     }
 *   }
 *
 * Threads:  GET https://graph.threads.net/v1.0/{userId}?fields=followers_count
 * Instagram: GET https://graph.facebook.com/v21.0/{userId}?fields=followers_count
 *
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const credentials = require('./credentials.js');

const TTL_API_MS = 300 * 1000;
const TTL_SCRAPE_MS = 30 * 60 * 1000;

const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const CACHE = {
    state: 'unknown',
    followers: null,
    username: null,
    platform: null,
    method: null,
    at: 0,
};

function platformConfig() {
    const social = credentials.section('social');
    const platform = String(social.platform || 'threads').toLowerCase();
    return {
        platform,
        token: String(social.token || '').trim(),
        userId: String(social.userId || '').trim(),
        handle: String(social.handle || '').trim().replace(/^@/, ''),
        label: String(social.label || '').trim(),
    };
}

function profileUrl(cfg) {
    const handle = encodeURIComponent(cfg.handle);
    return cfg.platform === 'instagram'
        ? `https://www.instagram.com/${handle}/`
        : `https://www.threads.com/@${handle}`;
}

/* ------------------------------------------------------------------ API */

async function fetchFollowersApi(cfg) {
    const isThreads = cfg.platform === 'threads';
    const host = isThreads ? 'https://graph.threads.net' : 'https://graph.facebook.com';
    const version = isThreads ? 'v1.0' : 'v21.0';

    const url = `${host}/${version}/${encodeURIComponent(cfg.userId)}` +
        `?fields=followers_count,username,name`;

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = (json.error && json.error.message) || `http ${res.status}`;
        throw new Error(msg);
    }
    const followers = Number(json.followers_count);
    return {
        followers: Number.isFinite(followers) ? followers : null,
        username: json.username || json.name || null,
    };
}

/* --------------------------------------------------------------- scrape */

function findChrome() {
    for (const p of CHROME_CANDIDATES) {
        try {
            fs.accessSync(p, fs.constants.X_OK);
            return p;
        } catch (e) {
            /* try the next one */
        }
    }
    return null;
}

function parseCount(html) {
    // Meta renders the exact number in a title attribute right next to the
    // word "followers" (e.g. <span title="11,894">11.8K</span> followers).
    const re = /title="([\d,]{2,})"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const around = html.slice(Math.max(0, m.index - 150), m.index + 280);
        if (/followers/i.test(around)) {
            const n = Number(m[1].replace(/,/g, ''));
            if (Number.isFinite(n)) return n;
        }
    }
    // Fallback: the og:description meta tag carries a rounded count.
    const og = html.match(/og:description"[^>]*content="([\d.,]+)\s*[KM]?\s*Followers/i);
    if (og) {
        const raw = og[1].replace(/,/g, '');
        const mult = /[kK]$/.test(raw) ? 1000 : /[mM]$/.test(raw) ? 1000000 : 1;
        const n = parseFloat(raw) * mult;
        if (Number.isFinite(n)) return Math.round(n);
    }
    return null;
}

function renderWithChrome(url) {
    const chrome = findChrome();
    if (!chrome) return Promise.reject(new Error('no chrome installed'));

    // A private profile per run: Chrome refuses to share one profile between
    // two instances, and the deck may refresh while another headless run is
    // still shutting down.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-social-chrome-'));
    const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--virtual-time-budget=12000',
        '--user-data-dir=' + userDataDir,
        '--dump-dom',
        url,
    ];

    return new Promise((resolve, reject) => {
        execFile(
            chrome,
            args,
            { timeout: 60000, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' },
            (err, stdout) => {
                try {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                } catch (e) {
                    /* best effort only */
                }
                if (err && !stdout) return reject(new Error(err.message));
                resolve(String(stdout || ''));
            }
        );
    });
}

async function fetchFollowersScrape(cfg) {
    const html = await renderWithChrome(profileUrl(cfg));
    const followers = parseCount(html);
    if (followers === null) throw new Error('could not find a follower count in the rendered page');
    return { followers, username: cfg.handle || null };
}

/* --------------------------------------------------------------- refresh */

async function refresh(modes) {
    const cfg = platformConfig();
    const canApi = Boolean(cfg.token && cfg.userId);
    const canScrape = Boolean(cfg.handle);

    if (!canApi && !canScrape) {
        // There is no key to add and no key to fix: all that is missing is
        // the username, so say so.
        CACHE.state = 'nohandle';
        CACHE.at = Date.now();
        return;
    }

    const ttl = CACHE.method === 'scrape' ? TTL_SCRAPE_MS : TTL_API_MS;
    if (CACHE.state === 'ok' && Date.now() - CACHE.at < ttl) return;

    if (canApi) {
        try {
            const data = await fetchFollowersApi(cfg);
            if (data.followers === null) {
                CACHE.state = 'nodata';
            } else {
                CACHE.followers = data.followers;
                CACHE.username = data.username;
                CACHE.platform = cfg.platform;
                CACHE.method = 'api';
                CACHE.state = 'ok';
            }
            CACHE.at = Date.now();
            return;
        } catch (e) {
            const msg = String((e && e.message) || e);
            CACHE.error = msg;
            if (!canScrape) {
                CACHE.state = /session has been invalidated|invalid.*token|unauthorized|oauth|permission|support|login/i.test(msg)
                    ? 'badkey'
                    : 'error';
                CACHE.at = Date.now();
                return;
            }
            // Token is unusable — fall through to the credential-free scrape.
        }
    }

    try {
        const data = await fetchFollowersScrape(cfg);
        CACHE.followers = data.followers;
        CACHE.username = data.username;
        CACHE.platform = cfg.platform;
        CACHE.method = 'scrape';
        CACHE.state = 'ok';
        CACHE.at = Date.now();
    } catch (e) {
        const msg = String((e && e.message) || e);
        CACHE.state = /no chrome|could not find/i.test(msg) ? 'nodata' : 'error';
        CACHE.error = msg;
        CACHE.at = Date.now();
    }
}

/* --------------------------------------------------------------- format */

function formatCount(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * @param {string} mode followers | username
 * @returns {{value:string, color:string, label:string}}
 */
function resolve(mode) {
    const cfg = platformConfig();
    const fallbackLabel = cfg.platform === 'instagram' ? 'Instagram' : 'Threads';
    const label = cfg.label || fallbackLabel;

    if (CACHE.state === 'unknown') return { value: '...', color: '#FBBF24', label };
    if (CACHE.state === 'nohandle') return { value: 'HANDLE?', color: '#F87171', label };
    if (CACHE.state === 'nokey') return { value: 'KEY?', color: '#F87171', label };
    if (CACHE.state === 'badkey') return { value: 'BADKEY', color: '#F87171', label };
    if (CACHE.state === 'error') return { value: 'ERR', color: '#F87171', label };
    if (CACHE.state === 'nodata') return { value: 'N/A', color: '#FBBF24', label };

    const m = String(mode || 'followers').toLowerCase();
    if (m === 'username') {
        return { value: CACHE.username || '---', color: '#FBBF24', label };
    }
    return { value: formatCount(CACHE.followers) || '---', color: '#F87171', label };
}

module.exports = {
    MODES: { followers: 'Follower count', username: 'Account name' },
    TTL_MS: TTL_API_MS,
    TTL_SCRAPE_MS,
    CACHE,
    refresh,
    resolve,
    formatCount,
    platformConfig,
    parseCount,
};
