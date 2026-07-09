const express = require('express');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const app = express();
const PORT = 3000;

const DATA_DIR = path.join(__dirname, 'data');
const EXPORT_FILE = path.join(DATA_DIR, 'messages.jsonl');

// ─── In-memory message cache ─────────────────────────────────────────────────
// We load the entire file once and then watch for changes so we never
// re-parse the whole 3MB file on every API hit.
let messageCache = [];
let cacheReady   = false;

function loadCache() {
    if (!fs.existsSync(EXPORT_FILE)) { cacheReady = true; return; }
    const tmp = [];
    const fileStream = fs.createReadStream(EXPORT_FILE);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    rl.on('line', (line) => {
        if (!line.trim()) return;
        try { tmp.push(JSON.parse(line)); } catch (_) {}
    });
    rl.on('close', () => {
        messageCache = tmp;
        cacheReady   = true;
        console.log(`[cache] Loaded ${messageCache.length} messages into memory.`);
    });
}

// Append new messages as the JSONL file grows (tail-watch using fs.watchFile)
let lastKnownSize = 0;
function watchForNewMessages() {
    if (!fs.existsSync(EXPORT_FILE)) { setTimeout(watchForNewMessages, 5000); return; }
    lastKnownSize = fs.statSync(EXPORT_FILE).size;
    fs.watchFile(EXPORT_FILE, { interval: 1000 }, (curr) => {
        if (curr.size <= lastKnownSize) return;
        // Read only the new bytes
        const stream = fs.createReadStream(EXPORT_FILE, { start: lastKnownSize, end: curr.size - 1 });
        lastKnownSize = curr.size;
        let buf = '';
        stream.on('data', chunk => { buf += chunk.toString('utf8'); });
        stream.on('end', () => {
            const lines = buf.split('\n');
            let added = 0;
            for (const line of lines) {
                if (!line.trim()) continue;
                try { messageCache.push(JSON.parse(line)); added++; } catch (_) {}
            }
            if (added) console.log(`[cache] Appended ${added} new messages (total: ${messageCache.length}).`);
        });
    });
}

// Bootstrap
loadCache();
watchForNewMessages();

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(DATA_DIR, 'media')));

// ─── GET /api/messages — return all cached messages ──────────────────────────
app.get('/api/messages', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json(messageCache);
});

// ─── GET /api/groups/:name/latest — return last 20 for a group ───────────────
app.get('/api/groups/:name/latest', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const groupName = req.params.name.toLowerCase().trim();
    const filtered  = messageCache.filter(m => m.group && m.group.toLowerCase().trim() === groupName);
    filtered.sort((a, b) => a.timestamp - b.timestamp);
    res.json({ messages: filtered.slice(-20) });
});

// ─── GET /api/groups — return list of unique group names ─────────────────────
app.get('/api/groups', (req, res) => {
    const groups = [...new Set(messageCache.map(m => m.group).filter(Boolean))].sort();
    res.json(groups);
});

// ─── SSE — real-time Jarvis state + caption ───────────────────────────────────
let sseClients = [];

app.get('/api/jarvis/stream', (req, res) => {
    res.setHeader('Content-Type',                'text/event-stream');
    res.setHeader('Cache-Control',               'no-cache');
    res.setHeader('Connection',                  'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Send initial idle state so the frontend can show the right colour
    res.write(`data: ${JSON.stringify({ state: 'idle', caption: '' })}\n\n`);
    sseClients.push(res);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

app.post('/api/jarvis/state', express.json(), (req, res) => {
    const { state, caption } = req.body;
    const payload = JSON.stringify({ state, caption: caption ?? '' });
    sseClients.forEach(c => c.write(`data: ${payload}\n\n`));
    res.sendStatus(200);
});

// ─── Command queue ────────────────────────────────────────────────────────────
let commandQueue = [];

app.post('/api/jarvis/command', express.json(), (req, res) => {
    const { command } = req.body;
    if (command && command.trim()) {
        commandQueue.push(command.trim());
        console.log(`[cmd] Queued: "${command.trim()}" (queue depth: ${commandQueue.length})`);
    }
    res.sendStatus(200);
});

app.get('/api/jarvis/command', (req, res) => {
    if (commandQueue.length > 0) {
        const cmd = commandQueue.shift();
        res.json({ command: cmd });
    } else {
        res.json({ command: null });
    }
});

// ─── Startup ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(` Dashboard is live at: http://localhost:${PORT}`);
    console.log(`==============================================\n`);
});
