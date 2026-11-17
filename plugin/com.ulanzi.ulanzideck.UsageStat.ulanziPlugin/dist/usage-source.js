'use strict';
/*
 * Data layer for the AI Usage plugin.
 *
 * Reads live usage data from OpenUsage:
 *   1. http://127.0.0.1:6736/v1/usage  -> rich snapshots (percent + cost/token lines)
 *   2. http://127.0.0.1:6736/v1/limits  -> normalised limits
 *   3. /Applications/OpenUsage.app/Contents/Helpers/openusage -> CLI, shares OpenUsage's cache
 *
 * MiniMax and Gemini are queried directly because OpenUsage does not surface
 * them for this machine.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const credentials = require('./credentials.js');

const OPENUSAGE_HOST = '127.0.0.1';
const OPENUSAGE_PORT = 6736;
const OPENUSAGE_CLI = '/Applications/OpenUsage.app/Contents/Helpers/openusage';

const GEMINI_CREDS_PATH = path.join(os.homedir(), '.gemini/oauth_creds.json');
const GEMINI_PROJECTS_PATH = path.join(os.homedir(), '.gemini/projects.json');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude/projects');

const cache = { at: 0, ok: false, providers: {} };
let fetching = false;

async function httpJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 4000);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Rich snapshot payload -> { providerId: { displayName, plan, lines } }
function indexSnapshots(list) {
    const out = {};
    if (!Array.isArray(list)) return out;
    for (const snap of list) {
        if (!snap || !snap.providerId) continue;
        out[snap.providerId] = {
            displayName: snap.displayName,
            plan: snap.plan || null,
            lines: Array.isArray(snap.lines) ? snap.lines : [],
        };
    }
    return out;
}

// Normalised limits payload -> same shape
function indexLimits(limits) {
    const out = {};
    const providers = (limits && limits.providers) || {};
    for (const id of Object.keys(providers)) {
        const p = providers[id];
        const lines = [];
        const resources = p.resources || {};
        for (const rid of Object.keys(resources)) {
            const r = resources[rid];
            if (!r) continue;
            if (r.kind === 'consumption' && typeof r.limit === 'number') {
                lines.push({
                    type: 'progress',
                    label: rid,
                    used: r.used || 0,
                    limit: r.limit,
                    resetsAt: r.resetsAt || null,
                });
            } else if (typeof r.available === 'number') {
                lines.push({
                    type: 'text',
                    label: rid,
                    value: String(r.available) + (r.unit ? ' ' + r.unit : ''),
                });
            }
        }
        out[id] = { displayName: p.displayName, plan: p.plan || null, lines };
    }
    return out;
}

function cliLimits(force) {
    try {
        const args = force ? ['--force'] : [];
        const cmd = spawnSync(OPENUSAGE_CLI, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
        if (cmd.status !== 0 || !cmd.stdout) return null;
        return JSON.parse(cmd.stdout.toString());
    } catch (e) {
        return null;
    }
}

// How many providers actually carry a number to show?
function score(providers) {
    let n = 0;
    for (const id of Object.keys(providers || {})) {
        if (providers[id].lines && providers[id].lines.length) n++;
    }
    return n;
}

// Is some provider present but empty? That is the sign of a stale shared
// cache rather than a provider that genuinely has nothing.
function hasEmptyProvider(providers) {
    const ids = Object.keys(providers || {});
    if (!ids.length) return false;
    return ids.some((id) => !providers[id].lines || !providers[id].lines.length);
}

async function loadUsage() {
    const base = `http://${OPENUSAGE_HOST}:${OPENUSAGE_PORT}`;
    let best = null;
    let bestScore = -1;

    const consider = (providers) => {
        const s = score(providers);
        if (s > bestScore) { bestScore = s; best = providers; }
        return s;
    };

    let payload = await httpJson(`${base}/v1/usage`);
    if (Array.isArray(payload)) consider(indexSnapshots(payload));

    payload = await httpJson(`${base}/v1/limits`);
    if (payload && payload.providers) consider(indexLimits(payload));

    const limits = cliLimits();
    if (limits && limits.providers) consider(indexLimits(limits));

    // The OpenUsage cache is shared between the app and every process that
    // calls the helper, and it sometimes holds an empty reading for one
    // provider while the others are fine. Ask for a fresh one and keep
    // whichever answer has more to show.
    if (hasEmptyProvider(best)) {
        const forced = cliLimits(true);
        if (forced && forced.providers) consider(indexLimits(forced));
    }

    if (best && Object.keys(best).length) return { ok: true, providers: best };
    return { ok: false, providers: {} };
}

async function refresh() {
    if (fetching) return cache;
    fetching = true;
    try {
        const result = await loadUsage();
        cache.at = Date.now();
        cache.ok = result.ok;
        cache.providers = result.providers;
    } catch (e) {
        cache.at = Date.now();
        cache.ok = false;
        cache.providers = {};
    } finally {
        fetching = false;
    }
    return cache;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------
function progressLine(provider, labels) {
    if (!provider) return null;
    for (const label of labels) {
        for (const line of provider.lines) {
            if (line.type === 'progress' && String(line.label).toLowerCase() === label) return line;
        }
    }
    return null;
}

function textLine(provider, labels) {
    if (!provider) return null;
    for (const label of labels) {
        for (const line of provider.lines) {
            if (line.type === 'text' && String(line.label).toLowerCase() === label) return line;
        }
    }
    return null;
}

function remainingPercent(line) {
    if (!line) return null;
    const limit = typeof line.limit === 'number' ? line.limit : 100;
    const used = typeof line.used === 'number' ? line.used : 0;
    const pct = ((limit - used) / limit) * 100;
    return Math.max(0, Math.min(100, pct));
}

function usedPercent(line) {
    if (!line) return null;
    const limit = typeof line.limit === 'number' ? line.limit : 100;
    const used = typeof line.used === 'number' ? line.used : 0;
    const pct = (used / limit) * 100;
    return Math.max(0, Math.min(100, pct));
}

// "$5.43 · 4.3M tokens" -> "4.3M"
function tokenFigure(value) {
    if (!value) return null;
    const m = String(value).match(/([\d.,]+\s*[KMB]?)\s*tokens/i);
    if (m) return m[1].replace(/\s+/g, '');
    return null;
}

function untilReset(resetsAt) {
    if (!resetsAt) return null;
    const ts = Date.parse(resetsAt);
    if (!Number.isFinite(ts)) return null;
    let diff = Math.floor((ts - Date.now()) / 1000);
    if (diff <= 0) return 'now';
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const mn = Math.floor((diff % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${mn}m`;
    return `${mn}m`;
}

// ---------------------------------------------------------------------------
// Claude Code token counter
//
// OpenUsage does not publish a Claude "Today" line on this machine, so the
// token total is read straight from the Claude Code session transcripts in
// ~/.claude/projects. Cached for a minute because it walks the transcripts.
// ---------------------------------------------------------------------------
const claudeTokenCache = { at: 0, value: null };

function claudeTokensToday() {
    if (Date.now() - claudeTokenCache.at < 60000) return claudeTokenCache.value;

    let total = null;
    try {
        if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
            const now = new Date();
            const todayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
            let sum = 0;

            const localDayKey = (ts) => {
                const d = new Date(ts);
                if (Number.isNaN(d.getTime())) return null;
                return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
            };

            const walk = (dir, depth) => {
                if (depth > 4) return;
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walk(full, depth + 1);
                    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                        // Skip transcripts untouched for over two days.
                        try {
                            const st = fs.statSync(full);
                            if (Date.now() - st.mtimeMs > 2 * 86400000) continue;
                        } catch (e) { continue; }

                        let content;
                        try { content = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
                        if (content.indexOf('"usage"') === -1) continue;

                        for (const line of content.split('\n')) {
                            if (line.indexOf('"usage"') === -1) continue;
                            let d;
                            try { d = JSON.parse(line); } catch (e) { continue; }
                            const ts = d && d.timestamp;
                            if (!ts) continue;
                            if (localDayKey(ts) !== todayKey) continue;
                            const u = (d.message && d.message.usage) || null;
                            if (!u) continue;
                            sum += (u.input_tokens || 0)
                                + (u.output_tokens || 0)
                                + (u.cache_creation_input_tokens || 0)
                                + (u.cache_read_input_tokens || 0);
                        }
                    }
                }
            };

            walk(CLAUDE_PROJECTS_DIR, 0);
            total = sum;
        }
    } catch (e) {
        total = null;
    }

    claudeTokenCache.at = Date.now();
    claudeTokenCache.value = total;
    return total;
}

function formatTokens(n) {
    if (n === null || n === undefined) return null;
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}

// ---------------------------------------------------------------------------
// Per-action resolution
// ---------------------------------------------------------------------------
function resolveOpenUsageValue(actionKey, mode) {
    const providers = cache.providers || {};

    if (actionKey === 'grokbot') {
        const grokProvider = providers.grok;
        const cursorProvider = providers.cursor;
        const line = progressLine(grokProvider, ['weekly', 'session'])
            || progressLine(cursorProvider, ['grok bot usage', 'grokbot', 'grok bot']);
        if (!line) return null;
        if (mode === 'used') return `${Math.round(usedPercent(line))}%`;
        if (mode === 'reset') return untilReset(line.resetsAt) || '--';
        if (mode === 'tokens') {
            // Only the dedicated xAI grok provider carries its own token line.
            const t = tokenFigure((textLine(grokProvider, ['today']) || {}).value);
            return t || '--';
        }
        return `${Math.round(remainingPercent(line))}%`;
    }

    let providerId = null;
    let labels = [];
    if (actionKey === 'openai' || actionKey === 'codex') {
        providerId = 'codex';
        labels = ['weekly', 'session'];
    } else if (actionKey === 'claude') {
        providerId = 'claude';
        labels = ['weekly', 'session'];
    } else if (actionKey === 'cursor') {
        providerId = 'cursor';
        labels = ['total usage', 'totalusage', 'total'];
    }
    if (!providerId) return null;

    const provider = providers[providerId];
    if (!provider) return null;
    const line = progressLine(provider, labels);

    if (mode === 'used') return line ? `${Math.round(usedPercent(line))}%` : null;
    if (mode === 'reset') return line ? (untilReset(line.resetsAt) || '--') : null;
    if (mode === 'tokens') {
        const t = tokenFigure((textLine(provider, ['today']) || {}).value);
        if (t) return t;
        if (providerId === 'claude') {
            const local = formatTokens(claudeTokensToday());
            if (local !== null) return local;
        }
        return line ? `${Math.round(remainingPercent(line))}%` : null;
    }
    return line ? `${Math.round(remainingPercent(line))}%` : null;
}

// ---------------------------------------------------------------------------
// MiniMax / Gemini (direct APIs)
// ---------------------------------------------------------------------------
const directCache = { minimax: { at: 0, value: null }, gemini: { at: 0, value: null } };

function cachedDirect(kind, getter, ttlMs) {
    const slot = directCache[kind];
    if (slot.value !== null && Date.now() - slot.at < ttlMs) return slot.value;
    const value = getter();
    slot.at = Date.now();
    slot.value = value;
    return value;
}

function getMinimaxUsage() {
    return cachedDirect('minimax', getMinimaxUsageRaw, 30000);
}

function getGeminiUsage() {
    return cachedDirect('gemini', getGeminiUsageRaw, 30000);
}

// Pass authentication to curl over stdin, not the process argument list.
function curlRequest(url, headers, body) {
    const lines = ['silent', 'show-error', 'max-time = 10', 'url = ' + JSON.stringify(url)];
    for (const header of headers || []) {
        if (/[\r\n\0]/.test(header)) throw new Error('invalid header');
        lines.push('header = ' + JSON.stringify(header));
    }
    if (body !== undefined) lines.push('data = ' + JSON.stringify(body));
    return spawnSync('curl', ['--config', '-'], {
        input: lines.join('\n') + '\n', timeout: 12000, maxBuffer: 4 * 1024 * 1024,
    });
}

function getMinimaxUsageRaw() {
    try {
        const token = credentials.section('minimax').apiKey;
        if (!token) return 'KEY?';
        const cmd = curlRequest('https://api.minimax.io/v1/api/openplatform/coding_plan/remains', [`Authorization: Bearer ${token}`]);
        if (cmd.status !== 0) return 'OFF';
        const usage = JSON.parse(cmd.stdout.toString());
        const remains = (usage.data?.model_remains || usage.model_remains || usage.modelRemains)?.[0];
        if (remains) {
            const total = remains.current_interval_total_count || 1;
            const remaining = remains.current_interval_usage_count ?? remains.current_interval_remaining_count;
            if (remaining !== undefined) return `${Math.round((remaining / total) * 100)}%`;
        }
        return 'OK';
    } catch (e) { return 'ERR'; }
}

function refreshGeminiToken(creds) {
    try {
        const clientId = credentials.geminiClientId();
        const clientSecret = credentials.geminiClientSecret();
        if (!clientId || !clientSecret) return null;
        const body = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&refresh_token=${encodeURIComponent(creds.refresh_token)}&grant_type=refresh_token`;
        const cmd = curlRequest('https://oauth2.googleapis.com/token', ['Content-Type: application/x-www-form-urlencoded'], body);
        if (cmd.status !== 0) return null;
        const data = JSON.parse(cmd.stdout.toString());
        if (data.access_token) {
            creds.access_token = data.access_token;
            if (data.expires_in) creds.expiry_date = Date.now() + (data.expires_in * 1000);
            fs.chmodSync(GEMINI_CREDS_PATH, 0o600);
            fs.writeFileSync(GEMINI_CREDS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
            return data.access_token;
        }
    } catch (e) {}
    return null;
}

function getGeminiUsageRaw() {
    try {
        if (!fs.existsSync(GEMINI_CREDS_PATH)) return '---';
        const creds = JSON.parse(fs.readFileSync(GEMINI_CREDS_PATH, 'utf8'));
        let token = creds.access_token;
        if (Date.now() + 300000 >= (creds.expiry_date || 0)) token = refreshGeminiToken(creds) || token;
        let projectIds = [''];
        if (fs.existsSync(GEMINI_PROJECTS_PATH)) {
            try {
                const projects = JSON.parse(fs.readFileSync(GEMINI_PROJECTS_PATH, 'utf8'));
                if (projects.projects) projectIds = projectIds.concat(Object.values(projects.projects));
            } catch (e) {}
        }
        let totalRemaining = 0, count = 0;
        for (const pid of projectIds) {
            const body = pid ? JSON.stringify({ project: pid }) : '{}';
            const cmd = curlRequest('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', [`Authorization: Bearer ${token}`, 'Content-Type: application/json'], body);
            if (cmd.status !== 0) continue;
            try {
                const data = JSON.parse(cmd.stdout.toString());
                function find(o) { if (o && typeof o === 'object') { if (typeof o.remainingFraction === 'number' && o.remainingFraction >= 0 && o.remainingFraction <= 1) { totalRemaining += o.remainingFraction; count++; } Object.values(o).forEach(find); } }
                find(data);
            } catch (e) {}
        }
        if (count > 0) return `${Math.round((totalRemaining / count) * 100)}%`;
        return 'N/A';
    } catch (e) { return 'ERR'; }
}

module.exports = {
    refresh,
    resolveOpenUsageValue,
    getMinimaxUsage,
    getGeminiUsage,
    get cache() { return cache; },
};
