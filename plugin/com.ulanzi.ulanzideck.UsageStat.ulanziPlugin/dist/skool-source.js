'use strict';
/*
 * Skool community source for the AI Usage plugin.
 *
 * Skool has no public read API, but every community page embeds its metadata
 * in the Next.js __NEXT_DATA__ blob, which is readable without an account:
 *
 *   props.pageProps.currentGroup.metadata.totalMembers
 *   props.pageProps.currentGroup.metadata.totalOnlineMembers
 *   props.pageProps.currentGroup.metadata.displayName
 *
 * We cache for 10 minutes so the deck never hammers skool.com.
 */

const TTL_MS = 10 * 60 * 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// slug -> { name, members, online, at, error }
const CACHE = {};

const KNOWN = {};

function knownSlugs() {
    return Object.keys(KNOWN);
}

function displayNameFor(slug) {
    return KNOWN[slug] || slug;
}

async function fetchCommunity(slug) {
    const url = `https://www.skool.com/${encodeURIComponent(slug)}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);

    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no __NEXT_DATA__');

    let data;
    try {
        data = JSON.parse(m[1]);
    } catch (e) {
        throw new Error('bad __NEXT_DATA__');
    }

    const group = data && data.props && data.props.pageProps && data.props.pageProps.currentGroup;
    if (!group) throw new Error('no currentGroup');

    const md = group.metadata || {};
    const members = Number(md.totalMembers);
    const online = Number(md.totalOnlineMembers);
    if (!Number.isFinite(members)) throw new Error('no member count');

    return {
        name: md.displayName || group.name || displayNameFor(slug),
        members: members,
        online: Number.isFinite(online) ? online : 0,
    };
}

// Fetch one community if its cache entry is stale. Never throws.
async function refresh(slug) {
    const key = String(slug || '').trim();
    if (!key) return;

    const entry = CACHE[key];
    if (entry && !entry.error && Date.now() - entry.at < TTL_MS) return;
    if (entry && entry.error && Date.now() - entry.at < 60 * 1000) return; // back off on errors

    try {
        const data = await fetchCommunity(key);
        CACHE[key] = { name: data.name, members: data.members, online: data.online, at: Date.now(), error: null };
    } catch (e) {
        CACHE[key] = Object.assign({}, entry, { at: Date.now(), error: String((e && e.message) || e) });
    }
}

// "1322" -> "1,322"
function withCommas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Resolve the display string for a community.
 * @param {string} slug   community slug, e.g. "my-community-1234"
 * @param {string} mode   "members" | "online"
 * @returns {{value:string, color:string, label:string}}
 */
function resolve(slug, mode) {
    const key = String(slug || '').trim();
    const label = 'Skool';

    if (!key) return { value: 'SLUG?', color: '#F87171', label };

    const entry = CACHE[key];
    if (!entry) return { value: '...', color: '#FBBF24', label };
    if (entry.error && !entry.members) return { value: 'ERR', color: '#F87171', label };

    const m = String(mode || 'members').toLowerCase();
    if (m === 'online') {
        return { value: String(entry.online), color: '#34D399', label };
    }
    return { value: withCommas(entry.members), color: '#FBBF24', label };
}

// Last known name for a community, for the property inspector.
function nameFor(slug) {
    const key = String(slug || '').trim();
    const entry = CACHE[key];
    return (entry && entry.name) || displayNameFor(key);
}

module.exports = {
    MODES: { members: 'Total members', online: 'Online now' },
    TTL_MS,
    CACHE,
    KNOWN,
    knownSlugs,
    displayNameFor,
    nameFor,
    fetchCommunity,
    refresh,
    resolve,
    withCommas,
};
