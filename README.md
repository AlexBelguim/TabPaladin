# 🛡️ TabPaladin

<div align="center">

<img src="assets/logo.png" alt="TabPaladin Logo" width="150">

**Your tabs deserve a guardian.**

[![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://github.com/AlexBelguim/TabPaladin)
[![Firefox](https://img.shields.io/badge/Firefox-Add--on-FF7139?logo=firefox&logoColor=white)](https://github.com/AlexBelguim/TabPaladin)
[![License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

</div>

---

## ✨ What is TabPaladin?

TabPaladin is a powerful browser extension that helps you **tame tab chaos** and **organize your digital life**. Save your browsing sessions as workflows, sort your bookmarks by your own keywords, and never lose track of your research again.

> *"100 tabs open? No problem."* — Every TabPaladin user

---

## 🚀 Features

### 📁 **Workflow Management**
- **Save Sessions** — Capture all open tabs as a named workflow with one click
- **Restore Anytime** — Reopen entire workflows in a new window
- **Import/Export** — Backup your workflows to JSON files

### 🗂️ **Keyword Organization**
- **Smart Grouping** — open tabs and bookmarks grouped by built-in categories and your own keywords
- **Folder Suggestions** — Analyze & Sort and Split propose where each bookmark goes; nothing moves until you apply it
- **Your keywords, your folders** — export and import your keywords and any folder as JSON

There is no built-in AI and no API key to enter: nothing is sent to an AI service.
An assistant can work with your notes through the sync server's temporary share
link instead, and what it proposes is applied only once you approve it.

### 🗄️ **Server-owned bookmarks** (needs the sync server)
- **One tree, any browser** — your bookmarks live in the sync server's database, not in any browser's own bookmark store, so Chrome, Firefox, Opera and the phone all see the identical tree
- **Git-style sync** — edit locally (works offline), then **Push**; **Pull** fetches the server's tree. A push is refused if another device pushed since your last pull, so nothing is silently overwritten
- **Import from any browser** — one click copies a browser's existing bookmarks into the tree; the browser's own bookmarks are never touched again

### 📥 **Importers** (Optional, needs the sync server)
- **Reddit saved posts** — Reddit only ever shows your most recent 1000 saves. TabPaladin sweeps the list on a schedule and keeps everything it has seen, so your archive outgrows the cap
- **X & Instagram** — neither can be fetched (no free API on one, no personal saved list on the other), so share a post to TabPaladin from your phone and it lands in the same archive
- **A read-only folder in your tree** — the archive appears as a normal-looking folder on every device; deleting an item tombstones it on the server, and dragging one out files a copy into your own tree
- **One-way** — deleting an import in TabPaladin never un-saves anything on Reddit

See [server/README.md](server/README.md#importers) for setup.

### 🎬 **Bonus: Video Scroll Seek**
- Scroll wheel to fast-forward/rewind fullscreen videos
- Works on YouTube, Netflix, and more!

---

## 📦 Installation

Two clients, one tree. The **extension** is the full desktop client — it's the
only one that can capture open tabs into workflows and auto-sync them on tab
close. The **web app** (served by the sync server) is the client for phones
and for any machine without the extension.

### Extension (desktop)

- **Chrome**: `chrome://extensions` → Developer mode → **Load unpacked** → the repository folder
- **Firefox**: build the package first (below), then `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `dist/firefox.zip`

#### Packaging for the stores

```bash
node tools/package.mjs
```

Writes `dist/chrome.zip` (Chrome Web Store, Opera, Edge) and `dist/firefox.zip`
(AMO), each with its manifest at the zip root and only `src/` and the icons.
No dependencies beyond Node. The Firefox manifest in `firefox/` uses `../`
paths so it can live beside the Chrome one; the script rewrites them, so load
Firefox from the zip, not from `firefox/`.

### Web app (phone + anywhere else)

Run the sync server (see [server/README.md](server/README.md)), open
`https://<your-server>` and sign in. On a phone, install it as a PWA for
share-sheet capture. To bring in a browser's existing bookmarks without the
extension, export them from that browser's bookmark manager and upload the
HTML file in **Settings → Import bookmarks** — works with any browser.

---

## 🎮 How to Use

1. **Click the TabPaladin icon** in your toolbar to open the app
2. **Create Workflow** — Save all your current tabs (extension)
3. **View Workflows** — Restore, open, or delete saved sessions (both clients)
4. **Organize Bookmarks** — Sort folders by keyword, reviewing every move first
5. **Push / Pull** — git-style sync; edit offline, push when ready

---

## 🏗️ Project Structure

```
TabPaladin/
├── server/                 # Node + SQLite sync server — owns the bookmark tree
├── pwa/                    # The web app (desktop + phone), served by the server
├── tools/                  # Headless tests, recovery scripts, package.mjs
├── manifest.json           # Chrome extension manifest (v3)
├── firefox/                # Firefox add-on manifest (v2; packaged by tools/package.mjs)
├── src/                    # Extension source (tab capture, workflows, organizer UI)
└── assets/                 # Shared icons and images
```

---

## 🤝 Contributing

Contributions are welcome! Feel free to:
- 🐛 Report bugs
- 💡 Suggest features
- 🔧 Submit pull requests

---

## 📜 License

Copyright (C) 2026 AlexBelguim

TabPaladin is free software: you can redistribute it and/or modify it under the terms of the
[GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a service
for other people, you must make your modified source available to them.

See [PRIVACY.md](PRIVACY.md) for what data TabPaladin handles and where it goes.

---

<div align="center">

**Built with ☕ and too many open tabs**

[⬆ Back to Top](#-tabpaladin)

</div>
