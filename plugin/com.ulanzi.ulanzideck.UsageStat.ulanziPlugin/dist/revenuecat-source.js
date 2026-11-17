'use strict';
/*
 * RevenueCat source for the AI Usage plugin.
 *
 * Needs a RevenueCat *secret* API key plus the project id, stored in
 * ~/.ulanzi/stats.json (mode 600):
 *
 *   { "revenuecat": { "secretKey": "sk_...", "projectId": "proj1ab2c3d" } }
 *
 * The public "appl_..." app API key cannot read subscriber counts, so the
 * secret key from app.revenuecat.com > Project Settings > API Keys is required.
 *
 * Endpoints used (RevenueCat API v2):
 *   GET /v2/projects/{id}/metrics/overview
 *   GET /v2/projects/{id}/metrics/revenue?start_date=&end_date=&currency=USD&revenue_type=proceeds
 *
 * The overview call returns every metric at once, so one request serves both
 * the subscriber count and MRR. Provider rate limits may change.
 */

const credentials = require('./credentials.js');

const TTL_MS = 60 * 1000;
const API = 'https://api.revenuecat.com/v2';

// mode -> { state, value, raw, at }
const CACHE = {};

async function apiGet(path, secret) {
    const res = await fetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (e) { /* non-json error body */ }
    if (!res.ok) {
        const msg = (json && (json.message || json.error)) || `http ${res.status}`;
        const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        err.status = res.status;
        throw err;
    }
    return json;
}

// Coerce a metric value that may be a number or an {amount, currency} object.
function toNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value && typeof value === 'object') {
        const n = Number(value.amount !== undefined ? value.amount : value.value);
        if (Number.isFinite(n)) return n;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Pull the first metric whose id or name matches one of the aliases.
function pickMetric(metrics, aliases) {
    if (!Array.isArray(metrics)) return null;
    const wanted = aliases.map((a) => a.toLowerCase());
    for (const m of metrics) {
        if (!m) continue;
        const id = String(m.id || '').toLowerCase();
        const name = String(m.name || '').toLowerCase();
        for (const w of wanted) {
            if (id === w || name === w) return toNumber(m.value);
        }
    }
    // Fall back to a looser match ("active_subscriptions" ~ "actives").
    for (const m of metrics) {
        if (!m) continue;
        const id = String(m.id || '').toLowerCase();
        for (const w of wanted) {
            const a = id.replace(/_/g, '');
            const b = w.replace(/_/g, '');
            if (a.includes(b) || b.includes(a)) {
                const n = toNumber(m.value);
                if (n !== null) return n;
            }
        }
    }
    return null;
}

function ymd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function startOfMonth() {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * Refresh the cached RevenueCat figures for the given modes.
 * @param {string[]} modes  any of actives | mrr | revenue
 */
async function refresh(modes) {
    const secret = credentials.revenuecatSecret();
    const project = credentials.revenuecatProject();
    const want = new Set((Array.isArray(modes) ? modes : [modes]).map((m) => String(m).toLowerCase()));

    if (!secret || !project) {
        for (const m of want) CACHE[m] = { state: 'nokey', at: Date.now() };
        return;
    }

    const pending = [...want].filter((m) => {
        const e = CACHE[m];
        return !(e && e.state === 'ok' && Date.now() - e.at < TTL_MS);
    });
    if (!pending.length) return;

    const base = `/projects/${encodeURIComponent(project)}`;
    const tasks = [];

    if (pending.includes('actives') || pending.includes('mrr')) {
        tasks.push((async () => {
            const json = await apiGet(`${base}/metrics/overview`, secret);
            const metrics = json.metrics || (json.data && json.data.metrics);

            if (pending.includes('actives')) {
                const v = pickMetric(metrics, ['actives', 'active_subscriptions', 'active_customers', 'subscriptions']);
                if (v === null) CACHE.actives = { state: 'nodata', at: Date.now() };
                else CACHE.actives = { state: 'ok', value: formatValue('actives', v), raw: v, at: Date.now() };
            }
            if (pending.includes('mrr')) {
                const v = pickMetric(metrics, ['mrr', 'monthly_recurring_revenue', 'monthly_revenue']);
                if (v === null) CACHE.mrr = { state: 'nodata', at: Date.now() };
                else CACHE.mrr = { state: 'ok', value: formatValue('mrr', v), raw: v, at: Date.now() };
            }
        })());
    }

    if (pending.includes('revenue')) {
        tasks.push((async () => {
            const from = startOfMonth();
            const to = new Date();
            const qs = `?start_date=${ymd(from)}&end_date=${ymd(to)}&currency=USD&revenue_type=proceeds`;
            const json = await apiGet(`${base}/metrics/revenue${qs}`, secret);
            const v = toNumber(json.value !== undefined ? json.value : (json.metrics && json.metrics.value));
            if (v === null) CACHE.revenue = { state: 'nodata', at: Date.now() };
            else CACHE.revenue = { state: 'ok', value: formatValue('revenue', v), raw: v, at: Date.now() };
        })());
    }

    try {
        await Promise.all(tasks);
    } catch (e) {
        const msg = String((e && e.message) || e);
        const state = /invalid|unauthorized|forbidden|secret|api key|authentication/i.test(msg) ? 'badkey' : 'error';
        for (const m of pending) {
            if (!CACHE[m] || CACHE[m].state !== 'ok') CACHE[m] = { state, error: msg, at: Date.now() };
        }
    }
}

// Subscribers -> "1,322" ; money -> "$1,234"
function formatValue(mode, value) {
    if (mode === 'actives') {
        return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    const abs = Math.abs(value);
    if (abs >= 1000000) return '$' + (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 10000) return '$' + (value / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return '$' + value.toLocaleString('en-US', { maximumFractionDigits: abs < 100 ? 2 : 0 });
}

/**
 * @param {string} mode actives | mrr | revenue
 * @returns {{value:string, color:string}}
 */
function resolve(mode) {
    const m = String(mode || 'actives').toLowerCase();
    const entry = CACHE[m];

    if (!entry) return { value: '...', color: '#FBBF24' };
    if (entry.state === 'nokey') return { value: 'KEY?', color: '#F87171' };
    if (entry.state === 'badkey') return { value: 'BADKEY', color: '#F87171' };
    if (entry.state === 'error') return { value: 'ERR', color: '#F87171' };
    if (entry.state === 'nodata') return { value: 'N/A', color: '#FBBF24' };
    return { value: entry.value, color: '#34D399' };
}

module.exports = {
    MODES: { actives: 'Active subscribers', mrr: 'MRR', revenue: 'Revenue this month' },
    TTL_MS,
    CACHE,
    refresh,
    resolve,
    formatValue,
    pickMetric,
    toNumber,
};
