let allMessages = [];
let currentFilter = 'all';
let knownGroupsInDropdown = new Set();

document.addEventListener('DOMContentLoaded', () => {
    fetchMessages();

    // Auto-refresh every 10 seconds to pick up new messages from the bot
    setInterval(fetchMessages, 10000);

    document.getElementById('group-filter').addEventListener('change', (e) => {
        currentFilter = e.target.value;
        renderMessages(currentFilter);
    });
});

async function fetchMessages() {
    try {
        const response = await fetch('/api/messages');
        const fresh = await response.json();

        // Sort oldest to newest
        fresh.sort((a, b) => a.timestamp - b.timestamp);

        allMessages = fresh;

        populateGroups();
        renderMessages(currentFilter);
    } catch (error) {
        console.error('Error fetching messages:', error);
    }
}

function populateGroups() {
    const filter = document.getElementById('group-filter');
    const groups = new Set(allMessages.map(m => m.group));

    // Only add new groups not already in the dropdown
    groups.forEach(group => {
        if (!knownGroupsInDropdown.has(group)) {
            const option = document.createElement('option');
            option.value = group;
            option.textContent = group;
            filter.appendChild(option);
            knownGroupsInDropdown.add(group);
        }
    });
}

function renderMessages(groupFilter) {
    const container = document.getElementById('chat-container');
    container.innerHTML = '';

    const filtered = groupFilter === 'all'
        ? allMessages
        : allMessages.filter(m => m.group === groupFilter);

    document.getElementById('msg-count').textContent = filtered.length;

    if (filtered.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; color: var(--text-muted); margin-top: 4rem;">
                <div style="font-size: 3rem; margin-bottom: 1rem;">💬</div>
                <p style="font-size: 1.1rem;">No messages found yet.</p>
                <p style="font-size: 0.9rem; margin-top: 0.5rem;">
                    Make sure the export bot is running and the group name matches exactly.<br>
                    The dashboard auto-refreshes every 10 seconds.
                </p>
            </div>`;
        return;
    }

    // Show newest first for display
    const messagesToRender = [...filtered].reverse().slice(0, 500);

    messagesToRender.forEach((msg, index) => {
        const date = new Date(msg.timestamp * 1000).toLocaleString();

        let author = 'Unknown';
        if (msg.author) author = msg.author.split('@')[0];

        const card = document.createElement('div');
        card.className = 'message-card';
        if (index < 20) card.style.animationDelay = `${index * 0.04}s`;

        let mediaHtml = '';
        if (msg.hasMedia && msg.mediaPath) {
            const type = msg.mediaType || '';
            const filePath = '/' + msg.mediaPath.replace(/\\/g, '/');
            const label = msg.mediaFilename || filePath.split('/').pop();

            if (type.startsWith('image/')) {
                mediaHtml = `<div class="media-container"><img src="${filePath}" alt="Image" loading="lazy"></div>`;
            } else if (type.startsWith('video/')) {
                mediaHtml = `<div class="media-container"><video src="${filePath}" controls preload="metadata"></video></div>`;
            } else if (type.startsWith('audio/') || type === 'audio/ogg; codecs=opus') {
                mediaHtml = `<div class="media-container"><audio src="${filePath}" controls preload="metadata"></audio></div>`;
            } else {
                mediaHtml = `<div class="media-container"><a href="${filePath}" download="${escapeHtml(label)}" target="_blank" style="color:#60a5fa;text-decoration:none;">📄 ${escapeHtml(label)}</a></div>`;
            }
        }

        const bodyHtml = msg.body
            ? `<div class="message-body">${escapeHtml(msg.body)}</div>`
            : '';

        // Show a label for media-only messages with no text
        const mediaOnlyLabel = (!msg.body && msg.hasMedia)
            ? `<div class="message-body" style="color:var(--text-muted);font-style:italic;">${getMediaLabel(msg.type)}</div>`
            : '';

        card.innerHTML = `
            <div class="message-header">
                <div>
                    <span class="author">${escapeHtml(author)}</span>
                    <span class="group-badge">${escapeHtml(msg.group)}</span>
                </div>
                <span class="timestamp">${date}</span>
            </div>
            ${bodyHtml}
            ${mediaOnlyLabel}
            ${mediaHtml}
        `;

        container.appendChild(card);
    });
}

function getMediaLabel(type) {
    const labels = {
        image: '🖼️ Image',
        video: '🎬 Video',
        audio: '🎵 Audio',
        ptt: '🎤 Voice Message',
        sticker: '🖼️ Sticker',
        document: '📄 Document',
    };
    return labels[type] || '📎 Media';
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
