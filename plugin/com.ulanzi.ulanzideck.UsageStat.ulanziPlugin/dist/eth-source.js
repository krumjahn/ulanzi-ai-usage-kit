'use strict';
/*
 * Ethereum price source for the AI Usage plugin.
 *
 * Public market data, no API key needed. CoinGecko, Binance and Coinbase are tried in that order.
 *
 * Modes:
 *   price  -> $2,104
 *   change -> +3.2% (24h)
 */

const TTL_MS = 60 * 1000;
const RETRY_MS = 15 * 1000;

// Cache holds the last successful read so the deck never shows a blank.
const CACHE = { state: 'unknown', price: null, change: null, currency: 'USD', at: 0 };

function formatPrice(value) {
    if (!Number.isFinite(value)) return null;
    const abs = Math.abs(value);
    if (abs >= 10000) return '$' + (value / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    if (abs >= 1000) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (abs >= 1) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

async function fromCoinbase() {
    const res = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`coinbase http ${res.status}`);
    const json = await res.json();
    const price = Number(json && json.data && json.data.amount);
    if (!Number.isFinite(price)) throw new Error('coinbase: bad payload');
    return { price, change: null, currency: (json.data.currency || 'USD').toUpperCase() };
}

// CoinGecko returns the price and the 24-hour change in one request.
async function fromCoingecko() {
    const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true',
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) throw new Error(`coingecko http ${res.status}`);
    const json = await res.json();
    const eth = json && json.ethereum;
    const price = Number(eth && eth.usd);
    if (!Number.isFinite(price)) throw new Error('coingecko: bad payload');
    const change = Number(eth.usd_24h_change);
    return {
        price,
        change: Number.isFinite(change) ? change : null,
        currency: 'USD',
    };
}

// Binance also publishes an explicit 24-hour percentage.
async function fromBinance() {
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`binance http ${res.status}`);
    const json = await res.json();
    const price = Number(json && json.lastPrice);
    if (!Number.isFinite(price)) throw new Error('binance: bad payload');
    const change = Number(json.priceChangePercent);
    return {
        price,
        change: Number.isFinite(change) ? change : null,
        currency: 'USD',
    };
}

/**
 * Refresh the cached price.
 * @param {string[]} modes  any of price | change
 */
async function refresh(modes) {
    const want = new Set((Array.isArray(modes) ? modes : [modes]).map((m) => String(m).toLowerCase()));
    if (CACHE.state === 'ok' && Date.now() - CACHE.at < TTL_MS) return;

    let data = null;
    let lastError = null;

    // Each source returns what it reliably has. Prefer one that gives both
    // price and 24-hour change; fall back through the others.
    for (const fn of [fromCoingecko, fromBinance, fromCoinbase]) {
        try {
            const got = await fn();
            if (got.change !== null) { data = got; break; }
            if (!data) data = got;
        } catch (e) {
            lastError = e;
        }
    }

    if (!data) {
        // A blip in the network should not wipe a price that was fine a
        // minute ago, so the last good reading stays on the button and the
        // next attempt happens shortly afterwards.
        if (CACHE.state !== 'ok') {
            CACHE.state = 'error';
            CACHE.error = String((lastError && lastError.message) || lastError);
        }
        CACHE.at = Date.now() - TTL_MS + RETRY_MS;
        return;
    }

    CACHE.price = data.price;
    CACHE.change = data.change;
    CACHE.currency = data.currency;
    CACHE.state = 'ok';
    CACHE.error = null;
    CACHE.at = Date.now();
}

/**
 * @param {string} mode price | change
 * @returns {{value:string, color:string}}
 */
function resolve(mode) {
    const m = String(mode || 'price').toLowerCase();

    if (CACHE.state === 'unknown') return { value: '...', color: '#FBBF24' };
    if (CACHE.state === 'error') return { value: 'ERR', color: '#F87171' };

    if (m === 'change') {
        if (CACHE.change === null || !Number.isFinite(CACHE.change)) {
            return { value: '--', color: '#FBBF24' };
        }
        const sign = CACHE.change >= 0 ? '+' : '';
        return {
            value: `${sign}${CACHE.change.toFixed(1)}%`,
            color: CACHE.change >= 0 ? '#34D399' : '#F87171',
        };
    }

    return { value: formatPrice(CACHE.price) || '---', color: '#A78BFA' };
}

module.exports = {
    MODES: { price: 'ETH price (USD)', change: '24-hour change' },
    TTL_MS,
    CACHE,
    refresh,
    resolve,
    formatPrice,
    fromCoinbase,
    fromCoingecko,
    fromBinance,
};
