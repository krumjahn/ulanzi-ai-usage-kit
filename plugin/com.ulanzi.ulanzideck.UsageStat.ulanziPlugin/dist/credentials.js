'use strict';
/*
 * Credentials for the business-metric actions (Stripe, RevenueCat).
 *
 * Stored in one local file so the plugin never has keys baked into code:
 *   ~/.ulanzi/stats.json   (mode 600)
 *
 * Shape:
 *   {
 *     "stripe":     { "secretKey": "rk_live_..." },
 *     "revenuecat": { "secretKey": "sk_...", "projectId": "proj1ab2c3d" }
 *   }
 *
 * The file is read fresh each refresh so keys can be added without
 * restarting Ulanzi Studio.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(os.homedir(), '.ulanzi', 'stats.json');

let cache = { at: 0, data: {} };

function read() {
    if (Date.now() - cache.at < 2000) return cache.data;
    let data = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
        }
    } catch (e) {
        data = {};
    }
    cache = { at: Date.now(), data };
    return data;
}

function section(name) {
    const v = read()[name];
    return v && typeof v === 'object' ? v : {};
}

function stripeKey() {
    return String(section('stripe').secretKey || '').trim();
}

function revenuecatSecret() {
    return String(section('revenuecat').secretKey || '').trim();
}

function revenuecatProject() {
    return String(section('revenuecat').projectId || '').trim();
}

/**
 * The OAuth client the Gemini button refreshes its token with.
 * Kept in the config file so no key is baked into the code.
 */
function geminiClientId() {
    return String(section('gemini').clientId || '').trim();
}

function geminiClientSecret() {
    return String(section('gemini').clientSecret || '').trim();
}

/**
 * Persist a field into a section of the config file, keeping the file at
 * mode 600. Used by the social inspector so the account being tracked can be
 * changed from the deck without editing files by hand.
 *
 * @param {string} sectionName
 * @param {string} key
 * @param {string} value
 */
function writeField(sectionName, key, value) {
    const directory = path.dirname(CONFIG_PATH);
    if ((fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) ||
        (fs.existsSync(CONFIG_PATH) && fs.lstatSync(CONFIG_PATH).isSymbolicLink())) {
        throw new Error('symlinked configuration is not supported');
    }
    const data = fs.existsSync(CONFIG_PATH)
        ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid configuration');
    if (!['social'].includes(sectionName) || !['platform', 'handle'].includes(key)) throw new Error('unsupported setting');
    if (!data[sectionName] || typeof data[sectionName] !== 'object') data[sectionName] = {};
    data[sectionName][key] = value;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = path.join(directory, '.stats-' + require('crypto').randomBytes(12).toString('hex'));
    try {
        fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, CONFIG_PATH);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    cache = { at: Date.now(), data };
    return data;
}

module.exports = {
    CONFIG_PATH,
    read,
    section,
    stripeKey,
    revenuecatSecret,
    revenuecatProject,
    geminiClientId,
    geminiClientSecret,
    writeField,
};
