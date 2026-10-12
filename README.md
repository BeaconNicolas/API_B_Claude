# API_B_Claude

A private Claude chat website you open from a link. It talks to the Claude API with **your own API key**, and keeps **its own history in your browser**, completely separate from your claude.ai chats.

**Live link (after you turn on Pages):** https://beaconnicolas.github.io/API_B_Claude/

## What it does

- **Chat with Claude**: Opus 5.5 (default), Sonnet 5.5, Haiku 5.5 and Fable 5.1, with an effort setting (low → max) and streamed replies.
- **Shows Claude's thinking** as collapsible summaries.
- **Web search** you can switch on per chat, with source links.
- **Images and PDFs**: attach them, paste them, or drag them in.
- **Its own history**: chats are saved in this browser (IndexedDB), searchable, and can be renamed, exported to Markdown or JSON, imported, or deleted. Nothing is written to your claude.ai account.
- **Its own caches**: every request uses the API's prompt caching, so follow-up messages in a chat reuse the cached conversation and cost less. Each reply shows how much was served from the cache.
- **Usage and limits**: tokens and estimated cost per reply, per chat, per day and per month. You can see your API rate limits, and set your own daily or monthly spending caps and a "messages per N hours" limit, like a subscription's usage window.
- **Safety net**: if a model declines a request, the API retries it on another model automatically (server-side fallbacks), and the app tells you when that happens.
- Light and dark themes, works on phones, keyboard friendly (Enter to send, Shift+Enter for a new line, Esc to stop, Ctrl/Cmd+Shift+O for a new chat).

## Try it for free (demo mode)

On the welcome screen, click **Try the free demo**. You get the full interface with sample replies generated in your browser: no API key, no network calls, no cost. Demo chats aren't saved. Click **Connect a key** whenever you want to chat with the real Claude.

## About subscriptions, limits and tokens

A Claude Pro or Max subscription only covers claude.ai and Claude Code. It can't be used by other apps, and its limits can't be read or shared. So this site uses an **API key**, which is billed pay-as-you-go to your Claude Console account, separately from any subscription. To keep spending under control:

- set your own caps under **Settings → Limits**; the app warns at 80% and stops at 100%,
- and for a hard cap, set a spend limit for your key in the [Claude Console](https://console.anthropic.com/settings/limits).

## Set it up (one time)

1. **Get an API key**: go to [console.anthropic.com](https://console.anthropic.com/settings/keys), add credits, and create a key.
2. **Turn on GitHub Pages**: in this repo, go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. **Deploy**: open the **Actions** tab, pick **Deploy to GitHub Pages**, and click **Run workflow** (it also runs on every push to `main`).
4. Open **https://beaconnicolas.github.io/API_B_Claude/**, paste your key, and start chatting.

## Privacy and security

- Your key is stored only in your browser (localStorage if you tick **Remember on this device**, otherwise just for the session) and is sent only to `api.anthropic.com`. It never goes into this repository.
- Chats, attachments and usage history stay in this browser. Clearing site data or using **Settings → Your data → Delete all data** removes them.
- Claude's replies are sanitised before display, and a strict Content-Security-Policy allows the page to talk only to `api.anthropic.com`, so injected content can't send your key elsewhere.
- Anyone who can use your browser profile can use a remembered key. On shared computers, leave **Remember** unticked, and revoke a key in the Console if it's ever exposed.
- This is an unofficial client. The API keeps requests only as [Anthropic's API data policy](https://privacy.anthropic.com/) describes.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173/API_B_Claude/
npm test           # unit tests
npm run build      # production build in dist/
```

## How it's built

Vite + TypeScript, no framework. The Claude API is called with the official [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) straight from the browser. Markdown is rendered with `marked`, sanitised with `DOMPurify`, and highlighted with `highlight.js`.

| File | What it does |
|---|---|
| `src/models.ts` | Models, prices and per-model request rules |
| `src/conversation.ts` | Builds API requests from saved chats; pricing and limits (unit tested) |
| `src/api.ts` | Streaming, resuming paused turns, error messages |
| `src/storage.ts` | Browser storage for chats, usage, settings and the key |
| `src/markdown.ts` | Safe Markdown rendering |
| `src/main.ts` | The interface |
