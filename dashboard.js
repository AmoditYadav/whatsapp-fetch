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

app.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(` Dashboard is live at: http://localhost:${PORT}`);
    console.log(`==============================================\n`);
});
