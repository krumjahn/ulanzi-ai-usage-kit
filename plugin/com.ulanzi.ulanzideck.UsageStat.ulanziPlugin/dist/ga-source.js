'use strict';
/*
 * Google Analytics 4 source for the AI Usage plugin.
 *
 * Needs a GA4 property id plus a credential, both stored in
 * ~/.ulanzi/stats.json (mode 600):
 *
 *   {
 *     "ga": {
 *       "propertyId": "123456789",
 *       "serviceAccountFile": "/path/to/service-account.json"
 *     }
 *   }
 *
 * Two credential styles are supported, because either one works unattended:
 *
 *  1. Service account (recommended). The JSON key file is passed by path; it
 *     is never copied into stats.json. The service account's email must be
 *     added as a Viewer on the GA4 property.
 *
 *  2. OAuth client + refresh token, stored inline as
 *     "clientId" / "clientSecret" / "refreshToken".
 *
 * The service-account JWT and the OAuth refresh are both implemented here with
 * node's built-in crypto, so the plugin needs no extra npm packages.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const credentials = require('./credentials.js');

const TTL_MS = 300 * 1000;        // GA data does not change by the second
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://analyticsdata.googleapis.com/v1beta';

const CACHE = { state: 'unknown', metrics: {}, at: 0, token: null, tokenExpiry: 0 };

// --- token acquisition ------------------------------------------------------

function b64url(input) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

async function tokenFromServiceAccount(file) {
    let key;
    try {
        key = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error('cannot read service account file');
    }
    const email = key.client_email;
    const privateKey = String(key.private_key || '').replace(/\\n/g, '\n');
    if (!email || !privateKey) throw new Error('service account file is malformed');

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
        iss: email,
        scope: TOKEN_SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
    }));

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = b64url(signer.sign(privateKey));
    const assertion = `${header}.${claims}.${signature}`;

    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        }),
        signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
        throw new Error(json.error_description || json.error || `token http ${res.status}`);
    }
    return { token: json.access_token, expiry: Date.now() + 55 * 60 * 1000 };
}

async function tokenFromOAuth(clientId, clientSecret, refreshToken) {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
        throw new Error(json.error_description || json.error || `token http ${res.status}`);
    }
    return { token: json.access_token, expiry: Date.now() + 50 * 60 * 1000 };
}

async function getAccessToken() {
    const ga = credentials.section('ga');
    if (CACHE.token && Date.now() < CACHE.tokenExpiry - 60000) return CACHE.token;

    if (ga.serviceAccountFile) {
        const res = await tokenFromServiceAccount(ga.serviceAccountFile);
        CACHE.token = res.token;
        CACHE.tokenExpiry = res.expiry;
        return res.token;
    }
    if (ga.clientId && ga.clientSecret && ga.refreshToken) {
        const res = await tokenFromOAuth(ga.clientId, ga.clientSecret, ga.refreshToken);
        CACHE.token = res.token;
        CACHE.tokenExpiry = res.expiry;
        return res.token;
    }
    throw new Error('no ga credential');
}

// --- report -----------------------------------------------------------------

// Metric names we ask for. GA only returns what the property actually has,
// so unsupported ones are simply absent.
const WANTED_METRICS = ['totalUsers', 'sessions', 'screenPageViews', 'totalRevenue'];

function periodRange(period) {
    const p = String(period || 'today').toLowerCase();
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);

    switch (p) {
        case 'yesterday': {
            const y = new Date(today);
            y.setDate(y.getDate() - 1);
            return { startDate: iso(y), endDate: iso(y) };
        }
        case 'week':
        case '7d': {
            const s = new Date(today);
            s.setDate(s.getDate() - 6);
            return { startDate: iso(s), endDate: iso(today) };
        }
        case 'month':
        case '30d': {
            const s = new Date(today);
            s.setDate(s.getDate() - 29);
            return { startDate: iso(s), endDate: iso(today) };
        }
        case 'today':
        default:
            return { startDate: 'yesterday', endDate: 'today' };
    }
}

async function runReport(token, propertyId, period) {
    const range = periodRange(period);
    const res = await fetch(`${API}/properties/${encodeURIComponent(propertyId)}:runReport`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            dateRanges: [range],
            metrics: WANTED_METRICS.map((name) => ({ name })),
            metricAggregations: ['TOTAL'],
        }),
        signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = (json.error && json.error.message) || `http ${res.status}`;
        throw new Error(msg);
    }

    const metrics = {};
    (json.metricHeaders || []).forEach((h, i) => {
        const row = (json.rows && json.rows[0]) || {};
        const cells = row.metricValues || [];
        const value = cells[i] ? Number(cells[i].value) : null;
        metrics[h.name] = Number.isFinite(value) ? value : null;
    });
    return metrics;
}

// --- plugin interface -------------------------------------------------------

/**
 * Refresh the cached GA metrics.
 * @param {string[]} modes  any of users | sessions | views | revenue
 * @param {string}   period today | yesterday | week | month
 */
async function refresh(modes, period) {
    const ga = credentials.section('ga');
    const propertyId = String(ga.propertyId || '').trim();

    if (!propertyId) {
        CACHE.state = 'noproperty';
        CACHE.at = Date.now();
        return;
    }
    if (!ga.serviceAccountFile && !(ga.clientId && ga.clientSecret && ga.refreshToken)) {
        CACHE.state = 'nokey';
        CACHE.at = Date.now();
        return;
    }
    if (CACHE.state === 'ok' && Date.now() - CACHE.at < TTL_MS) return;

    try {
        const token = await getAccessToken();
        const metrics = await runReport(token, propertyId, period || 'today');
        CACHE.metrics = metrics;
        CACHE.state = 'ok';
        CACHE.at = Date.now();
    } catch (e) {
        const msg = String((e && e.message) || e);
        const state = /no ga credential/i.test(msg) ? 'nokey'
            : /permission|forbidden|access|not found|property/i.test(msg) ? 'badkey'
                : 'error';
        CACHE.state = state;
        CACHE.error = msg;
        CACHE.at = Date.now();
    }
}

function formatCount(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    const abs = Math.abs(n);
    if (abs >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
}

function formatRevenue(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    const abs = Math.abs(n);
    if (abs >= 10000) return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: abs < 100 ? 2 : 0 });
}

/**
 * @param {string} mode users | sessions | views | revenue
 * @returns {{value:string, color:string}}
 */
function resolve(mode) {
    const m = String(mode || 'users').toLowerCase();

    if (CACHE.state === 'unknown') return { value: '...', color: '#FBBF24' };
    if (CACHE.state === 'noproperty') return { value: 'PID?', color: '#F87171' };
    if (CACHE.state === 'nokey') return { value: 'KEY?', color: '#F87171' };
    if (CACHE.state === 'badkey') return { value: 'BADKEY', color: '#F87171' };
    if (CACHE.state === 'error') return { value: 'ERR', color: '#F87171' };

    const metricName = m === 'users' ? 'totalUsers' : m;
    const raw = CACHE.metrics[metricName];
    if (raw === null || raw === undefined) return { value: 'N/A', color: '#FBBF24' };

    const value = m === 'revenue' ? formatRevenue(raw) : formatCount(raw);
    if (value === null) return { value: 'N/A', color: '#FBBF24' };
    return { value, color: '#FBBF24' };
}

module.exports = {
    MODES: { users: 'Total users', sessions: 'Sessions', views: 'Page views', revenue: 'Revenue' },
    PERIODS: { today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', month: 'Last 30 days' },
    TTL_MS,
    CACHE,
    refresh,
    resolve,
    formatCount,
    formatRevenue,
    periodRange,
    tokenFromServiceAccount,
    tokenFromOAuth,
    runReport,
};
