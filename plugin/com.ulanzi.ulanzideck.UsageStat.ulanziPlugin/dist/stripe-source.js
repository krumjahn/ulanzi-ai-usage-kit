'use strict';
/*
 * Stripe source for the AI Usage plugin.
 *
 * Needs a read-only restricted key from dashboard.stripe.com, stored in
 * ~/.ulanzi/stats.json (mode 600) as stripe.secretKey.
 *
 * The key is sent only to Stripe for authentication; it is not intentionally logged.
 *
 * Endpoints used (all readable by a restricted key with read access):
 *   GET /v1/balance                          -> available / pending balance
 *   GET /v1/charges?created[gte]=<unix>      -> income in a window
 *   GET /v1/refunds?created[gte]=<unix>      -> refunds in the same window
 *   GET /v1/subscriptions?status=active      -> active subscriber count
 *
 * One charges fetch over the month window serves both "today" and "month"
 * figures, with pagination up to 40 pages per list request.
 */

const credentials = require('./credentials.js');

const TTL_MS = 60 * 1000;
const API = 'https://api.stripe.com/v1';
const PAGE_LIMIT = 100;
const MAX_PAGES = 40;

// mode -> { state, value, raw, at }
const CACHE = {};

function startOfDay() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
}

function startOfMonth() {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
}

async function apiGet(path, key) {
    const res = await fetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (e) { /* non-json error body */ }
    if (!res.ok) {
        const msg = (json && json.error && json.error.message) || `http ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    return json;
}

// Walk a paginated list endpoint, returning every item.
async function listAll(path, key, since, extraParams) {
    const out = [];
    let starting_after = null;
    let pages = 0;

    while (pages < MAX_PAGES) {
        const params = [`limit=${PAGE_LIMIT}`];
        if (since !== undefined && since !== null) params.push(`created[gte]=${since}`);
        for (const p of (extraParams || [])) params.push(p);
        if (starting_after) params.push(`starting_after=${starting_after}`);
        const sep = path.includes('?') ? '&' : '?';

        const json = await apiGet(`${path}${sep}${params.join('&')}`, key);
        const data = Array.isArray(json.data) ? json.data : [];
        for (const item of data) out.push(item);

        pages++;
        if (!json.has_more || !data.length) break;
        starting_after = data[data.length - 1].id;
    }

    return out;
}

// Sum item amounts per currency, optionally only those at/after a timestamp.
function sumBy(items, since) {
    const totals = {};
    for (const item of items) {
        const amount = Number(item.amount);
        if (!Number.isFinite(amount)) continue;
        if (since !== undefined && since !== null && Number(item.created) < since) continue;
        // Only settled money counts. Charges can be "failed" and refunds can be
        // "failed"/"pending" — neither is income.
        const status = item.status ? String(item.status).toLowerCase() : 'succeeded';
        if (status !== 'succeeded') continue;
        const currency = String(item.currency || 'usd').toLowerCase();
        totals[currency] = (totals[currency] || 0) + amount;
    }
    return totals;
}

// Pick the currency to display: USD if present, otherwise the largest.
function pickCurrency(totals) {
    const keys = Object.keys(totals);
    if (!keys.length) return { currency: 'usd', amount: 0 };
    if (totals.usd !== undefined) return { currency: 'usd', amount: totals.usd };
    let best = keys[0];
    for (const k of keys) if (totals[k] > totals[best]) best = k;
    return { currency: best, amount: totals[best] };
}

// Select the symbol from the returned currency.
const SYMBOLS = {
    usd: '$', eur: '€', gbp: '£', hkd: 'HK$', sgd: 'S$', aud: 'A$',
    cad: 'C$', jpy: '¥', cny: '¥', inr: '₹', nzd: 'NZ$', twd: 'NT$',
};

// cents -> "$1,234" / "HK$26,869" / "$12.3K" / "$1.2M"
function formatMoney(cents, currency) {
    const value = cents / 100;
    const code = String(currency || 'usd').toLowerCase();
    const sym = SYMBOLS[code] || code.toUpperCase() + ' ';
    const abs = Math.abs(value);
    let body;
    if (abs >= 1000000) body = (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    else if (abs >= 10000) body = (value / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    else body = value.toLocaleString('en-US', { maximumFractionDigits: abs < 100 ? 2 : 0 });
    return sym + body;
}

/**
 * Refresh the cached Stripe figures for the given modes.
 * @param {string[]} modes  any of today | month | balance | subs
 */
async function refresh(modes) {
    const key = credentials.stripeKey();
    const want = new Set((Array.isArray(modes) ? modes : [modes]).map((m) => String(m).toLowerCase()));

    if (!key) {
        for (const m of want) CACHE[m] = { state: 'nokey', at: Date.now() };
        return;
    }

    // Skip modes that are already fresh.
    const pending = [...want].filter((m) => {
        const e = CACHE[m];
        return !(e && e.state === 'ok' && Date.now() - e.at < TTL_MS);
    });
    if (!pending.length) return;

    const sinceMonth = startOfMonth();
    const sinceDay = startOfDay();
    const tasks = [];

    if (pending.includes('balance')) {
        tasks.push((async () => {
            const json = await apiGet('/balance', key);
            const available = (json.available || []).reduce((acc, item) => {
                const c = String(item.currency || 'usd').toLowerCase();
                acc[c] = (acc[c] || 0) + Number(item.amount || 0);
                return acc;
            }, {});
            const chosen = pickCurrency(available);
            CACHE.balance = { state: 'ok', value: formatMoney(chosen.amount, chosen.currency), raw: chosen.amount, at: Date.now() };
        })());
    }

    if (pending.includes('subs')) {
        tasks.push((async () => {
            const items = await listAll('/subscriptions', key, null, ['status=active']);
            CACHE.subs = { state: 'ok', value: String(items.length), raw: items.length, at: Date.now() };
        })());
    }

    if (pending.includes('today') || pending.includes('month')) {
        tasks.push((async () => {
            const charges = await listAll('/charges', key, sinceMonth);
            let refunds = [];
            try {
                refunds = await listAll('/refunds', key, sinceMonth);
            } catch (e) {
                refunds = []; // refunds need extra permission; gross is still useful
            }

            const nets = {
                month: netOf(sumBy(charges, sinceMonth), sumBy(refunds, sinceMonth)),
                today: netOf(sumBy(charges, sinceDay), sumBy(refunds, sinceDay)),
            };

            if (pending.includes('month')) {
                CACHE.month = { state: 'ok', value: formatMoney(nets.month.amount, nets.month.currency), raw: nets.month.amount, at: Date.now() };
            }
            if (pending.includes('today')) {
                CACHE.today = { state: 'ok', value: formatMoney(nets.today.amount, nets.today.currency), raw: nets.today.amount, at: Date.now() };
            }
        })());
    }

    try {
        await Promise.all(tasks);
    } catch (e) {
        const msg = String((e && e.message) || e);
        const state = /invalid|expired|no such|api key|unauthorized/i.test(msg) ? 'badkey' : 'error';
        for (const m of pending) {
            if (!CACHE[m] || CACHE[m].state !== 'ok') CACHE[m] = { state, error: msg, at: Date.now() };
        }
    }
}

// Net charges minus refunds in the same currency.
function netOf(chargeTotals, refundTotals) {
    const c = pickCurrency(chargeTotals);
    const r = refundTotals[c.currency] || 0;
    return { currency: c.currency, amount: c.amount - r };
}

/**
 * @param {string} mode today | month | balance | subs
 * @returns {{value:string, color:string}}
 */
function resolve(mode) {
    const m = String(mode || 'today').toLowerCase();
    const entry = CACHE[m];

    if (!entry) return { value: '...', color: '#FBBF24' };
    if (entry.state === 'nokey') return { value: 'KEY?', color: '#F87171' };
    if (entry.state === 'badkey') return { value: 'BADKEY', color: '#F87171' };
    if (entry.state === 'error') return { value: 'ERR', color: '#F87171' };
    return { value: entry.value, color: '#34D399' };
}

module.exports = {
    MODES: { month: 'Income this month', today: 'Income today', balance: 'Available balance', subs: 'Active subscriptions' },
    TTL_MS,
    CACHE,
    refresh,
    resolve,
    formatMoney,
    listAll,
    sumBy,
    pickCurrency,
    startOfDay,
    startOfMonth,
};
