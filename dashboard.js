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

app.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(` Dashboard is live at: http://localhost:${PORT}`);
    console.log(`==============================================\n`);
});
