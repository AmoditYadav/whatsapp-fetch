const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ==========================================
// CONFIGURATION
// ==========================================
const DATA_DIR = path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const EXPORT_FILE = path.join(DATA_DIR, 'messages.jsonl');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

let TARGET_GROUPS = [];
let isDisconnecting = false;
const savedMessageIds = new Set(); // Prevent duplicate saves

// Load existing message IDs to prevent duplicates on restart
if (fs.existsSync(EXPORT_FILE)) {
    const lines = fs.readFileSync(EXPORT_FILE, 'utf-8').split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const data = JSON.parse(line);
            if (data.id) savedMessageIds.add(data.id);
        } catch (e) {}
    }
    console.log(`[i] Loaded ${savedMessageIds.size} existing message IDs to prevent duplicate downloads.`);
}

// ==========================================
// SUPPRESS EXPECTED DISCONNECT ERRORS
// ==========================================
process.on('unhandledRejection', (error) => {
    const msg = error && error.message ? error.message : String(error);
    const isExpected =
        msg.includes('EBUSY') ||
        msg.includes('Execution context was destroyed') ||
        msg.includes('Protocol error') ||
        msg.includes('Session closed') ||
        msg.includes('Target closed') ||
        msg.includes('Navigation failed');

    if (isExpected) return;
    console.error('Unhandled Error:', error);
});

function killStaleBrowserLock() {
    const authDir = path.join(__dirname, '.wwebjs_auth');
    const authDirEscaped = authDir.replace(/\\/g, '\\\\');

    // Step 1: Kill any Chrome/Chromium process that is holding open our wwebjs_auth userDataDir.
    // We use PowerShell to match by command-line argument, so we don't kill the user's real Chrome.
    try {
        const { execSync } = require('child_process');
        const cmd = `powershell -Command "Get-WmiObject Win32_Process | Where-Object { $_.Name -like '*chrome*' -and $_.CommandLine -like '*wwebjs_auth*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`;
        execSync(cmd, { stdio: 'ignore' });
        console.log('[i] Killed any stale browser processes from previous session.');
    } catch (_) {
        // WMI not available or no matching processes — safe to continue
    }

    // Step 2: Give the OS 1 second to release file handles before we start a new process
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);

    // Step 3: Delete leftover lock files (belt-and-suspenders)
    const lockFiles = [
        path.join(authDir, 'session', 'SingletonLock'),
        path.join(authDir, 'session', 'SingletonCookie'),
        path.join(authDir, 'session', 'lockfile'),
    ];
    lockFiles.forEach((f) => {
        try {
            if (fs.existsSync(f)) {
                fs.unlinkSync(f);
                console.log(`[i] Removed stale lock file: ${path.basename(f)}`);
            }
        } catch (_) {}
    });
}

// ==========================================
// BOT LOGIC
// ==========================================
function startClient() {
    isDisconnecting = false;

    // Always clear stale lock files before launching a new browser instance
    killStaleBrowserLock();

    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('\n--- Login Required ---');
        console.log('Scan the QR code below with your WhatsApp:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', async () => {
        console.log('\n✅ Client is ready and connected!');

        try {
            const chats = await client.getChats();
            const allGroups = chats.filter((c) => c.isGroup);

            console.log('\n📋 All groups found on your WhatsApp:');
            allGroups.forEach((g, i) => console.log(`   [${i + 1}] "${g.name}"`));
            console.log('');

            if (allGroups.length === 0) {
                console.log('⚠️  No WhatsApp groups found on this account!');
            } else {
                console.log(`✅ Exporting history for all ${allGroups.length} group(s):`);

                // Fetch history for all groups concurrently (at once)
                await Promise.all(allGroups.map(async (chat) => {
                    console.log(`⏳ Fetching history for: "${chat.name}"...`);
                    try {
                        const messages = await chat.fetchMessages({ limit: 1000 });
                        console.log(`   Found ${messages.length} messages in history for "${chat.name}".`);

                        let saved = 0;
                        for (const msg of messages) {
                            await saveMessage(chat.name, msg);
                            saved++;
                        }
                        console.log(`   ✅ Saved ${saved} messages from "${chat.name}".`);
                    } catch (err) {
                        console.error(`   ❌ Error fetching history for "${chat.name}":`, err.message);
                    }
                }));

                console.log('\n🟢 History export complete. Now listening for new incoming messages...\n');
            }
        } catch (error) {
            if (!isDisconnecting) {
                console.error('Error fetching chats:', error);
            }
        }
    });

    client.on('message', async (msg) => {
        try {
            const chat = await msg.getChat();
            if (chat.isGroup) {
                await saveMessage(chat.name, msg);
                const author = await msg.getContact();
                console.log(
                    `[NEW] ${chat.name} | ${author.pushname || author.number}: ${msg.body || '(Media)'}`
                );
            }
        } catch (err) {
            if (!isDisconnecting) {
                console.error('Error handling message:', err.message);
            }
        }
    });

    client.on('disconnected', (reason) => {
        if (isDisconnecting) return;
        isDisconnecting = true;

        console.log(`\n[!] Disconnected (${reason})`);
        console.log('[!] Waiting for browser to close, then restarting...');

        client.destroy().catch(() => {}).finally(() => {
            setTimeout(() => {
                const authPath = path.join(__dirname, '.wwebjs_auth');
                try {
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                        console.log('[i] Old session cleared.');
                    }
                } catch (_) {}
                console.log('\nRestarting... Scan the new QR code to log in again.\n');
                startClient();
            }, 5000);
        });
    });

    client.initialize().catch((err) => {
        if (!isDisconnecting) {
            console.error('Initialization error:', err.message);
        }
    });
}

async function saveMessage(groupName, msg) {
    // Skip duplicates (can happen when history fetch overlaps with live events)
    const msgId = msg.id._serialized;
    if (savedMessageIds.has(msgId)) return;
    savedMessageIds.add(msgId);

    // Skip messages with nothing displayable (deleted msgs, group notifications, etc.)
    const hasText = msg.body && msg.body.trim().length > 0;
    if (!hasText && !msg.hasMedia) return;

    let mediaPath = null;
    let mediaType = null;
    let mediaFilename = null;

    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media) {
                const ext = media.mimetype.split('/')[1].split(';')[0];
                // Use filename from media if available, otherwise use message id
                mediaFilename = media.filename || `${msg.id.id}.${ext}`;
                mediaPath = path.join('media', mediaFilename);
                fs.writeFileSync(
                    path.join(MEDIA_DIR, mediaFilename),
                    media.data,
                    'base64'
                );
                mediaType = media.mimetype;
            }
        } catch (err) {
            if (!isDisconnecting) {
                console.error(`Failed to download media for ${msg.id.id}:`, err.message);
            }
        }
    }

    const messageData = {
        group: groupName,
        id: msgId,
        timestamp: msg.timestamp,
        author: msg.author || msg.from,
        body: msg.body,
        type: msg.type,
        hasMedia: msg.hasMedia,
        mediaPath: mediaPath,
        mediaType: mediaType,
        mediaFilename: mediaFilename
    };

    fs.appendFileSync(EXPORT_FILE, JSON.stringify(messageData) + '\n');
}

async function start() {
    startClient();
}

start();
