#!/usr/bin/env node
// A stdio bridge to TabPaladin's MCP endpoint, for MCP clients that only
// start local servers or only send a token through OAuth — Claude Desktop's
// claude_desktop_config.json, mostly. The client starts this as a local
// server; it forwards each message to https://<your server>/mcp with your
// token and hands back the answers. No dependencies (Node 18 or newer), no
// files written, nothing logged but errors, to stderr.
//
//   node tools/mcp_bridge.mjs https://tabs.example.com/mcp
//   with TABPALADIN_MCP_TOKEN=tpm_… in the environment (Settings › AI chats
//   in the TabPaladin web app makes one). Never on the command line: other
//   programs on the computer can read a process's arguments.
//
// Claude Desktop (Settings › Developer › Edit Config):
//   {"mcpServers": {"tabpaladin": {"command": "node",
//     "args": ["C:\\path\\to\\TabPaladin\\tools\\mcp_bridge.mjs", "https://tabs.example.com/mcp"],
//     "env": {"TABPALADIN_MCP_TOKEN": "tpm_…"}}}}
//
// The stdio side is newline-delimited JSON-RPC; the HTTP side is MCP
// Streamable HTTP (JSON or an SSE stream per request). Messages go one at a
// time, in order.

import readline from 'node:readline';

const url = process.argv[2] || process.env.TABPALADIN_MCP_URL || '';
const token = process.env.TABPALADIN_MCP_TOKEN || '';
const fail = (message) => { process.stderr.write(`[tabpaladin-mcp-bridge] ${message}\n`); };

if (!/^https?:\/\/\S+$/.test(url) || !token) {
    fail('Usage: TABPALADIN_MCP_TOKEN=tpm_… node mcp_bridge.mjs https://<your server>/mcp');
    process.exit(2);
}
if (url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url)) {
    fail('Warning: the token goes over plain http. Use https unless this is your own network.');
}

let protocolVersion = null;
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const errorFor = (msg, message, code = -32000) => {
    if (msg && msg.id !== undefined && msg.id !== null) write({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
};

async function forward(msg) {
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                Authorization: `Bearer ${token}`,
                ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {})
            },
            body: JSON.stringify(msg)
        });
    } catch (e) {
        fail(`Could not reach ${url}: ${e.message}`);
        return errorFor(msg, `TabPaladin could not be reached: ${e.message}`);
    }
    if (res.status === 202) return;
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
        const text = await res.text();
        for (const block of text.split(/\r?\n\r?\n/)) {
            const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try { handleAnswer(JSON.parse(data), msg); } catch (e) { fail(`Unreadable event: ${e.message}`); }
        }
        return;
    }
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!res.ok) {
        const message = body && body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
        if (res.status === 401) fail('The token was refused: it is unknown, revoked, or your password changed since. Make a new one in Settings › AI chats.');
        return errorFor(msg, `TabPaladin refused the request: ${message}`, body && body.error && body.error.code ? body.error.code : -32000);
    }
    if (body) handleAnswer(body, msg);
}

function handleAnswer(body, msg) {
    for (const m of Array.isArray(body) ? body : [body]) {
        if (m && m.result && msg && msg.method === 'initialize' && typeof m.result.protocolVersion === 'string') {
            protocolVersion = m.result.protocolVersion;
        }
        write(m);
    }
}

let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
    }
    queue = queue.then(() => forward(msg)).catch(e => { fail(e.message); errorFor(msg, e.message); });
});
rl.on('close', () => { queue.then(() => process.exit(0)); });
