# WhatsApp Group Fetcher & Dashboard

A lightweight, local bot powered by `whatsapp-web.js` that allows you to export chat history and track live incoming messages/media from selected WhatsApp groups. It comes with a beautiful glassmorphism dark-mode dashboard to view and download all data and media.

## Features
- **Concurrent Group Fetching:** Extracts message history from multiple WhatsApp groups at the same time.
- **Media Downloader:** Automatically downloads images, videos, audio, voice messages, and documents locally.
- **Robust Connection Handling:** Automatically handles connection drops and logs out, regenerating the QR code gracefully.
- **Aesthetic Local Dashboard:** View messages in real-time, filter by group, and play/view downloaded media directly from your browser.

## Directory Structure
Once set up, the project directory structure will look like this:
```
my-bot/
├── data/
│   ├── messages.jsonl   <-- All exported messages in JSON-lines format
│   └── media/           <-- Downloaded group photos, videos, and documents
├── public/              <-- Dashboard frontend code
├── export.js            <-- Bot script
├── dashboard.js         <-- Web server for the dashboard
├── package.json
└── .gitignore
```

---

## Setup & Running

### 1. Install Node.js
Ensure you have Node.js v18 or higher installed on your machine.

### 2. Install Dependencies
Navigate to the project folder and install the required modules:
```bash
npm install
```

### 3. Run the Exporter Bot
Run the bot script:
```bash
node export.js
```
- It will prompt you to enter the names of the groups you want to export (separated by commas).
- A QR code will be generated in your terminal. Scan this QR code using the **Linked Devices** feature in your WhatsApp mobile application.
- The bot will match your groups, fetch up to 1000 messages of history, and start listening for live messages.

### 4. Run the Dashboard
Open a new terminal window, navigate to the project directory, and run the dashboard server:
```bash
node dashboard.js
```
Now, open your web browser and navigate to:
👉 **[http://localhost:3000](http://localhost:3000)**

---

## Security Warning
⚠️ **DO NOT commit the `.wwebjs_auth/` or `data/` folders to any public repository!** 
The `.wwebjs_auth` folder contains your active WhatsApp session tokens, and the `data` folder contains private chat history. These are ignored automatically by the `.gitignore` included in this repository.
