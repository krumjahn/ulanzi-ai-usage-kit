'use strict';
/*
 * NBA team record source for the AI Usage plugin.
 *
 * Reads the team's win-loss record and league standing from ESPN's public
 * site API. It currently uses no API key; the endpoint may change.
 *
 *   team    : https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/tor
 *   standing: https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?...
 *
 * Config in ~/.ulanzi/stats.json (mode 600) — optional, for following a
 * different team or sport:
 *
 *   {
 *     "raptors": {
 *       "sport": "basketball",
 *       "league": "nba",
 *       "team": "tor"
 *     }
 *   }
 */

const credentials = require('./credentials.js');

const TTL_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;

const CACHE = {
    state: 'unknown',
    wins: null,
    losses: null,
    seed: null,
    gamesBehind: null,
    conference: null,
    streak: null,
    teamName: 'Raptors',
    method: null,
    at: 0,
};

function config() {
    const cfg = credentials.section('raptors');
    return {
        sport: String(cfg.sport || 'basketball').trim(),
        league: String(cfg.league || 'nba').trim(),
        team: String(cfg.team || 'tor').trim().toLowerCase(),
        name: String(cfg.name || '').trim(),
    };
}

function statMap(stats) {
    const out = {};
    for (const s of stats || []) out[s.name] = s.value;
    return out;
}

async function fetchTeam(cfg) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/teams/${cfg.team}`;
    const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('team http ' + res.status);
    const json = await res.json();
    const team = json.team || {};
    const items = (team.record && team.record.items) || [];
    const overall = items.find((i) => /overall/i.test(i.description || '')) || items[0];
    if (!overall) throw new Error('no overall record');
    const s = statMap(overall.stats);
    return {
        wins: Number(s.wins),
        losses: Number(s.losses),
        seed: Number.isFinite(Number(s.playoffSeed)) ? Number(s.playoffSeed) : null,
        gamesBehind: Number.isFinite(Number(s.gamesBehind)) ? Number(s.gamesBehind) : null,
        teamName: team.displayName || cfg.name || 'Raptors',
    };
}

async function fetchStanding(cfg) {
    const url = `https://site.api.espn.com/apis/v2/sports/${cfg.sport}/${cfg.league}/standings` +
        '?region=us&lang=en&contentorigin=espn&isqualified=true&type=0&level=2';
    const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json) return null;

    const needle = cfg.team.toLowerCase();
    for (const group of json.children || []) {
        for (const entry of group.standings && group.standings.entries || []) {
            const t = entry.team || {};
            const id = String(t.id || '').toLowerCase();
            const abbr = String(t.abbreviation || '').toLowerCase();
            if (id !== needle && abbr !== needle) continue;
            const s = statMap(entry.stats);
            return {
                conference: group.abbreviation || group.name || null,
                seed: Number.isFinite(Number(s.playoffSeed)) ? Number(s.playoffSeed) : null,
                gamesBehind: Number.isFinite(Number(s.gamesBehind)) ? Number(s.gamesBehind) : null,
                streak: s.streak || null,
            };
        }
    }
    return null;
}

/**
 * @param {string[]} modes any of record | standing | behind
 */
async function refresh(modes) {
    if (CACHE.state === 'ok' && Date.now() - CACHE.at < TTL_MS) return;

    const cfg = config();
    try {
        const team = await fetchTeam(cfg);
        const standing = await fetchStanding(cfg);

        CACHE.wins = team.wins;
        CACHE.losses = team.losses;
        CACHE.teamName = cfg.name || team.teamName;
        CACHE.seed = standing && standing.seed !== null ? standing.seed : team.seed;
        CACHE.gamesBehind = standing && standing.gamesBehind !== null ? standing.gamesBehind : team.gamesBehind;
        CACHE.conference = standing ? standing.conference : null;
        CACHE.streak = standing ? standing.streak : null;
        CACHE.method = 'espn';
    } catch (e) {
        // Keep the last good record instead of flashing an error for one
        // dropped request from the sports API.
        if (CACHE.state !== 'ok') {
            CACHE.state = 'error';
            CACHE.error = String((e && e.message) || e);
        }
        CACHE.at = Date.now() - TTL_MS + RETRY_MS;
        return;
    }

    CACHE.state = 'ok';
    CACHE.error = null;
    CACHE.at = Date.now();
}

function ordinal(n) {
    if (!Number.isFinite(n)) return '';
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * @param {string} mode record | standing | behind
 * @returns {{value:string, color:string, label:string}}
 */
function resolve(mode) {
    const m = String(mode || 'record').toLowerCase();
    const label = CACHE.teamName || 'Raptors';

    if (CACHE.state === 'unknown') return { value: '...', color: '#FBBF24', label };
    if (CACHE.state === 'error') return { value: 'ERR', color: '#F87171', label };

    if (!Number.isFinite(CACHE.wins) || !Number.isFinite(CACHE.losses)) {
        return { value: 'N/A', color: '#FBBF24', label };
    }

    if (m === 'standing') {
        const conf = CACHE.conference ? ' ' + CACHE.conference : '';
        const seed = CACHE.seed ? ordinal(CACHE.seed) : '?';
        return { value: seed + conf, color: '#F97316', label };
    }
    if (m === 'behind') {
        const gb = CACHE.gamesBehind;
        return {
            value: Number.isFinite(gb) ? gb + ' GB' : '—',
            color: '#FBBF24',
            label,
        };
    }
    return { value: CACHE.wins + '-' + CACHE.losses, color: '#F97316', label };
}

module.exports = {
    MODES: { record: 'Win-loss record', standing: 'League position', behind: 'Games behind' },
    TTL_MS,
    CACHE,
    refresh,
    resolve,
    config,
};
