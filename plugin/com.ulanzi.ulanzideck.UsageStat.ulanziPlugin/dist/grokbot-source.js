'use strict';
/*
 * Grok Bot "IT agent" action for the AI Usage plugin.
 *
 * On a key press this opens Grok Bot with the IT agent selected and a prompt
 * already typed into the composer:
 *
 *   grokbot://app/v1/prompt?id=<agentId>&text=<message>
 *
 * That deep link is handled by Grok Bot itself (its route table lives in the
 * app's main process), so no UI automation and no Accessibility permission
 * are needed to open the right agent with the right text.
 *
 * The IT agent is the agent that frees disk space. Its id is set per
 * button, so put your own agent id in the button's settings.
 *
 * The composer is left as a draft, so the message still needs one Enter
 * keypress in Grok Bot. If the user grants this terminal Accessibility
 * access, "Send" can additionally press Enter for them.
 */

const { spawn } = require('child_process');

// The agent Grok Bot selects when no id is supplied.
const IT_AGENT_ID = '';
const DEFAULT_PROMPT = 'Clear some space on my laptop';
const APP_NAME = 'Grok Bot';
const MAX_TEXT = 1000; // matches Grok Bot's own deep-link limit

/**
 * Build the grokbot:// deep link.
 * @param {string} agentId  agent uuid, or '' for the default agent
 * @param {string} text     the message to pre-fill
 */
function buildDeepLink(agentId, text) {
    const message = String(text || '').trim().slice(0, MAX_TEXT);
    if (!message) return null;

    const parts = [];
    const id = String(agentId || '').trim();
    if (id) parts.push(`id=${encodeURIComponent(id)}`);
    parts.push(`text=${encodeURIComponent(message)}`);
    return `grokbot://app/v1/prompt?${parts.join('&')}`;
}

/**
 * Open Grok Bot with the prompt.
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.prompt
 * @param {boolean} opts.send  try to press Enter as well
 * @returns {Promise<{ok:boolean, url:string, error?:string}>}
 */
async function trigger(opts) {
    const agentId = String((opts && opts.agentId) || IT_AGENT_ID).trim();
    const prompt = String((opts && opts.prompt) || DEFAULT_PROMPT);

    const url = buildDeepLink(agentId, prompt);
    if (!url) return { ok: false, url: '', error: 'empty prompt' };

    // Hand the URL to macOS, which routes it to the registered handler.
    await new Promise((resolve) => {
        const child = spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true });
        child.on('error', () => resolve());
        child.unref();
        setTimeout(resolve, 1500);
    });

    if (opts && opts.send) {
        // Optional: press Enter in the newly focused Grok Bot window.
        // Needs this terminal to be allowed assistive access.
        await trySend();
    }

    return { ok: true, url };
}

// Best-effort auto-send. Silently does nothing when Accessibility is denied.
async function trySend() {
    return new Promise((resolve) => {
        const script = `
tell application "${APP_NAME}" to activate
delay 1.2
tell application "System Events"
  tell process "${APP_NAME}"
    keystroke return
  end tell
end tell`;
        const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
        setTimeout(() => resolve(false), 5000);
    });
}

/**
 * Resolve the display text for the button (idle state).
 * @param {object} settings
 */
function resolve(settings) {
    const s = settings || {};
    const agentId = String(s.AgentId || s.agentId || IT_AGENT_ID).trim();
    const prompt = String(s.Prompt || s.prompt || DEFAULT_PROMPT).trim();

    if (!prompt) return { value: 'NO MSG', color: '#F87171' };
    return {
        value: agentId === IT_AGENT_ID ? 'IT' : 'Grok',
        color: '#EDEDED',
    };
}

module.exports = {
    IT_AGENT_ID,
    DEFAULT_PROMPT,
    APP_NAME,
    MAX_TEXT,
    buildDeepLink,
    trigger,
    trySend,
    resolve,
};
