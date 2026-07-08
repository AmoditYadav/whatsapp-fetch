const express = require('express');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const app = express();
const PORT = 3000;

const DATA_DIR = path.join(__dirname, 'data');
const EXPORT_FILE = path.join(DATA_DIR, 'messages.jsonl');

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
// Serve downloaded media
app.use('/media', express.static(path.join(DATA_DIR, 'media')));

// API endpoint to fetch all messages
app.get('/api/messages', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const messages = [];
    if (!fs.existsSync(EXPORT_FILE)) {
        return res.json([]);
    }
    
    const fileStream = fs.createReadStream(EXPORT_FILE);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    rl.on('line', (line) => {
        if (line.trim()) {
            try {
                messages.push(JSON.parse(line));
            } catch (e) {
                console.error("Error parsing a line:", e.message);
            }
        }
    });

    rl.on('close', () => {
        res.json(messages);
    });
});

// API endpoint to fetch the latest 20 messages for a specific group
app.get('/api/groups/:name/latest', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const groupName = req.params.name.toLowerCase().trim();
    const messages = [];
    if (!fs.existsSync(EXPORT_FILE)) {
        return res.json({ messages: [] });
    }
    
    const fileStream = fs.createReadStream(EXPORT_FILE);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    rl.on('line', (line) => {
        if (line.trim()) {
            try {
                const msg = JSON.parse(line);
                if (msg.group.toLowerCase().trim() === groupName) {
                    messages.push(msg);
                }
            } catch (e) {
                console.error("Error parsing a line:", e.message);
            }
        }
    });

    rl.on('close', () => {
        // Sort oldest to newest, then slice last 20 messages
        messages.sort((a, b) => a.timestamp - b.timestamp);
        const latest = messages.slice(-20);
        res.json({ messages: latest });
    });
});

// SSE connection pool for real-time Jarvis states and captions
let sseClients = [];

app.get('/api/jarvis/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    sseClients.push(res);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

app.post('/api/jarvis/state', express.json(), (req, res) => {
    const { state, caption } = req.body;
    
    // Broadcast state/caption update to all connected SSE clients
    const payload = JSON.stringify({ state, caption });
    sseClients.forEach(c => {
        c.write(`data: ${payload}\n\n`);
    });
    
    res.sendStatus(200);
});

// Queue for commands from the UI
let commandQueue = [];

app.post('/api/jarvis/command', express.json(), (req, res) => {
    const { command } = req.body;
    if (command) {
        commandQueue.push(command);
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

app.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(` Dashboard is live at: http://localhost:${PORT}`);
    console.log(`==============================================\n`);
});
