'use strict';
/*
 * Next-meeting source for the AI Usage plugin.
 *
 * Reads the user's own calendars on this Mac and works out what happens next.
 *
 * The fast path is a small helper app ("KeithAI Calendar Helper") that uses
 * EventKit to read the calendar database directly. It answers in milliseconds
 * and it expands recurring series, so the weekly 5pm yoga class shows up as a
 * real occurrence instead of the series master it is stored as.
 *
 * The helper has to be started through LaunchServices ("open") rather than run
 * directly: macOS only lets a launched app ask for calendar access on its own
 * behalf, and a direct run gets refused without a prompt.
 *
 * There is also a slower path that talks to Calendar.app over Apple Events.
 * It is kept as a fallback for when the helper is missing or has lost its
 * permission. Calendar.app evaluates a "whose" filter by building every event
 * in the calendar one at a time, roughly 50 ms per event, so that path takes
 * minutes on a large calendar and its results are cached on disk.
 *
 * Config in ~/.ulanzi/stats.json (mode 600):
 *
 *   {
 *     "calendar": {
 *       "source": "mac",              // mac | google | both
 *       "token": "<google token>",    // optional
 *       "clientId": "...", "clientSecret": "...", "refreshToken": "..."
 *     }
 *   }
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const credentials = require('./credentials.js');

const TTL_MS = 60 * 1000;            // how fresh the readout has to be
const HELPER_BUNDLE = path.join(os.homedir(), '.ulanzi', 'calendar-helper', 'KeithAI Calendar Helper.app');
const HELPER_RESULT = path.join(os.homedir(), '.ulanzi', 'calendar-helper', 'last.json');
const HELPER_TIMEOUT_MS = 30 * 1000;
const APPLE_SCRIPT_TIMEOUT_MS = 900 * 1000;
const APPLE_RETRY_MS = 15 * 60 * 1000;  // do not hammer the slow path
const CACHE_FILE = path.join(os.homedir(), '.ulanzi', 'calendar-cache.json');

const CACHE = {
    state: 'unknown',
    start: null,          // Date
    title: '',
    calendar: '',
    allDay: false,
    method: null,
    at: 0,
};

let SCAN = null;
let lastAppleAttempt = 0;

/* ------------------------------------------------------------- helper app */

/**
 * Starts the helper through LaunchServices and waits for its answer.
 * @returns {Promise<object|null>}
 */
function runHelper() {
    return new Promise((resolve) => {
        if (!fs.existsSync(HELPER_BUNDLE)) return resolve(null);
        const startedAt = Math.floor(Date.now() / 1000);

        execFile(
            '/usr/bin/open',
            ['-W', HELPER_BUNDLE],
            { timeout: HELPER_TIMEOUT_MS },
            () => {
                // "open -W" waits for the app to quit, but the result file is
                // written just before it exits, so allow a moment of slack.
                readHelperResult(startedAt, resolve);
            }
        );
    });
}

function readHelperResult(startedAt, done) {
    let attempts = 0;
    let lastSeen = null;
    const tick = () => {
        attempts += 1;
        try {
            const raw = fs.readFileSync(HELPER_RESULT, 'utf8');
            const json = JSON.parse(raw);
            if (json && json.status) {
                lastSeen = json;
                const fresh = json.at ? json.at >= startedAt - 5 : true;
                if (fresh) return done(json);
            }
        } catch (e) {
            /* not written yet */
        }
        // Give up after the wait, but fall back on the last answer we saw
        // rather than nothing at all.
        if (attempts > 40) return done(lastSeen);
        setTimeout(tick, 500);
    };
    tick();
}

function applyHelper(json) {
    if (!json) return false;

    if (json.status === 'ok' && json.epoch) {
        CACHE.start = new Date(json.epoch * 1000);
        CACHE.title = json.title || '';
        CACHE.calendar = json.calendar || '';
        CACHE.allDay = !!json.allDay;
        CACHE.method = 'eventkit';
        CACHE.state = 'ok';
        CACHE.at = Date.now();
        saveDiskCache();
        return true;
    }

    if (json.status === 'none') {
        CACHE.start = null;
        CACHE.title = '';
        CACHE.calendar = '';
        CACHE.allDay = false;
        CACHE.method = 'eventkit';
        CACHE.state = 'ok';
        CACHE.at = Date.now();
        saveDiskCache();
        return true;
    }

    return false;
}

/* ------------------------------------------------------------- AppleScript */

/*
 * Emits one line per interesting event:
 *   calendar <tab> YYYY-MM-DD HH:MM <tab> title <tab> recurrence
 *
 * "Interesting" means it starts in the future, or it repeats (a series
 * master, whose own start date may be long past).
 */
const APPLESCRIPT = `
set out to ""
set now to current date
set tabc to character id 9
with timeout of 900 seconds
  tell application "Calendar"
    repeat with cal in calendars
      set calName to (name of cal)
      try
        set evs to (every event of cal whose (start date > now) or (recurrence starts with "FREQ"))
        repeat with ev in evs
          set s to missing value
          try
            set s to start date of ev
          end try
          if s is not missing value then
            set r to missing value
            try
              set r to recurrence of ev
            end try
            set t to ""
            try
              set t to summary of ev
            end try
            set rs to ""
            if r is not missing value then set rs to r as string
            set out to out & calName & tabc & (year of s) & "-" & (month of s) & "-" & (day of s) & " " & (hours of s) & ":" & (minutes of s) & tabc & t & tabc & rs & linefeed
          end if
        end repeat
      end try
    end repeat
  end tell
end timeout
return out
`;

function runAppleScript() {
    return new Promise((resolve, reject) => {
        execFile(
            '/usr/bin/osascript',
            ['-e', APPLESCRIPT],
            { timeout: APPLE_SCRIPT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' },
            (err, stdout) => {
                if (err && !stdout) return reject(new Error(String(err.message || err)));
                resolve(String(stdout || ''));
            }
        );
    });
}

/* -------------------------------------------------------- recurrence maths */

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(rule) {
    const out = {};
    for (const kv of String(rule || '').split(';')) {
        const i = kv.indexOf('=');
        if (i < 0) continue;
        out[kv.slice(0, i).trim().toUpperCase()] = kv.slice(i + 1).trim();
    }
    return out;
}

function parseUntil(v) {
    // 20260901T170000Z or 20260901
    const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

function startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (x.getDay() + 6) % 7; // Monday based
    x.setDate(x.getDate() - dow);
    return x;
}

function dayDiff(a, b) {
    return Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) -
        new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

/**
 * Does the candidate day fall on the recurrence?
 */
function matchesRule(r, start, cand) {
    const freq = (r.FREQ || '').toUpperCase();
    const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
    const byDay = r.BYDAY
        ? r.BYDAY.split(',').map((s) => DOW[s.replace(/[^A-Za-z]/g, '').toUpperCase()]).filter((n) => n !== undefined)
        : null;

    if (freq === 'DAILY') {
        return dayDiff(start, cand) % interval === 0;
    }
    if (freq === 'WEEKLY') {
        const weekIndex = Math.floor(dayDiff(startOfWeek(start), startOfWeek(cand)) / 7);
        if (weekIndex < 0 || weekIndex % interval !== 0) return false;
        if (byDay && byDay.length) {
            // DOW is Sunday-based (SU=0), so use getDay() directly.
            return byDay.includes(cand.getDay());
        }
        return cand.getDay() === start.getDay();
    }
    if (freq === 'MONTHLY') {
        const monthDiff = (cand.getFullYear() - start.getFullYear()) * 12 + (cand.getMonth() - start.getMonth());
        if (monthDiff < 0 || monthDiff % interval !== 0) return false;
        if (r.BYMONTHDAY) {
            const days = r.BYMONTHDAY.split(',').map(Number);
            return days.includes(cand.getDate());
        }
        return cand.getDate() === start.getDate();
    }
    if (freq === 'YEARLY') {
        const yearDiff = cand.getFullYear() - start.getFullYear();
        if (yearDiff < 0 || yearDiff % interval !== 0) return false;
        return cand.getMonth() === start.getMonth() && cand.getDate() === start.getDate();
    }
    return false;
}

/**
 * The next time this event happens, on or after `now`.
 * @returns {Date|null}
 */
function nextOccurrence(start, rule, now, horizonDays = 420) {
    if (!rule) return start >= now ? start : null;
    const r = parseRRule(rule);
    if (!r.FREQ) return start >= now ? start : null;

    const until = r.UNTIL ? parseUntil(r.UNTIL) : null;
    if (until && until < now) return null;

    const hh = start.getHours();
    const mm = start.getMinutes();
    const limit = new Date(now.getTime() + horizonDays * 86400000);

    for (let d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); d <= limit; d.setDate(d.getDate() + 1)) {
        const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
        if (cand < now) continue;
        if (until && cand > until) return null;
        if (!matchesRule(r, start, cand)) continue;

        if (r.COUNT) {
            // The series may have a limited number of occurrences.
            const limitCount = parseInt(r.COUNT, 10);
            let n = 0;
            let s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
            for (; s <= cand && n <= limitCount; s.setDate(s.getDate() + 1)) {
                const c2 = new Date(s.getFullYear(), s.getMonth(), s.getDate(), hh, mm, 0, 0);
                if (matchesRule(r, start, c2)) n++;
            }
            if (n > limitCount) return null;
        }
        return cand;
    }
    return null;
}

/* ------------------------------------------------------------- scan + cache */

function parseLines(raw) {
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 2) continue;
        const cal = parts[0];
        const dm = parts[1].match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
        if (!dm) continue;
        const start = new Date(+dm[1], +dm[2] - 1, +dm[3], +dm[4], +dm[5]);
        if (Number.isNaN(start.getTime())) continue;
        const title = parts[2] === undefined ? '' : parts[2];
        const rule = parts[3] === undefined ? '' : parts[3];
        out.push({ calendar: cal, start, title, rule });
    }
    return out;
}

function pickNext(events, now) {
    let best = null;
    for (const ev of events) {
        const when = nextOccurrence(ev.start, ev.rule, now);
        if (!when) continue;
        if (!best || when < best.start) {
            best = { start: when, title: ev.title, calendar: ev.calendar, allDay: false };
        }
    }
    return best;
}

function loadDiskCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (!raw || !raw.start) return;
        CACHE.start = new Date(raw.start);
        CACHE.title = raw.title || '';
        CACHE.calendar = raw.calendar || '';
        CACHE.allDay = !!raw.allDay;
        CACHE.method = raw.method || 'eventkit';
        CACHE.state = 'ok';
        CACHE.at = raw.at || 0;
    } catch (e) {
        /* no usable cache */
    }
}

function saveDiskCache() {
    try {
        const payload = {
            start: CACHE.start ? CACHE.start.toISOString() : null,
            title: CACHE.title,
            calendar: CACHE.calendar,
            allDay: CACHE.allDay,
            method: CACHE.method,
            at: CACHE.at,
        };
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
        fs.chmodSync(CACHE_FILE, 0o600);
    } catch (e) {
        /* best effort only */
    }
}

/* ---------------------------------------------------------- Google path */

function calendarConfig() {
    const cfg = credentials.section('calendar');
    const ga = credentials.section('ga');
    return {
        source: String(cfg.source || 'mac').trim().toLowerCase(),
        token: String(cfg.token || '').trim(),
        clientId: String(cfg.clientId || ga.clientId || '').trim(),
        clientSecret: String(cfg.clientSecret || ga.clientSecret || '').trim(),
        refreshToken: String(cfg.refreshToken || ga.refreshToken || '').trim(),
        calendarId: String(cfg.calendarId || 'primary').trim(),
    };
}

async function accessToken(cfg) {
    if (cfg.token) return cfg.token;
    if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) return null;
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            refresh_token: cfg.refreshToken,
            grant_type: 'refresh_token',
        }).toString(),
        signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error('google token refresh failed');
    return json.access_token;
}

function firstEventFrom(json) {
    let fallback = null;
    for (const item of json.items || []) {
        if (item.status === 'cancelled') continue;
        const when = item.start && (item.start.dateTime || item.start.date);
        if (!when) continue;
        const allDay = !!(item.start && item.start.date);
        const start = allDay ? new Date(when + 'T00:00:00') : new Date(when);
        if (Number.isNaN(start.getTime())) continue;
        if (allDay) {
            if (!fallback) fallback = { start, title: item.summary || '', calendar: '', allDay: true };
            continue;
        }
        return { start, title: item.summary || '', calendar: '', allDay: false };
    }
    return fallback;
}

async function fetchFromGoogle(cfg) {
    const token = await accessToken(cfg);
    if (!token) return null;
    const headers = { Authorization: 'Bearer ' + token };

    let ids = [cfg.calendarId];
    try {
        const res = await fetch(
            'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=50',
            { headers, signal: AbortSignal.timeout(15000) }
        );
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.items && json.items.length) ids = json.items.map((c) => c.id);
    } catch (e) {
        /* keep the single-calendar fallback */
    }

    const timeMin = encodeURIComponent(new Date().toISOString());
    const results = await Promise.all(ids.map(async (id) => {
        try {
            const url = 'https://www.googleapis.com/calendar/v3/calendars/' +
                encodeURIComponent(id) + '/events?timeMin=' + timeMin +
                '&singleEvents=true&orderBy=startTime&maxResults=10';
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }));

    let best = null;
    let bestAllDay = null;
    for (const json of results) {
        if (!json) continue;
        const ev = firstEventFrom(json);
        if (!ev) continue;
        if (ev.allDay) {
            if (!bestAllDay || ev.start < bestAllDay.start) bestAllDay = ev;
        } else if (!best || ev.start < best.start) {
            best = ev;
        }
    }
    return best || bestAllDay;
}

/* --------------------------------------------------------------- refresh */

async function scanApple() {
    const cfg = calendarConfig();
    const now = new Date();
    let data = null;
    let method = null;

    if ((cfg.source === 'google' || cfg.source === 'both') &&
        (cfg.token || (cfg.clientId && cfg.clientSecret && cfg.refreshToken))) {
        try {
            data = await fetchFromGoogle(cfg);
            method = 'google';
        } catch (e) {
            CACHE.error = String((e && e.message) || e);
        }
    }

    if (cfg.source === 'mac' || cfg.source === 'both' || !data) {
        try {
            const raw = await runAppleScript();
            const mac = pickNext(parseLines(raw), now);
            if (mac && (!data || mac.start < data.start)) {
                data = mac;
                method = 'applescript';
            } else if (!data) {
                data = mac;
                method = 'applescript';
            }
        } catch (e) {
            CACHE.error = String((e && e.message) || e);
        }
    }

    if (!data) {
        if (CACHE.state !== 'ok') CACHE.state = 'error';
        CACHE.at = Date.now();
        return false;
    }

    CACHE.start = data.start;
    CACHE.title = data.title || '';
    CACHE.calendar = data.calendar || '';
    CACHE.allDay = !!data.allDay;
    CACHE.method = method;
    CACHE.state = 'ok';
    CACHE.at = Date.now();
    saveDiskCache();
    return true;
}

async function scan() {
    const cfg = calendarConfig();

    // Fast path first: the helper reads the calendar database directly.
    if (cfg.source === 'mac' || cfg.source === 'both' || cfg.source === 'auto') {
        try {
            const json = await runHelper();
            if (applyHelper(json)) return true;
            CACHE.error = 'helper unavailable or not permitted';
        } catch (e) {
            CACHE.error = String((e && e.message) || e);
        }
    }

    // Fallback: talk to Calendar.app, which is slow, so do not do it more
    // often than the retry window.
    const sinceAttempt = Date.now() - lastAppleAttempt;
    if (sinceAttempt < APPLE_RETRY_MS) return false;
    lastAppleAttempt = Date.now();
    return scanApple();
}

/**
 * @param {string[]} modes any of name | until | time
 */
async function refresh(modes) {
    loadDiskCache();
    if (CACHE.state === 'ok' && Date.now() - CACHE.at < TTL_MS) return;

    // The helper answers in milliseconds, but the slow fallback can take
    // minutes, so it runs in the background and the button keeps showing the
    // last known answer until a new one lands.
    if (!SCAN) {
        SCAN = scan()
            .catch((e) => {
                CACHE.error = String((e && e.message) || e);
            })
            .finally(() => { SCAN = null; });
    }
}

/* -------------------------------------------------------------- format */

function countdown(target) {
    const ms = target - Date.now();
    if (ms <= 0) return 'now';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    const hours = Math.floor(mins / 60);
    if (hours < 24) {
        const rem = mins % 60;
        return rem ? hours + 'h ' + rem + 'm' : hours + 'h';
    }
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH ? days + 'd ' + remH + 'h' : days + 'd';
}

function clockTime(d) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

function shortTitle(t) {
    const s = String(t || '').trim();
    if (!s) return '';
    return s.length > 18 ? s.slice(0, 18) + '…' : s;
}

/**
 * "Today 5:00 PM" / "Tomorrow 5:00 PM" / "Wed 2:30 PM" / "12 Nov 9:00 PM"
 */
function whenLabel(d) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const days = Math.round((startOfTarget - startOfToday) / 86400000);
    const time = clockTime(d);

    if (days <= 0) return 'Today ' + time;
    if (days === 1) return 'Tomorrow ' + time;
    if (days < 7) {
        const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
        return dow + ' ' + time;
    }
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + time;
}

function urgencyColor(target) {
    const ms = target - Date.now();
    if (ms < 15 * 60 * 1000) return '#F87171';
    if (ms < 2 * 60 * 60 * 1000) return '#FBBF24';
    return '#34D399';
}

/**
 * @param {string} mode name | until | time
 * @returns {{value:string, color:string, label:string}}
 */
function resolve(mode) {
    const m = String(mode || 'name').toLowerCase();

    if (CACHE.state === 'unknown') return { value: '...', color: '#FBBF24', label: 'Next Meeting' };
    if (CACHE.state === 'error') return { value: 'CAL?', color: '#F87171', label: 'Next Meeting' };
    if (!CACHE.start) return { value: 'FREE', color: '#34D399', label: 'Next Meeting' };

    const label = CACHE.title ? 'Next: ' + shortTitle(CACHE.title) : 'Next Meeting';

    if (m === 'until') {
        return { value: countdown(CACHE.start), color: urgencyColor(CACHE.start), label };
    }
    if (m === 'time') {
        return { value: clockTime(CACHE.start), color: urgencyColor(CACHE.start), label };
    }
    // Default: the name of the event is the big text, the time above it.
    return {
        value: CACHE.title ? shortTitle(CACHE.title) : '---',
        color: urgencyColor(CACHE.start),
        label: whenLabel(CACHE.start),
    };
}

/* ---------------------------------------------------------------- press */

/**
 * The button keeps whatever job it had: opening an app on press.
 * @param {{Opens?:string}} settings
 */
function openApp(settings) {
    const target = String((settings && (settings.Opens || settings.opens)) || '/Applications/ChatGPT.app/').trim();
    return new Promise((resolve) => {
        execFile('/usr/bin/open', [target], (err) => {
            resolve({ ok: !err, target, error: err ? String(err.message) : null });
        });
    });
}

// Start with whatever was known from the last run, so the button shows a real
// answer straight away instead of "..." while the first refresh runs.
loadDiskCache();

module.exports = {
    MODES: { name: 'Event name', until: 'Time until next meeting', time: 'Clock time' },
    TTL_MS,
    CACHE,
    CACHE_FILE,
    HELPER_BUNDLE,
    HELPER_RESULT,
    resolve,
    refresh,
    openApp,
    // exported for the unit tests
    _internal: { parseRRule, nextOccurrence, matchesRule, parseLines, pickNext, applyHelper },
};
