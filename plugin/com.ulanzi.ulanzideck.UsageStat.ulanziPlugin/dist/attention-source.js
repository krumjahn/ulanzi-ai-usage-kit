'use strict';
/*
 * AttentionLedger ("AI Usage") source for the AI Usage plugin.
 *
 * The app is a foreground-activity tracker. It stores every observed app
 * interval in:
 *   ~/Library/Application Support/com.rumjahn.attentionledger/activity.sqlite
 *
 * Table:
 *   segments(start REAL, end REAL, app, bundle, domain, rule_version,
 *            matched_tool, evidence)
 *
 * `start`/`end` are unix timestamps. `matched_tool` is set only for intervals
 * that were positively identified as AI tooling (the app calls this
 * "AI attention"); NULL means "unmatched" (a normal app).
 *
 * The app's own menu bar title is "AI attention today".
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const DB_PATH = path.join(os.homedir(), 'Library/Application Support/com.rumjahn.attentionledger/activity.sqlite');

const PERIODS = {
    today: 'Today',
    week: 'This week',
    month: 'This month',
    '30d': 'Last 30 days',
    all: 'All time',
};

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function startOfWeek(d) {
    const x = startOfDay(d);
    const dow = (x.getDay() + 6) % 7; // Monday-based
    x.setDate(x.getDate() - dow);
    return x;
}

function startOfMonth(d) {
    const x = startOfDay(d);
    x.setDate(1);
    return x;
}

function periodStart(period) {
    const now = new Date();
    switch (period) {
        case 'today': return startOfDay(now);
        case 'week': return startOfWeek(now);
        case 'month': return startOfMonth(now);
        case '30d': return new Date(now.getTime() - 30 * 86400000);
        default: return null;
    }
}

function sqlite(query) {
    if (!fs.existsSync(DB_PATH)) return null;
    try {
        const cmd = spawnSync('sqlite3', ['-readonly', DB_PATH, query], {
            timeout: 5000,
            maxBuffer: 8 * 1024 * 1024,
        });
        if (cmd.status !== 0) return null;
        const out = cmd.stdout.toString().trim();
        if (!out) return 0;
        const n = Number(out.split('\n')[0]);
        return Number.isFinite(n) ? n : null;
    } catch (e) {
        return null;
    }
}

// Seconds of AI attention in the period, optionally narrowed to one tool.
function attentionSeconds(period, tool) {
    let where = "matched_tool IS NOT NULL";
    const start = periodStart(period);
    if (start) where += ` AND start >= ${Math.floor(start.getTime() / 1000)}`;
    if (tool && String(tool).trim()) {
        const t = String(tool).trim().replace(/'/g, "''");
        // Substring match so "ChatGPT" also covers "ChatGPT / Codex".
        where += ` AND matched_tool LIKE '%${t}%'`;
    }
    const seconds = sqlite(`SELECT COALESCE(SUM(end - start), 0) FROM segments WHERE ${where}`);
    return seconds;
}

// Distinct tools the tracker has recorded, for the inspector dropdown.
function knownTools() {
    if (!fs.existsSync(DB_PATH)) return [];
    try {
        const cmd = spawnSync('sqlite3', ['-readonly', DB_PATH,
            'SELECT DISTINCT matched_tool FROM segments WHERE matched_tool IS NOT NULL ORDER BY matched_tool'],
            { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
        if (cmd.status !== 0) return [];
        return cmd.stdout.toString().split('\n').map((s) => s.trim()).filter(Boolean);
    } catch (e) {
        return [];
    }
}

// "1h 23m" / "45m" / "12s"
function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return null;
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${d}d ${rh}h` : `${d}d`;
}

function resolve(period, tool) {
    const seconds = attentionSeconds(period, tool);
    if (seconds === null) return null;
    return formatDuration(seconds);
}

module.exports = {
    PERIODS,
    DB_PATH,
    attentionSeconds,
    knownTools,
    formatDuration,
    resolve,
};
