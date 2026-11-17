'use strict';
/*
 * AI Usage for Ulanzi Studio
 * --------------------------
 * Renders live AI usage and business metrics on the deck.
 *
 * Usage actions: claude | openai (Codex) | cursor | grokbot | minimax | gemini
 * Business actions: attention (AI time) | disk | skool | stripe | revenuecat
 *
 * Usage buttons can display: remaining %, used %, tokens today, or time to reset.
 * Business buttons are passive readouts that show current state.
 */

const fs = require('fs');
const WebSocket = require('ws');
const source = require('./usage-source.js');
const attention = require('./attention-source.js');
const disk = require('./disk-source.js');
const skool = require('./skool-source.js');
const stripe = require('./stripe-source.js');
const revenuecat = require('./revenuecat-source.js');
const eth = require('./eth-source.js');
const ga = require('./ga-source.js');
const social = require('./social-source.js');
const grokbot = require('./grokbot-source.js');
const calendar = require('./calendar-source.js');
const raptors = require('./raptors-source.js');
const credentials = require('./credentials.js');

const PLUGIN_UUID = 'com.ulanzi.ulanzideck.UsageStat';
const REFRESH_MS = 5000;
const path = require('path');
const os = require('os');
const LOG_PATH = path.join(os.homedir(), '.ulanzi', 'plugin.log');

const ACTIONS = {
    claude:    { label: 'Claude',     color: '#FF8800', source: 'openusage' },
    openai:    { label: 'Codex',      color: '#10A37F', source: 'openusage' },
    codex:     { label: 'Codex',      color: '#10A37F', source: 'openusage' },
    cursor:    { label: 'Cursor',     color: '#8A94FF', source: 'openusage' },
    grokbot:   { label: 'GrokBot',    color: '#EDEDED', source: 'openusage' },
    minimax:   { label: 'MiniMax',    color: '#5E56FF', source: 'minimax' },
    gemini:    { label: 'Gemini',     color: '#4285F4', source: 'gemini' },
    attention: { label: 'AI Time',    color: '#34D399', source: 'attention' },
    disk:      { label: 'Disk',       color: '#34D399', source: 'disk' },
    skool:     { label: 'Skool',      color: '#FBBF24', source: 'skool' },
    stripe:    { label: 'Stripe',     color: '#635BFF', source: 'stripe' },
    revenuecat:{ label: 'RevenueCat', color: '#F26A4F', source: 'revenuecat' },
    eth:       { label: 'ETH',        color: '#A78BFA', source: 'eth' },
    ga:        { label: 'Analytics',  color: '#FBBF24', source: 'ga' },
    social:    { label: 'Threads',    color: '#F87171', source: 'social' },
    grokit:    { label: 'Grok IT',    color: '#EDEDED', source: 'grokbit' },
    calendar:  { label: 'Next Meeting', color: '#34D399', source: 'calendar' },
};

const MODES = ['remaining', 'used', 'tokens', 'reset'];

// Default display mode per source.
const SOURCE_DEFAULTS = {
    openusage: 'remaining',
    minimax: 'remaining',
    gemini: 'remaining',
    attention: 'today',
    disk: 'free',
    skool: 'members',
    stripe: 'month',
    revenuecat: 'actives',
    eth: 'price',
    ga: 'users',
    social: 'followers',
    calendar: 'name',
};

// Valid display modes per source.
const SOURCE_MODES = {
    attention: ['today', 'week', 'month', '30d', 'all'],
    disk: ['free', 'used', 'freepercent'],
    skool: Object.keys(skool.MODES),
    stripe: Object.keys(stripe.MODES),
    revenuecat: Object.keys(revenuecat.MODES),
    eth: Object.keys(eth.MODES),
    ga: Object.keys(ga.MODES),
    social: Object.keys(social.MODES),
    calendar: Object.keys(calendar.MODES),
};

// Default Skool community when the button has no explicit setting.
const DEFAULT_SKOOL = '';

function log(msg) {
    if (process.env.ULANZI_DEBUG !== '1') return;
    try {
        fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 });
        fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}
`, { mode: 0o600 });
        fs.chmodSync(LOG_PATH, 0o600);
    } catch (e) {}
}

function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Pick a font size that fits the text inside the 200x200 icon, so long
// event names are scaled down instead of being clipped at the edges.
function fitFont(text, maxSize, maxWidth) {
    const len = String(text || '').length;
    if (!len) return maxSize;
    const size = Math.floor(maxWidth / (len * 0.56));
    return Math.max(13, Math.min(maxSize, size));
}

function generateIcon(text, label, color) {
    const value = String(text);
    const size = fitFont(value, 54, 192);
    const labelSize = fitFont(label, 26, 192);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="200" height="200" version="1.1" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="200" fill="black"/>
  <text x="100" y="65" font-family="Arial" font-size="${labelSize}" fill="#AAAAAA" text-anchor="middle" font-weight="bold">${label}</text>
  <text x="100" y="140" font-family="Arial" font-size="${size}" fill="${color}" text-anchor="middle" font-weight="bold">${value}</text>
</svg>`;
    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

const address = process.argv[2] || '127.0.0.1';
const port = process.argv[3] || '3906';

const ws = new WebSocket(`ws://${address}:${port}`);
const ACTIVE_BUTTONS = {};   // context -> action uuid
const SETTINGS = {};         // context -> { Display: 'remaining' }
const LAST_VALUE = {};       // context -> last rendered value (for the log)

function actionKeyOf(actionUuid) {
    const parts = String(actionUuid || '').split('.');
    return (parts[parts.length - 1] || '').toLowerCase();
}

/**
 * The social inspector can change which account is tracked. Those choices are
 * written to the local config file so they survive a restart and so the
 * credential-free scrape knows which profile to read.
 */
function applySocialSettings(actionUuid, params) {
    if (actionKeyOf(actionUuid) !== 'social') return;
    if (!params || typeof params !== 'object') return;
    const platform = String(params.Platform || params.platform || '').trim().toLowerCase();
    const handle = String(params.Handle || params.handle || '').trim().replace(/^@/, '');
    try {
        if (platform && ['threads', 'instagram'].includes(platform)) {
            credentials.writeField('social', 'platform', platform);
        }
        if (handle) {
            credentials.writeField('social', 'handle', handle);
        }
    } catch (e) {
        log('social settings not saved: ' + String((e && e.message) || e));
    }
}

// Which display mode applies to this button, falling back to the source default.
function modeFor(def, settings) {
    const raw = String(settings.Display || settings.display || '').toLowerCase();
    const fallback = SOURCE_DEFAULTS[def.source] || 'remaining';
    if (!raw) return fallback;
    if (def.source === 'openusage') return MODES.includes(raw) ? raw : fallback;
    const allowed = SOURCE_MODES[def.source];
    if (allowed && !allowed.includes(raw)) return fallback;
    return raw;
}

function valueFor(actionUuid, context) {
    const key = actionKeyOf(actionUuid);
    const def = ACTIONS[key];
    if (!def) return { label: 'AI', color: '#ffffff', value: '---' };

    let label = def.label;
    let color = def.color;
    const settings = SETTINGS[context] || {};
    const mode = modeFor(def, settings);

    let value = null;
    if (def.source === 'openusage') {
        if (!source.cache.ok) {
            value = 'OFF';
        } else {
            value = source.resolveOpenUsageValue(key, mode);
            if (value === null) value = '---';
        }
    } else if (def.source === 'minimax') {
        value = source.getMinimaxUsage();
    } else if (def.source === 'gemini') {
        value = source.getGeminiUsage();
    } else if (def.source === 'attention') {
        // AI attention time from the AI Usage (AttentionLedger) tracker.
        const period = String(settings.Period || settings.period || 'today').toLowerCase();
        const tool = String(settings.Tool || settings.tool || '').trim();
        value = attention.resolve(period, tool);
        if (value === null) value = '---';
        if (tool) label = tool.length > 10 ? tool.slice(0, 10) : tool;
    } else if (def.source === 'disk') {
        // Free space on the volume that holds your home directory.
        value = disk.resolve(mode);
        if (value === null) value = '---';
        color = disk.color();
    } else if (def.source === 'skool') {
        const slug = String(settings.Community || settings.community || '').trim() || DEFAULT_SKOOL;
        const r = skool.resolve(slug, mode);
        value = r.value;
        color = r.color;
        const custom = String(settings.Label || settings.label || '').trim();
        if (custom) label = custom;
    } else if (def.source === 'stripe') {
        const r = stripe.resolve(mode);
        value = r.value;
        color = r.color;
    } else if (def.source === 'revenuecat') {
        const r = revenuecat.resolve(mode);
        value = r.value;
        color = r.color;
    } else if (def.source === 'eth') {
        const r = eth.resolve(mode);
        value = r.value;
        color = r.color;
    } else if (def.source === 'ga') {
        const r = ga.resolve(mode);
        value = r.value;
        color = r.color;
    } else if (def.source === 'social') {
        const r = social.resolve(mode);
        value = r.value;
        color = r.color;
        label = r.label || def.label;
    } else if (def.source === 'grokbit') {
        // The Grok IT button can show something else on the face of it while
        // still opening Grok Bot when pressed.
        const disp = String(settings.Display || settings.display || 'agent').toLowerCase();
        if (disp.startsWith('raptors_')) {
            const r = raptors.resolve(disp.slice('raptors_'.length));
            value = r.value;
            color = r.color;
            label = r.label || def.label;
        } else {
            const r = grokbot.resolve(settings);
            value = r.value;
            color = r.color;
        }
    } else if (def.source === 'calendar') {
        const r = calendar.resolve(mode);
        value = r.value;
        color = r.color;
        label = r.label || def.label;
    }

    return { label, color, value: value === null ? '---' : value };
}

function update(context, actionUuid) {
    const parts = context.split('___');
    if (parts.length < 3) return;
    const { label, color, value } = valueFor(actionUuid, context);

    if (LAST_VALUE[context] !== value) {
        LAST_VALUE[context] = value;
        log(`${actionUuid.split('.').pop()} -> ${value}`);
    }

    const payload = {
        cmd: 'state',
        uuid: PLUGIN_UUID,
        param: {
            statelist: [{
                uuid: parts[0],
                key: parts[1],
                actionid: parts[2],
                type: 1,
                data: generateIcon(escapeXml(value), escapeXml(label), color),
                textData: '',
                showtext: false,
            }],
        },
    };
    try { ws.send(JSON.stringify(payload)); } catch (e) {}
}

function register(jsn) {
    const context = jsn.uuid + '___' + jsn.key + '___' + jsn.actionid;
    ACTIVE_BUTTONS[context] = jsn.uuid;
    if (jsn.param && typeof jsn.param === 'object') SETTINGS[context] = jsn.param;
    applySocialSettings(jsn.uuid, jsn.param);
    update(context, jsn.uuid);
    scheduleBusinessRefresh();
}

ws.on('open', () => {
    log('connected');
    ws.send(JSON.stringify({ code: 0, cmd: 'connected', uuid: PLUGIN_UUID }));
});

ws.on('message', (data) => {
    let jsn;
    try { jsn = JSON.parse(data.toString()); } catch (e) { return; }
    if (!jsn) return;

    switch (jsn.cmd) {
        case 'add':
        case 'setactive':
            register(jsn);
            break;

        case 'clear': {
            const list = Array.isArray(jsn.param) ? jsn.param : [jsn.param];
            for (const item of list) {
                if (!item) continue;
                const context = item.context
                    ? item.context
                    : item.uuid + '___' + item.key + '___' + item.actionid;
                delete ACTIVE_BUTTONS[context];
                delete SETTINGS[context];
            }
            break;
        }

        case 'run': {
            // A key was pressed. Only the Grok Bot action acts on press;
            // every other button on this plugin is a passive readout.
            const context = jsn.uuid + '___' + jsn.key + '___' + jsn.actionid;
            const key = actionKeyOf(jsn.uuid);
            if (key === 'grokit') {
                const settings = SETTINGS[context] || {};
                const agentId = String(settings.AgentId || settings.agentId || grokbot.IT_AGENT_ID).trim();
                const prompt = String(settings.Prompt || settings.prompt || grokbot.DEFAULT_PROMPT).trim();
                const send = String(settings.Send || settings.send || 'no').toLowerCase() === 'yes';
                grokbot.trigger({ agentId, prompt, send })
                    .then((r) => log(`run grokit -> ${r.ok ? 'opened' : 'failed: ' + r.error}`))
                    .catch((e) => log('run grokit error: ' + String((e && e.message) || e)));
            } else if (key === 'calendar') {
                const settings = SETTINGS[context] || {};
                calendar.openApp(settings)
                    .then((r) => log('run calendar -> ' + (r.ok ? 'opened ' + r.target : 'failed: ' + r.error)))
                    .catch((e) => log('run calendar error: ' + String((e && e.message) || e)));
            }
            break;
        }

        case 'paramfromapp':
        case 'paramfromplugin': {
            if (!jsn.param) return;
            const context = jsn.uuid + '___' + jsn.key + '___' + jsn.actionid;
            SETTINGS[context] = jsn.param;
            applySocialSettings(jsn.uuid, jsn.param);
            // Forward inspector changes to the host so they are persisted.
            if (jsn.cmd === 'paramfromplugin') {
                try {
                    ws.send(JSON.stringify({
                        cmd: 'paramfromplugin',
                        code: 0,
                        uuid: jsn.uuid,
                        key: jsn.key,
                        actionid: jsn.actionid,
                        param: jsn.param,
                    }));
                } catch (e) {}
            }
            if (ACTIVE_BUTTONS[context]) update(context, ACTIVE_BUTTONS[context]);
            scheduleBusinessRefresh();
            break;
        }

        default:
            break;
    }
});

ws.on('error', (e) => log('ws error: ' + String(e)));

// Work out which business readouts are actually on the deck, so we only
// spend API calls on figures that are on screen.
function businessNeeds() {
    const needs = {
        stripe: new Set(), revenuecat: new Set(), skool: new Set(),
        eth: new Set(), ga: new Set(), social: new Set(), calendar: new Set(),
        raptors: new Set(),
    };

    for (const context in ACTIVE_BUTTONS) {
        const def = ACTIONS[actionKeyOf(ACTIVE_BUTTONS[context])];
        if (!def) continue;
        const settings = SETTINGS[context] || {};
        const mode = modeFor(def, settings);

        if (def.source === 'stripe') needs.stripe.add(mode);
        else if (def.source === 'revenuecat') needs.revenuecat.add(mode);
        else if (def.source === 'skool') {
            const slug = String(settings.Community || settings.community || '').trim() || DEFAULT_SKOOL;
            needs.skool.add(slug);
        }
        else if (def.source === 'eth') needs.eth.add(mode);
        else if (def.source === 'ga') needs.ga.add(mode);
        else if (def.source === 'social') needs.social.add(mode);
        else if (def.source === 'calendar') needs.calendar.add(mode);
        else if (def.source === 'grokbit') {
            const disp = String(settings.Display || settings.display || 'agent').toLowerCase();
            if (disp.startsWith('raptors_')) needs.raptors.add(disp.slice('raptors_'.length));
        }
    }

    return needs;
}

// Refresh the business sources. Each one self-throttles (60s for Stripe and
// RevenueCat, 10 minutes for Skool), so this is cheap to call every cycle.
async function refreshBusiness() {
    const needs = businessNeeds();

    const jobs = [];
    if (needs.stripe.size) jobs.push(stripe.refresh([...needs.stripe]));
    if (needs.revenuecat.size) jobs.push(revenuecat.refresh([...needs.revenuecat]));
    for (const slug of needs.skool) jobs.push(skool.refresh(slug));
    if (needs.eth.size) jobs.push(eth.refresh([...needs.eth]));
    if (needs.ga.size) {
        // GA's period is a per-button setting, so use the first one's value.
        let period = 'today';
        for (const context in ACTIVE_BUTTONS) {
            const def = ACTIONS[actionKeyOf(ACTIVE_BUTTONS[context])];
            if (def && def.source === 'ga') {
                const s = SETTINGS[context] || {};
                period = String(s.Period || s.period || 'today').toLowerCase();
                break;
            }
        }
        jobs.push(ga.refresh([...needs.ga], period));
    }
    if (needs.social.size) jobs.push(social.refresh([...needs.social]));
    if (needs.raptors.size) jobs.push(raptors.refresh([...needs.raptors]));

    // The macOS Calendar query takes over a minute, so it is deliberately
    // not awaited here: it must never hold up the 5 second render loop that
    // keeps the usage percentages moving. The source throttles itself, so
    // overlapping ticks cannot start a second query.
    if (needs.calendar.size) {
        calendar.refresh([...needs.calendar])
            .then(() => {
                for (const context in ACTIVE_BUTTONS) update(context, ACTIVE_BUTTONS[context]);
            })
            .catch((e) => log('calendar refresh error: ' + String((e && e.message) || e)));
    }

    if (!jobs.length) return;
    try {
        await Promise.all(jobs);
    } catch (e) {
        log('business refresh error: ' + String((e && e.message) || e));
    }
}

// Kick off a business refresh shortly after a button appears, so a newly
// placed button fills in fast instead of showing "..." for a whole cycle.
let businessTimer = null;
function scheduleBusinessRefresh() {
    if (businessTimer) return;
    businessTimer = setTimeout(() => {
        businessTimer = null;
        refreshBusiness().then(() => {
            for (const context in ACTIVE_BUTTONS) update(context, ACTIVE_BUTTONS[context]);
        });
    }, 250);
}

setInterval(async () => {
    await source.refresh();
    await refreshBusiness();
    for (const context in ACTIVE_BUTTONS) update(context, ACTIVE_BUTTONS[context]);
}, REFRESH_MS);

source.refresh();
