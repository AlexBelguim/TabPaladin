# TabPaladin Privacy Policy

_Last updated: 14 October 2026_

TabPaladin is a browser extension and a companion web app for saving tab sessions
("workflows"), organising bookmarks, and keeping notes. It is self-hosted software:
**the developer does not run a server, does not collect analytics, and never receives
your data.** Everything below describes where your data goes on your own devices and
on services you choose to connect.

## What the extension accesses

| Permission | Why |
|---|---|
| **Tabs** | To list your open tabs, save them as a workflow, reopen a workflow, and remove a tab from a workflow when you close it. |
| **Bookmarks** | Only when you press **Import this browser's bookmarks**, to copy them once into TabPaladin. Your browser's own bookmarks are read, never changed. |
| **Storage / unlimited storage** | To keep your bookmark tree, workflows, notes and settings on your device. |
| **Downloads** | Only when you export workflows or folders to a file. |
| **Private windows** | None: TabPaladin does not run in private (incognito) windows. |
| **Scripting + access to all sites** _(optional, off by default)_ | Only if you turn on **Scroll to seek in fullscreen videos**. It lets the mouse wheel skip through a fullscreen video. It reads nothing from the page, reads none of TabPaladin's own data, and sends nothing anywhere. Turning it off removes the permission. |

## Where your data is stored

- **On your device.** Your bookmark tree, workflows, notes (including the text of a note
  you have not saved yet, so it survives the extension reloading) and settings are kept in
  the extension's local storage. In the web app, your server address and sign-in session
  are kept in that browser's storage. TabPaladin has no built-in AI any more: a Gemini API
  key entered in an earlier version is deleted from your device when the extension updates.
- **In a backup file, if you make one.** **Settings → Backup** saves a file to your computer
  with everything the extension holds. Your sign-in session is left out of it. The file is
  not sent anywhere.
- **On your own sync server, if you set one up.** TabPaladin can sync with a server that
  *you* host (for example in Docker on a home NAS). When you sign in and push, your
  bookmark tree, workflows and notes are sent to that server and stored in its database,
  along with a history of earlier versions. Your username and a hashed password are
  stored there too. Nobody else operates or can see this server unless you give them
  access.

## Third-party services

TabPaladin only contacts these when you use the matching feature:

- **Google favicon service.** To show site icons, the extension and web app request each
  bookmark's icon from `www.google.com/s2/favicons`, which tells Google the domain of each
  bookmark being displayed (not the full address).
- **DuckDuckGo.** Text you type into the home-screen search box is sent to DuckDuckGo
  only when you submit a search.
- **Reddit (imports).** Only if you connect a Reddit account in the Imports section. Your
  own sync server, not the extension, then uses your own Reddit API app credentials to
  download your saved posts and keeps a copy on your server. Saved posts you later delete
  on Reddit may stay in that archive until you delete them in TabPaladin.

## What TabPaladin does not do

- No analytics, telemetry, tracking or advertising.
- No sale or sharing of data with anyone.
- No data is sent to the developer.
- Your browsing history is never read.

## Sharing your notes and bookmarks with an AI chat

TabPaladin has no AI of its own. Only if you choose to, your sync server lets an AI chat you
use read your notes and bookmarks and suggest changes, in two ways:

- **A temporary link.** Settings or Notes make a link that works for one hour. Anyone who
  has it can read all your notes and your bookmarks (folder names, titles and addresses)
  until it expires, so give it only to the chat you intend.
- **MCP tokens**, for Claude Code, Claude Desktop and other MCP clients. You make one in
  Settings; a chat holding it can read your notes and bookmarks and suggest changes for as
  long as the token exists. The server stores only a fingerprint (hash) of each token, with
  its name and when it was made and last used. Revoke a token in Settings at any time;
  changing your password revokes all of them. A token cannot reach anything else on your
  server.

What the chat reads goes to the company that runs that chat (for example Anthropic or
OpenAI), under its own privacy terms, not TabPaladin's. The chat fetches it from your
server; TabPaladin sends nothing to them by itself.

A chat's suggestions are kept on your server, with the reason it gave and where it came
from, until you approve or reject them. Nothing changes before you approve; approving
keeps the previous version of your tree in the server's history.

## Deleting your data

- **Extension:** removing the extension deletes everything it stored on your device.
- **Sync server:** your data lives in the server's database file, which you control and
  can delete at any time.
- **Reddit:** disconnect it in TabPaladin's settings and revoke the app in your Reddit
  account.

## Changes and contact

Changes to this policy are published in this file in the project's repository, with the
date at the top updated. Questions can be raised as an issue on the project's GitHub page.
