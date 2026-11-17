'use strict';
/*
 * Disk space source for the AI Usage plugin.
 *
 * On APFS the sealed system volume ("/") reports its own used count, which
 * badly understates how full the disk really is. The volume that actually
 * holds your data is the one containing your home directory, so that is what
 * we measure.
 *
 * df -k <home> gives:
 *   total_k  used_k  avail_k  capacity
 */

const os = require('os');
const { spawnSync } = require('child_process');

const KIB = 1024;

// Reads the volume that contains the home directory.
function readVolume() {
    try {
        const cmd = spawnSync('df', ['-k', os.homedir()], { timeout: 4000 });
        if (cmd.status !== 0) return null;
        const line = cmd.stdout.toString().trim().split('\n').pop();
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) return null;

        const totalKib = Number(parts[1]);
        const usedKib = Number(parts[2]);
        const availKib = Number(parts[3]);
        const capacity = parts[4];
        if (!Number.isFinite(totalKib) || !Number.isFinite(availKib)) return null;

        return {
            total: totalKib * KIB,
            used: usedKib * KIB,
            free: availKib * KIB,
            capacity: capacity,
            mount: parts[parts.length - 1],
        };
    } catch (e) {
        return null;
    }
}

// "12G" / "1.1T" / "512M"
function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
    const abs = Math.abs(bytes);
    const units = [
        { limit: 1024 ** 4, div: 1024 ** 4, suffix: 'T' },
        { limit: 1024 ** 3, div: 1024 ** 3, suffix: 'G' },
        { limit: 1024 ** 2, div: 1024 ** 2, suffix: 'M' },
        { limit: 1024, div: 1024, suffix: 'K' },
    ];
    for (const u of units) {
        if (abs >= u.limit) {
            const n = bytes / u.div;
            return (n >= 100 || Number.isInteger(n) ? Math.round(n) : Number(n.toFixed(1))) + u.suffix;
        }
    }
    return Math.round(bytes) + 'B';
}

// Severity colouring: the whole point of watching free space.
function severity(free) {
    const gib = free / (1024 ** 3);
    if (gib < 10) return '#F87171';   // red
    if (gib < 30) return '#FBBF24';   // amber
    return '#34D399';                 // green
}

function resolve(mode) {
    const vol = readVolume();
    if (!vol) return null;

    switch (mode) {
        case 'used': {
            // df's own capacity figure (the number macOS shows as "disk full").
            const pct = parseInt(vol.capacity, 10);
            if (Number.isFinite(pct)) return `${pct}%`;
            const used = vol.used / (vol.used + vol.free);
            return `${Math.round(used * 100)}%`;
        }
        case 'freepercent': {
            const pct = (vol.free / vol.total) * 100;
            return `${Math.max(0, Math.round(pct))}%`;
        }
        case 'free':
        default:
            return formatBytes(vol.free);
    }
}

function color() {
    const vol = readVolume();
    if (!vol) return '#34D399';
    return severity(vol.free);
}

module.exports = {
    MODES: { free: 'Free space', used: 'Used %', freepercent: 'Free %' },
    readVolume,
    formatBytes,
    severity,
    resolve,
    color,
};
