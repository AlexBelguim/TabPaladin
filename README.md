# 🛡️ TabPaladin

<div align="center">

<img src="logo.png" alt="TabPaladin Logo" width="150">

**Your tabs deserve a guardian.**

[![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://github.com/AlexBelguim/TabPaladin)
[![Firefox](https://img.shields.io/badge/Firefox-Add--on-FF7139?logo=firefox&logoColor=white)](https://github.com/AlexBelguim/TabPaladin)
[![License](https://img.shields.io/badge/License-Proprietary-red.svg)](LICENSE)

</div>

---

## ✨ What is TabPaladin?

TabPaladin is a powerful browser extension that helps you **tame tab chaos** and **organize your digital life**. Save your browsing sessions as workflows, organize bookmarks with AI assistance, and never lose track of your research again.

> *"100 tabs open? No problem."* — Every TabPaladin user

---

## 🚀 Features

### 📁 **Workflow Management**
- **Save Sessions** — Capture all open tabs as a named workflow with one click
- **Restore Anytime** — Reopen entire workflows in a new window
- **Import/Export** — Backup your workflows to JSON files

### 🧠 **AI-Powered Organization** (Optional)
- **Smart Grouping** — Let AI categorize your tabs and bookmarks
- **Folder Suggestions** — Get intelligent folder recommendations
- **Custom Hints** — Guide the AI with your own keywords

### 🎬 **Bonus: Video Scroll Seek**
- Scroll wheel to fast-forward/rewind fullscreen videos
- Works on YouTube, Netflix, and more!

---

## 📦 Installation

### Chrome
1. Download or clone this repository
2. Go to `chrome://extensions`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the repository folder

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select any file in the `firefox/` folder

---

## 🎮 How to Use

1. **Click the TabPaladin icon** in your toolbar to open the sidebar
2. **Create Workflow** — Save all your current tabs
3. **View Workflows** — See saved workflows, restore or delete them
4. **Organize Bookmarks** — Use AI to clean up your bookmark mess
5. **Settings** — Configure AI features and preferences

---

## 🏗️ Project Structure

```
TabPaladin/
├── manifest.json           # Chrome extension manifest (v3)
├── firefox/
│   └── manifest.json       # Firefox add-on manifest (v2, points to ../src/)
├── src/                    # Shared source code (Chrome + Firefox)
│   ├── background/         # Background script (polyfilled)
│   ├── sidepanel/          # Main UI (HTML, CSS, JS)
│   ├── content/            # Content scripts (video scroll)
│   └── utils/              # Shared utilities
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

**Proprietary** — All rights reserved. Contact for licensing inquiries.

---

<div align="center">

**Built with ☕ and too many open tabs**

[⬆ Back to Top](#-tabpaladin)

</div>
