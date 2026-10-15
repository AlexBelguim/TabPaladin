# TabPaladin Privacy Policy

_Last updated: 15 October 2026_

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
| **Toolbar menus** | Opens helper Settings, the web app, workflow-save review and recently closed tabs from the toolbar icon. |
| **Server access** _(optional)_ | Runs the packaged bridge only on your configured server origin after you click Connect. Runtime checks include the exact origin and port. |
| **Private windows** | None: TabPaladin does not run in private (incognito) windows. |
| **Scripting + access to all sites** _(optional, off by default)_ | Only if you turn on **Scroll to seek in fullscreen videos**. It lets the mouse wheel skip through a fullscreen video. It reads nothing from the page, reads none of TabPaladin's own data, and sends nothing anywhere. Turning it off removes the permission. |

## Connecting the web app to browser tabs

Connecting the helper lets scripts served by your chosen TabPaladin server read
the addresses and titles of open tabs, and open or close tabs after your actions.
The server operator can see what the web app receives. Connect only to a server
you trust. The helper pins the server's signed identity public key, checks it on
later connections and refuses a changed key or invalid signature. A network
origin permission may cover every port on a host; the bridge separately checks
the exact configured origin and port on every request. Plain HTTP on a private
network requires your acknowledgement and gets no offline tab features.

No password or session token crosses the bridge. Signing out unregisters it;
changing server or disconnecting also detaches it. Old queues and data stay
bound to their original origin, server identity and account. The helper stores
workflow tab ids, queued removals (30 days, up to 10,000), staged bookmarks
(10 minutes), the last 50 bridge calls (origin, operation, time), and tabs it
closed (24 hours, up to 500, for reopening). This stays in extension storage.
Bookmark imports are handed only to the designated web-app tab and require a
confirmation there; they never modify browser bookmarks. The existing required
bookmarks permission stays in P2 for compatibility with the desktop UI.

TabPaladin uses browsing information only for these requested tab, workflow,
bookmark and note features. It does not sell it, use it for advertising or
credit decisions, or transfer it to unrelated third parties. The existing
favicon and explicitly connected services described below still apply.

## Where your data is stored

- **On your device.** Your bookmark tree, workflows, notes (including the text of a note
  you have not saved yet, so it survives the extension reloading) and settings are kept in
  the extension's local storage. In the web app, your server address and sign-in session
  are kept in that browser's storage. TabPaladin has no built-in AI any more: a Gemini API
  key entered in an earlier version is deleted from your device when the extension updates.
- **In a backup file, if you make one.** **Settings → Backup** (from 1.9.0, **Download a
  backup file** on the move page) saves a file to your computer with everything the
  extension holds. Your sign-in session is left out of it. The file is not sent anywhere.
- **On your own sync server, if you set one up.** TabPaladin can sync with a server that
  *you* host (for example in Docker on a home NAS). When you sign in and push, your
  bookmark tree, workflows and notes are sent to that server and stored in its database,
  along with a history of earlier versions. Your username and a hashed password are
  stored there too. Nobody else operates or can see this server unless you give them
  access.

## Helper safety copies

With helper 1.2.0 connected, the web app mirrors its unpushed working copy and
that copy's parked/open note drafts to extension storage, every 30 seconds and
on hide. Each copy is bound to the exact server origin, its pinned identity and
account. At most three complete copies of 64 MiB each are retained per server;
partial uploads expire after ten minutes. Digests verify the chunks. Session
tokens and sign-in credentials are not part of the copy. This feature needs a
secure web context.

The web app offers recovery only after its own server confirms the account;
restoring requires a click and keeps the current copy aside first. A clean sync,
an explicit Settings action, or the vault-aware sign-out clears matching helper
copies. Removing the extension deletes its vault. An imported extension backup
is kept as separate local copies for review, including matching note drafts;
credentials in the file are ignored. Neither feature sends data to the developer
or migrates the old extension's working copy automatically.

## Moving from the extension's old interface (1.9.0)

When you click **Move** on the extension's move page and then **Bring in** in
the web app, the extension hands what its old interface kept to the web app
in this browser: the working copy and set-aside copies made for that server
(or before you signed in anywhere), note drafts for those copies, and device
preferences (keyword categories, category order, the notes view, open cards).
It goes from the extension's storage to the web app's storage on this device,
checked piece by piece; nothing goes to the server until you push, as before.
Copies made for another server, and their drafts, stay in the extension.

No sign-in session, password or key is handed over; an old AI key still stored
in the extension never is either. Once the web app is signed in, the old
interface's own session is signed out on its server and removed from the
extension. A shared server token pasted into the old interface is left as it
is. The move page offers a backup file first, without sessions or keys.

Nothing is deleted: the extension keeps everything its old interface stored,
so reinstalling the previous version brings it back. The web app keeps what it
received until you remove it in Settings. The extension records where and when
it handed data over.

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
  until it expires, so give it only to the chat you intend. Changing your password ends
  every link at once.
- **MCP tokens**, for Claude Code, Claude Desktop and other MCP clients. You make one in
  Settings; a chat holding it can read your notes and bookmarks and suggest changes for as
  long as the token exists. The server stores only a fingerprint (hash) of each token, with
  its name and when it was made and last used. Revoke a token in Settings at any time;
  changing your password revokes all of them, and ends your temporary links too. A token
  cannot reach anything else on your server.

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
