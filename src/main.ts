import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

import type Anthropic from "@anthropic-ai/sdk";
import { createClient, createDemoClient, describeError, runTurn, verifyKey } from "./api";
import { attachmentUrl, MAX_ATTACHMENTS, readAttachment } from "./attachments";
import {
  assistantText,
  checkLimits,
  composeSystemPrompt,
  contextTokens,
  conversationUsage,
  startOfMonth,
  titleFrom,
} from "./conversation";
import { download, formatDuration, formatTokens, formatUSD, h, icon, iconButton } from "./dom";
import { enhanceCodeBlocks, escapeHtml, renderMarkdown } from "./markdown";
import { EFFORTS, getModel, isKnownModel, MODELS, modelLabel } from "./models";
import * as store from "./storage";
import type {
  Attachment,
  ChatMessage,
  ContentBlock,
  Conversation,
  RateLimitSnapshot,
  Settings,
  UsageRecord,
} from "./types";

// ---------- state ----------

interface State {
  settings: Settings;
  key: { key: string; remembered: boolean } | null;
  client: Anthropic | null;
  conversations: Conversation[];
  current: Conversation | null;
  search: string;
  pending: Attachment[];
  streaming: { convId: string; msgId: string; controller: AbortController } | null;
  rateLimits: RateLimitSnapshot | null;
  usage: UsageRecord[];
  overrideLimitOnce: boolean;
  editingId: string | null;
  /** Demo mode: sample replies generated in the browser, nothing saved or charged. */
  demo: boolean;
}

const DEMO_FLAG = "abc.demo";
function readDemoFlag(): boolean {
  try {
    return sessionStorage.getItem(DEMO_FLAG) === "1";
  } catch {
    return false;
  }
}
function writeDemoFlag(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(DEMO_FLAG, "1");
    else sessionStorage.removeItem(DEMO_FLAG);
  } catch {
    /* ignore */
  }
}

const state: State = {
  settings: store.loadSettings(),
  key: store.loadApiKey(),
  client: null,
  conversations: [],
  current: null,
  search: "",
  pending: [],
  streaming: null,
  rateLimits: null,
  usage: [],
  overrideLimitOnce: false,
  editingId: null,
  demo: false,
};
// A real key always wins over a leftover demo flag.
state.demo = !state.key && readDemoFlag();

/** True when the chat screen should show: a real key, or demo mode. */
function connected(): boolean {
  return Boolean(state.key) || state.demo;
}

const app = document.getElementById("app")!;

// ---------- shell ----------

const listEl = h("nav", { class: "conv-list", "aria-label": "Chats" });
const searchInput: HTMLInputElement = h("input", {
  class: "input",
  type: "search",
  placeholder: "Search chats",
  "aria-label": "Search chats",
  on: {
    input: () => {
      state.search = searchInput.value;
      renderList();
    },
  },
});
const usageMini = h("button", { type: "button", class: "usage-mini", on: { click: () => openUsage() } });
const keyDot = h("span", { class: "key-dot", "aria-hidden": "true" });

const sidebar = h("aside", { class: "sidebar", "aria-label": "Sidebar" }, [
  h("div", { class: "sidebar-top" }, [
    h("div", { class: "brand" }, [h("span", { class: "brand-mark" }, [icon("spark")]), h("span", { text: "API B Claude" })]),
  ]),
  h("button", { type: "button", class: "btn new-chat", on: { click: () => startNewChat() } }, [icon("plus"), "New chat"]),
  h("div", { class: "search" }, [icon("search"), searchInput]),
  listEl,
  h("div", { class: "sidebar-foot" }, [
    usageMini,
    h("div", { class: "foot-row" }, [
      h("button", { type: "button", class: "btn btn-ghost", on: { click: () => openUsage() } }, [icon("chart"), "Usage"]),
      h("button", { type: "button", class: "btn btn-ghost", on: { click: () => openSettings() } }, [
        icon("settings"),
        "Settings",
        keyDot,
      ]),
    ]),
  ]),
]);

const titleSlot = h("div", { class: "title-slot" });
const topMeta = h("div", { class: "topbar-meta" });
const topbar = h("header", { class: "topbar" }, [
  iconButton("menu", "Open chats", () => app.classList.add("nav-open"), { class: "icon-btn menu-btn" }),
  titleSlot,
  topMeta,
]);

const threadInner = h("div", { class: "thread-inner" });
const thread = h("div", { class: "thread", "aria-live": "off" }, [threadInner]);
const jumpBtn = h("button", { type: "button", class: "btn jump", hidden: true, on: { click: () => scrollToBottom(true) } }, [
  icon("arrowDown"),
  "Latest",
]);
const threadWrap = h("div", { class: "thread-wrap" }, [thread, jumpBtn]);

// Composer
const fileInput: HTMLInputElement = h("input", {
  type: "file",
  multiple: true,
  accept: "image/png,image/jpeg,image/gif,image/webp,application/pdf",
  hidden: true,
  on: { change: () => addFiles(fileInput.files) },
});
const textarea: HTMLTextAreaElement = h("textarea", {
  rows: 1,
  placeholder: "Message Claude…",
  "aria-label": "Message",
  on: {
    input: () => autoGrow(),
    keydown: (e) => onComposerKey(e as KeyboardEvent),
    paste: (e) => {
      const files = (e as ClipboardEvent).clipboardData?.files;
      if (files?.length) {
        e.preventDefault();
        addFiles(files);
      }
    },
  },
});
const pendingEl = h("div", { class: "pending", hidden: true });
const attachBtn = iconButton("paperclip", "Attach images or PDFs", () => fileInput.click());
const webBtn = iconButton("globe", "Web search", () => toggleWebSearch());
const modelSelect: HTMLSelectElement = h(
  "select",
  { class: "select", "aria-label": "Model", on: { change: () => setModel(modelSelect.value) } },
  MODELS.map((m) => h("option", { value: m.id, text: m.label.replace("Claude ", ""), title: m.blurb })),
);
const effortSelect: HTMLSelectElement = h(
  "select",
  { class: "select", "aria-label": "Effort", title: "How hard Claude thinks", on: { change: () => setEffort(effortSelect.value) } },
  EFFORTS.map((e) => h("option", { value: e.id, text: `${e.label} effort`, title: e.hint })),
);
const sendBtn = h("button", { type: "submit", class: "send", "aria-label": "Send" }, [icon("send")]);
const composer: HTMLFormElement = h(
  "form",
  {
    class: "composer",
    on: {
      submit: (e) => {
        e.preventDefault();
        if (state.streaming) stopStreaming();
        else void sendFromComposer();
      },
      dragover: (e) => {
        e.preventDefault();
        composer.classList.add("drag");
      },
      dragleave: () => composer.classList.remove("drag"),
      drop: (e) => {
        e.preventDefault();
        composer.classList.remove("drag");
        addFiles((e as DragEvent).dataTransfer?.files ?? null);
      },
    },
  },
  [
    pendingEl,
    textarea,
    h("div", { class: "composer-bar" }, [attachBtn, fileInput, webBtn, modelSelect, effortSelect, h("span", { class: "spacer" }), sendBtn]),
  ],
);
const limitBanner = h("div", { class: "limit-banner", hidden: true });
const demoBanner = h("div", { class: "limit-banner", hidden: true }, [
  h("div", { class: "notice demo-note" }, [
    h("span", { text: "Demo mode: sample replies, not from Claude. Nothing is saved or charged." }),
    h("button", { type: "button", class: "btn", text: "Connect a key", on: { click: () => openSettings("key") } }),
    h("button", { type: "button", class: "btn btn-ghost", text: "Leave demo", on: { click: () => leaveDemo() } }),
  ]),
]);
const composerHint = h("p", { class: "composer-hint" });
const composerWrap = h("div", { class: "composer-wrap" }, [demoBanner, limitBanner, composer, composerHint]);

const main = h("main", { class: "main" }, [topbar, threadWrap, composerWrap]);
const scrim = h("div", { class: "scrim", on: { click: () => app.classList.remove("nav-open") } });
const toasts = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
app.append(sidebar, main, scrim, toasts);

// ---------- helpers ----------

function toast(message: string, kind: "info" | "error" = "info"): void {
  const el = h("div", { class: `toast ${kind === "error" ? "error" : ""}`, text: message });
  toasts.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 3500);
}

function applyTheme(): void {
  const { theme } = state.settings;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function saveSettings(): void {
  store.saveSettings(state.settings);
}

function nearBottom(): boolean {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
}

function scrollToBottom(smooth = false): void {
  thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

thread.addEventListener("scroll", () => {
  jumpBtn.hidden = nearBottom();
});

function autoGrow(): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  syncSendButton();
}

function newConversation(): Conversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    model: state.settings.defaultModel,
    effort: state.settings.defaultEffort,
    systemPrompt: "",
    webSearch: state.settings.webSearchDefault,
    started: false,
    messages: [],
  };
}

async function persist(conv: Conversation): Promise<void> {
  if (!conv.started || state.demo) return;
  try {
    await store.putConversation(conv);
  } catch (err) {
    toast(`Couldn't save this chat: ${(err as Error).message}`, "error");
  }
}

function upsertConversation(conv: Conversation): void {
  const i = state.conversations.findIndex((c) => c.id === conv.id);
  if (i === -1) state.conversations.unshift(conv);
  else state.conversations[i] = conv;
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------- sidebar ----------

function groupLabel(ts: number): string {
  const day = 86_400_000;
  const startToday = new Date().setHours(0, 0, 0, 0);
  if (ts >= startToday) return "Today";
  if (ts >= startToday - day) return "Yesterday";
  if (ts >= startToday - 7 * day) return "Previous 7 days";
  if (ts >= startToday - 30 * day) return "Previous 30 days";
  return new Date(ts).toLocaleDateString([], { month: "long", year: "numeric" });
}

function matchesSearch(conv: Conversation, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (conv.title.toLowerCase().includes(needle)) return true;
  return conv.messages.some((m) => (m.role === "user" ? m.text ?? "" : assistantText(m)).toLowerCase().includes(needle));
}

function renderList(): void {
  listEl.replaceChildren();
  const q = state.search.trim();
  const items = state.conversations.filter((c) => matchesSearch(c, q));
  if (!items.length) {
    listEl.append(h("p", { class: "conv-empty", text: q ? "No chats match your search." : "Your chats will appear here." }));
    return;
  }
  let lastGroup = "";
  for (const conv of items) {
    const group = groupLabel(conv.updatedAt);
    if (group !== lastGroup) {
      listEl.append(h("div", { class: "conv-group", text: group }));
      lastGroup = group;
    }
    listEl.append(
      h(
        "button",
        {
          type: "button",
          class: "conv-item",
          "aria-current": state.current?.id === conv.id ? "true" : "false",
          title: conv.title,
          on: { click: () => openConversation(conv.id) },
        },
        [h("span", { text: conv.title })],
      ),
    );
  }
}

function renderUsageMini(): void {
  const status = checkLimits(state.usage, state.settings.limits);
  const { dailyUSD, monthlyUSD } = state.settings.limits;
  const row = (label: string, used: number, cap: number) => {
    const parts: Node[] = [
      h("div", { class: "usage-mini-row" }, [
        h("span", { text: label }),
        h("span", { text: cap > 0 ? `${formatUSD(used)} / ${formatUSD(cap)}` : formatUSD(used) }),
      ]),
    ];
    if (cap > 0) {
      const pct = Math.min(100, (used / cap) * 100);
      const meter = h("div", { class: `meter ${pct >= 100 ? "full" : pct >= 80 ? "warn" : ""}` }, [h("i")]);
      (meter.firstElementChild as HTMLElement).style.width = `${pct}%`;
      parts.push(meter);
    }
    return parts;
  };
  usageMini.replaceChildren(...row("Today", status.todayUSD, dailyUSD), ...row("This month", status.monthUSD, monthlyUSD));
  usageMini.setAttribute("aria-label", `Usage: ${formatUSD(status.todayUSD)} today, ${formatUSD(status.monthUSD)} this month. Open usage details.`);
  keyDot.classList.toggle("ok", Boolean(state.key));
  keyDot.classList.toggle("demo", state.demo);
  keyDot.title = state.key ? "API key connected" : state.demo ? "Demo mode" : "No API key";
}

// ---------- topbar ----------

function renderTopbar(): void {
  titleSlot.replaceChildren();
  topMeta.replaceChildren();
  const conv = state.current;
  if (!connected() || !conv) {
    titleSlot.append(h("span", { class: "title-btn", text: "API B Claude" }));
    return;
  }
  titleSlot.append(
    h("button", {
      type: "button",
      class: "title-btn",
      text: conv.title,
      title: conv.started ? "Rename chat" : conv.title,
      disabled: !conv.started,
      on: { click: () => startRename() },
    }),
  );
  if (!conv.started) return;
  const model = getModel(conv.model);
  const used = contextTokens(conv);
  const pct = Math.min(100, (used / model.contextWindow) * 100);
  const meter = h("div", { class: `meter ${pct >= 90 ? "full" : pct >= 70 ? "warn" : ""}` }, [h("i")]);
  (meter.firstElementChild as HTMLElement).style.width = `${Math.max(pct, used ? 1 : 0)}%`;
  const cost = conversationUsage(conv);
  topMeta.append(
    h("span", { class: "ctx", title: "How much of the model's context window this chat uses" }, [
      meter,
      h("span", { text: `${formatTokens(used)} / ${formatTokens(model.contextWindow)}` }),
    ]),
    h("span", {
      class: "cost",
      title: state.demo ? "Demo chats are free; this is what a real chat might cost" : "Estimated cost of this chat",
      text: state.demo ? `example ${formatUSD(cost.costUSD)}` : `${cost.estimated ? "≈ " : ""}${formatUSD(cost.costUSD)}`,
    }),
    iconButton("download", "Export chat as Markdown", () => exportConversation(conv)),
    iconButton("trash", "Delete chat", () => void removeConversation(conv)),
  );
}

function startRename(): void {
  const conv = state.current;
  if (!conv) return;
  const input = h("input", { class: "input title-input", value: conv.title, "aria-label": "Chat title" });
  const finish = (save: boolean) => {
    if (save && input.value.trim()) {
      conv.title = input.value.trim().slice(0, 120);
      void persist(conv);
      renderList();
    }
    renderTopbar();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  titleSlot.replaceChildren(input);
  input.focus();
  input.select();
}

// ---------- thread ----------

function citationLinks(block: Extract<ContentBlock, { type: "text" }>, sources: Map<string, { n: number; title: string }>): string {
  let out = "";
  for (const c of block.citations ?? []) {
    const cite = c as { type: string; url?: string; title?: string | null };
    if (cite.type !== "web_search_result_location" || !cite.url || !/^https?:\/\//i.test(cite.url)) continue;
    let entry = sources.get(cite.url);
    if (!entry) {
      entry = { n: sources.size + 1, title: cite.title || cite.url };
      sources.set(cite.url, entry);
    }
    out += `<sup><a href="${escapeHtml(cite.url)}">${entry.n}</a></sup>`;
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function renderAssistant(m: ChatMessage, isLast: boolean): HTMLElement {
  const streaming = m.status === "streaming";
  const blocks = (m.segments ?? []).flatMap((s) => s.content);
  const servedBy = [...(m.segments ?? [])].reverse().find((s) => s.model)?.model ?? m.requestedModel;
  const body = h("div", { class: "assistant-body" });
  const sources = new Map<string, { n: number; title: string }>();
  const searchResults = new Map<string, string>();
  let textRun = "";

  const flushText = () => {
    if (!textRun) return;
    const div = h("div", { class: "md" });
    div.innerHTML = renderMarkdown(textRun);
    enhanceCodeBlocks(div);
    body.append(div);
    textRun = "";
  };

  blocks.forEach((block, index) => {
    const lastBlock = index === blocks.length - 1;
    switch (block.type) {
      case "text":
        {
          // Put source numbers before any trailing line breaks so they don't break the next paragraph or heading.
          const links = citationLinks(block, sources);
          textRun += links ? block.text.replace(/\s*$/, (tail) => links + tail) : block.text;
        }
        return;
      case "thinking": {
        flushText();
        const text = block.thinking.trim();
        const active = streaming && lastBlock;
        if (!state.settings.showThinking || (!text && !active)) return;
        const details = h("details", { class: "thinking", open: active }, [
          h("summary", {}, [active ? h("span", { class: "pulse", "aria-hidden": "true" }) : null, active ? "Thinking…" : "Thinking"]),
          text ? h("div", { class: "thinking-body", text }) : null,
        ]);
        body.append(details);
        return;
      }
      case "server_tool_use": {
        flushText();
        const input = (block.input ?? {}) as { query?: string };
        const label =
          block.name === "web_search"
            ? input.query
              ? `Searched the web for “${input.query}”`
              : "Searching the web…"
            : `Used ${block.name}`;
        body.append(h("div", { class: "tool-line" }, [icon("globe"), h("span", { text: label })]));
        return;
      }
      case "web_search_tool_result": {
        const content = block.content as unknown;
        if (Array.isArray(content)) {
          for (const r of content as { url?: string; title?: string }[]) {
            if (r.url && /^https?:\/\//i.test(r.url)) searchResults.set(r.url, r.title || r.url);
          }
        } else {
          flushText();
          const code = (content as { error_code?: string })?.error_code ?? "error";
          body.append(h("div", { class: "tool-line" }, [icon("globe"), h("span", { text: `Web search failed (${code}).` })]));
        }
        return;
      }
      case "fallback": {
        flushText();
        const fb = block as { from?: { model?: string }; to?: { model?: string } };
        body.append(
          h("div", {
            class: "notice",
            text: `${modelLabel(fb.from?.model)} declined this request, so ${modelLabel(fb.to?.model)} answered instead.`,
          }),
        );
        return;
      }
      default:
        return;
    }
  });
  flushText();

  if (streaming && !body.childElementCount) {
    body.append(h("div", { class: "typing", "aria-label": "Claude is responding" }, [h("i"), h("i"), h("i")]));
  }

  const sourceEntries = sources.size
    ? [...sources.entries()].map(([url, s]) => ({ url, title: s.title }))
    : [...searchResults.entries()].slice(0, 8).map(([url, title]) => ({ url, title }));
  if (sourceEntries.length && !streaming) {
    body.append(
      h("div", { class: "sources" }, [
        h("div", { class: "sources-title", text: sources.size ? "Sources" : "Pages found" }),
        h(
          "ol",
          {},
          sourceEntries.map((s) =>
            h("li", {}, [
              h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer nofollow", text: s.title }),
              " ",
              h("small", { text: hostOf(s.url) }),
            ]),
          ),
        ),
      ]),
    );
  }

  if (m.status === "stopped") body.append(h("div", { class: "notice", text: "Stopped before the answer finished." }));
  if (m.status === "refused") {
    const cat = m.stopDetails?.category;
    const why = m.stopDetails?.explanation;
    body.append(
      h("div", { class: "notice warn" }, [
        h("span", {
          text:
            `Claude declined to answer this${cat ? ` (${cat.replace(/_/g, " ")})` : ""}.` +
            (why ? ` ${why}` : "") +
            " This turn won't be sent back to Claude. Try rephrasing your request.",
        }),
      ]),
    );
  }
  if (m.status === "error") {
    body.append(
      h("div", { class: "notice error" }, [
        h("span", { text: m.error ?? "Something went wrong." }),
        isLast ? h("button", { type: "button", class: "btn", text: "Retry", on: { click: () => void regenerate(m.id) } }) : null,
      ]),
    );
  }

  const art = h("article", { class: "msg msg-assistant", "data-id": m.id }, [
    h("div", { class: "who" }, [h("span", { class: "avatar" }, [icon("spark")]), h("span", { text: modelLabel(servedBy) })]),
    body,
  ]);

  if (!streaming && m.status !== "error") {
    const foot = h("div", { class: "msg-foot" });
    const actions = h("div", { class: "msg-actions always" }, [
      iconButton("copy", "Copy response", () => void copyText(assistantText(m))),
      isLast && !state.streaming ? iconButton("retry", "Regenerate response", () => void regenerate(m.id)) : null,
    ]);
    foot.append(actions);
    if (m.usage) {
      const u = m.usage;
      const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
      const cachePct = prompt ? Math.round((u.cacheReadTokens / prompt) * 100) : 0;
      foot.append(h("span", { text: `${formatTokens(prompt)} in · ${formatTokens(u.outputTokens)} out` }));
      if (cachePct) foot.append(h("span", { title: "Share of the prompt served from the prompt cache", text: `${cachePct}% cached` }));
      if (u.webSearches) foot.append(h("span", { text: `${u.webSearches} search${u.webSearches === 1 ? "" : "es"}` }));
      foot.append(
        state.demo
          ? h("span", { title: "Demo replies are free; this shows what a real reply might cost", text: `example cost ${formatUSD(u.costUSD)}` })
          : h("span", { title: u.estimated ? "Estimate" : "Cost at API list prices", text: `${u.estimated ? "≈ " : ""}${formatUSD(u.costUSD)}` }),
      );
    }
    art.append(foot);
  }
  return art;
}

function renderUser(m: ChatMessage, conv: Conversation): HTMLElement {
  const art = h("article", { class: "msg msg-user", "data-id": m.id });
  if (state.editingId === m.id) {
    const box = h("textarea", { class: "textarea", "aria-label": "Edit message" });
    box.value = m.text ?? "";
    const save = () => {
      const text = box.value.trim();
      if (!text && !m.attachments?.length) return;
      state.editingId = null;
      void resendEdited(conv, m.id, text);
    };
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && state.settings.enterToSend) {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") {
        state.editingId = null;
        renderThread();
      }
    });
    art.append(
      h("div", { class: "edit-box" }, [
        box,
        h("div", { class: "row" }, [
          h("button", {
            type: "button",
            class: "btn",
            text: "Cancel",
            on: {
              click: () => {
                state.editingId = null;
                renderThread();
              },
            },
          }),
          h("button", { type: "button", class: "btn btn-primary", text: "Save and send", on: { click: save } }),
        ]),
      ]),
    );
    requestAnimationFrame(() => box.focus());
    return art;
  }
  if (m.attachments?.length) {
    art.append(
      h(
        "div",
        { class: "attach-strip" },
        m.attachments.map((a) =>
          a.kind === "image"
            ? h("img", { class: "attach-thumb", src: attachmentUrl(a), alt: a.name })
            : h("span", { class: "file-chip" }, [icon("file"), h("span", { text: a.name })]),
        ),
      ),
    );
  }
  if (m.text) art.append(h("div", { class: "bubble", text: m.text }));
  art.append(
    h("div", { class: "msg-actions" }, [
      iconButton("copy", "Copy message", () => void copyText(m.text ?? "")),
      state.streaming
        ? null
        : iconButton("edit", "Edit and resend", () => {
            state.editingId = m.id;
            renderThread();
          }),
    ]),
  );
  return art;
}

const STARTERS = [
  { title: "Explain something", text: "Explain how prompt caching works, as if I'm new to it." },
  { title: "Review my code", text: "Review this Python function for bugs and readability:\n\n" },
  { title: "Draft a message", text: "Draft a short, friendly follow-up email to a recruiter after an interview." },
  { title: "Plan a project", text: "Help me plan a small data science portfolio project, step by step." },
];

function renderEmpty(): HTMLElement {
  return h("div", { class: "empty" }, [
    h("div", { class: "empty-inner" }, [
      h("h1", { text: "What should we work on?" }),
      h("p", { text: "Your chats here are separate from claude.ai and are stored only in this browser." }),
      h(
        "div",
        { class: "starters" },
        STARTERS.map((s) =>
          h(
            "button",
            {
              type: "button",
              class: "starter",
              on: {
                click: () => {
                  textarea.value = s.text;
                  autoGrow();
                  textarea.focus();
                  textarea.setSelectionRange(s.text.length, s.text.length);
                },
              },
            },
            [h("strong", { text: s.title }), h("span", { text: s.text.split("\n")[0] })],
          ),
        ),
      ),
    ]),
  ]);
}

function renderWelcome(): HTMLElement {
  const input = h("input", {
    class: "input",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "sk-ant-…",
    "aria-label": "Anthropic API key",
  });
  const remember = h("input", { type: "checkbox", checked: true });
  const button = h("button", { type: "submit", class: "btn btn-primary", text: "Connect" });
  const error = h("p", { class: "notice error", hidden: true });
  const form = h(
    "form",
    {
      on: {
        submit: async (e) => {
          e.preventDefault();
          const key = input.value.trim();
          if (!key) return;
          button.disabled = true;
          button.textContent = "Checking…";
          error.hidden = true;
          try {
            await verifyKey(key);
            connectKey(key, remember.checked);
          } catch (err) {
            error.textContent = describeError(err).message;
            error.hidden = false;
          } finally {
            button.disabled = false;
            button.textContent = "Connect";
          }
        },
      },
    },
    [
      h("label", { class: "field" }, [h("span", { text: "Your Anthropic API key" }), input]),
      h("label", { class: "check" }, [remember, h("span", { text: "Remember on this device" })]),
      error,
      button,
    ],
  );
  const consoleLink = h("a", {
    href: "https://console.anthropic.com/settings/keys",
    target: "_blank",
    rel: "noopener noreferrer",
    text: "console.anthropic.com",
  });
  return h("div", { class: "empty" }, [
    h("div", { class: "welcome" }, [
      h("h1", { text: "Connect to Claude" }),
      h("p", { text: "This is your own Claude workspace. It talks to the Claude API with your key, and keeps its own history in this browser." }),
      h("ol", {}, [
        h("li", {}, ["Create an API key at ", consoleLink, " (API usage is billed separately from a Claude subscription)."]),
        h("li", { text: "Paste it below. It is stored only in this browser and sent only to api.anthropic.com." }),
      ]),
      form,
      h("div", { class: "demo-cta" }, [
        h("span", { text: "Just want to look around first?" }),
        h("button", { type: "button", class: "btn", text: "Try the free demo", on: { click: () => enterDemo() } }),
      ]),
      h("p", {
        class: "fine",
        text: "Unofficial client. Nothing you type here appears in your claude.ai history. Anyone who can use this browser profile can use the remembered key, so untick Remember on shared computers.",
      }),
    ]),
  ]);
}

function renderThread(): void {
  threadInner.replaceChildren();
  demoBanner.hidden = !state.demo;
  if (!connected()) {
    threadInner.append(renderWelcome());
    composerWrap.hidden = true;
    return;
  }
  composerWrap.hidden = false;
  const conv = state.current;
  if (!conv || !conv.messages.length) {
    threadInner.append(renderEmpty());
    jumpBtn.hidden = true;
    return;
  }
  const lastAssistant = [...conv.messages].reverse().find((m) => m.role === "assistant");
  for (const m of conv.messages) {
    threadInner.append(m.role === "user" ? renderUser(m, conv) : renderAssistant(m, m === lastAssistant && m === conv.messages.at(-1)));
  }
}

// Streaming updates re-render only the message being written, at most every 60 ms.
let renderQueued = false;
let lastRender = 0;
function scheduleStreamRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  const wait = Math.max(0, 60 - (performance.now() - lastRender));
  setTimeout(() => {
    requestAnimationFrame(() => {
      renderQueued = false;
      lastRender = performance.now();
      const s = state.streaming;
      const conv = state.current;
      if (!s || !conv || conv.id !== s.convId) return;
      const m = conv.messages.find((x) => x.id === s.msgId);
      const node = threadInner.querySelector(`[data-id="${s.msgId}"]`);
      if (!m || !node) return;
      const stick = nearBottom();
      node.replaceWith(renderAssistant(m, true));
      if (stick) scrollToBottom();
    });
  }, wait);
}

// ---------- composer ----------

function syncComposer(): void {
  const conv = state.current;
  const model = conv?.model ?? state.settings.defaultModel;
  modelSelect.value = isKnownModel(model) ? model : MODELS[0].id;
  effortSelect.value = conv?.effort ?? state.settings.defaultEffort;
  // Short labels on narrow screens so the picker isn't cut off.
  const compact = window.matchMedia("(max-width: 560px)").matches;
  for (const option of effortSelect.options) {
    const e = EFFORTS.find((x) => x.id === option.value);
    if (e) option.text = compact ? e.label : `${e.label} effort`;
  }
  const web = conv?.webSearch ?? state.settings.webSearchDefault;
  webBtn.setAttribute("aria-pressed", String(web));
  const locked = Boolean(conv?.started);
  webBtn.disabled = locked;
  webBtn.title = locked
    ? `Web search is ${web ? "on" : "off"} for this chat (set when the chat starts, so the prompt cache stays valid)`
    : `Web search ${web ? "on" : "off"} (about $0.01 per search)`;
  webBtn.setAttribute("aria-label", webBtn.title);
  attachBtn.disabled = Boolean(state.streaming);
  syncSendButton();
  renderPending();
  renderLimitBanner();
  composerHint.textContent = state.settings.enterToSend
    ? "Enter to send · Shift+Enter for a new line · Chats are saved only in this browser"
    : "Ctrl+Enter to send · Chats are saved only in this browser";
}

function syncSendButton(): void {
  const streaming = Boolean(state.streaming);
  sendBtn.classList.toggle("stop", streaming);
  sendBtn.replaceChildren(icon(streaming ? "stop" : "send"));
  sendBtn.setAttribute("aria-label", streaming ? "Stop" : "Send");
  sendBtn.title = streaming ? "Stop" : "Send";
  sendBtn.disabled = !streaming && !textarea.value.trim() && !state.pending.length;
}

function renderPending(): void {
  pendingEl.replaceChildren();
  pendingEl.hidden = !state.pending.length;
  for (const a of state.pending) {
    const remove = h("button", {
      type: "button",
      class: "remove",
      "aria-label": `Remove ${a.name}`,
      text: "×",
      on: {
        click: () => {
          state.pending = state.pending.filter((p) => p.id !== a.id);
          syncComposer();
        },
      },
    });
    pendingEl.append(
      h("div", { class: "pending-item" }, [
        a.kind === "image"
          ? h("img", { class: "attach-thumb", src: attachmentUrl(a), alt: a.name })
          : h("span", { class: "file-chip" }, [icon("file"), h("span", { text: a.name })]),
        remove,
      ]),
    );
  }
}

async function addFiles(files: FileList | null): Promise<void> {
  if (!files?.length) return;
  for (const file of Array.from(files)) {
    if (state.pending.length >= MAX_ATTACHMENTS) {
      toast(`You can attach up to ${MAX_ATTACHMENTS} files per message.`, "error");
      break;
    }
    try {
      state.pending.push(await readAttachment(file));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  fileInput.value = "";
  syncComposer();
}

function onComposerKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && state.streaming) {
    stopStreaming();
    return;
  }
  if (e.key !== "Enter" || e.isComposing) return;
  const wantsSend = state.settings.enterToSend ? !e.shiftKey : e.ctrlKey || e.metaKey;
  if (wantsSend) {
    e.preventDefault();
    if (!state.streaming) void sendFromComposer();
  }
}

function currentOrNew(): Conversation {
  if (!state.current) state.current = newConversation();
  return state.current;
}

function setModel(id: string): void {
  const conv = currentOrNew();
  conv.model = getModel(id).id;
  void persist(conv);
  renderTopbar();
}

function setEffort(id: string): void {
  const conv = currentOrNew();
  const effort = EFFORTS.find((e) => e.id === id);
  if (effort) conv.effort = effort.id;
  void persist(conv);
}

function toggleWebSearch(): void {
  const conv = currentOrNew();
  if (conv.started) return;
  conv.webSearch = !conv.webSearch;
  syncComposer();
}

function renderLimitBanner(): void {
  const status = checkLimits(state.usage, state.settings.limits);
  limitBanner.replaceChildren();
  if (status.blocked && !state.overrideLimitOnce) {
    const resetNote =
      status.blocked.includes("hour") && status.windowResetAt
        ? ` It frees up in about ${formatDuration(status.windowResetAt - Date.now())}.`
        : "";
    limitBanner.append(
      h("div", { class: "notice warn" }, [
        h("span", { text: `You've reached your ${status.blocked}.${resetNote} Change it in Settings → Limits.` }),
        h("button", {
          type: "button",
          class: "btn",
          text: "Send one anyway",
          on: {
            click: () => {
              state.overrideLimitOnce = true;
              renderLimitBanner();
              textarea.focus();
            },
          },
        }),
      ]),
    );
    limitBanner.hidden = false;
  } else if (status.warnings.length) {
    limitBanner.append(h("div", { class: "notice", text: `You've used over 80% of your ${status.warnings.join(" and ")}.` }));
    limitBanner.hidden = false;
  } else {
    limitBanner.hidden = true;
  }
}

// ---------- sending ----------

async function sendFromComposer(): Promise<void> {
  const text = textarea.value.trim();
  if ((!text && !state.pending.length) || state.streaming || !state.client) return;
  const status = checkLimits(state.usage, state.settings.limits);
  if (status.blocked && !state.overrideLimitOnce) {
    renderLimitBanner();
    toast(`You've reached your ${status.blocked}.`, "error");
    return;
  }
  state.overrideLimitOnce = false;

  const conv = currentOrNew();
  if (!conv.started) {
    conv.started = true;
    conv.systemPrompt = composeSystemPrompt(state.settings.systemPrompt, state.settings.includeDate);
    conv.title = titleFrom(text || state.pending[0]?.name || "New chat");
  }
  conv.messages.push({
    id: crypto.randomUUID(),
    role: "user",
    createdAt: Date.now(),
    text,
    attachments: state.pending.length ? state.pending : undefined,
  });
  state.pending = [];
  textarea.value = "";
  autoGrow();
  conv.updatedAt = Date.now();
  upsertConversation(conv);
  await persist(conv);
  await runAssistant(conv);
}

async function resendEdited(conv: Conversation, messageId: string, text: string): Promise<void> {
  if (state.streaming) return;
  const index = conv.messages.findIndex((m) => m.id === messageId);
  if (index === -1) return;
  const original = conv.messages[index];
  // Keep everything before the edited turn unchanged; drop the edited turn and what followed.
  conv.messages = conv.messages.slice(0, index);
  conv.messages.push({ ...original, id: crypto.randomUUID(), text, createdAt: Date.now() });
  conv.updatedAt = Date.now();
  await persist(conv);
  await runAssistant(conv);
}

async function regenerate(messageId: string): Promise<void> {
  const conv = state.current;
  if (!conv || state.streaming) return;
  const index = conv.messages.findIndex((m) => m.id === messageId);
  if (index === -1) return;
  conv.messages = conv.messages.slice(0, index);
  await persist(conv);
  await runAssistant(conv);
}

function stopStreaming(): void {
  state.streaming?.controller.abort();
}

async function runAssistant(conv: Conversation): Promise<void> {
  if (!state.client) return;
  const history = conv.messages.slice();
  const placeholder: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    createdAt: Date.now(),
    requestedModel: conv.model,
    status: "streaming",
    segments: [],
  };
  conv.messages.push(placeholder);
  const controller = new AbortController();
  state.streaming = { convId: conv.id, msgId: placeholder.id, controller };
  state.editingId = null;
  renderAll();
  scrollToBottom();

  try {
    const result = await runTurn(state.client, { ...conv, messages: history }, state.settings.maxTokens, controller.signal, {
      onUpdate(segments, live, liveModel) {
        placeholder.segments = live.length
          ? [...segments, { content: live, model: liveModel ?? conv.model, stopReason: null }]
          : segments.slice();
        scheduleStreamRender();
      },
      onRateLimits(snapshot) {
        state.rateLimits = snapshot;
      },
    });
    placeholder.segments = result.segments;
    placeholder.status = result.status;
    placeholder.stopDetails = result.stopDetails;
    placeholder.usage = result.usage;
    await recordUsage(conv, placeholder);
  } catch (err) {
    const info = describeError(err);
    placeholder.status = "error";
    placeholder.error = info.message;
    if (info.needsKey) openSettings("key");
  } finally {
    state.streaming = null;
    conv.updatedAt = Date.now();
    upsertConversation(conv);
    await persist(conv);
    if (state.current?.id === conv.id) {
      const stick = nearBottom();
      renderAll();
      if (stick) scrollToBottom();
    } else {
      renderList();
    }
  }
}

async function recordUsage(conv: Conversation, m: ChatMessage): Promise<void> {
  if (state.demo) return; // demo replies cost nothing
  const u = m.usage;
  if (!u || (!u.inputTokens && !u.outputTokens && !u.cacheReadTokens && !u.cacheWriteTokens)) return;
  const record: UsageRecord = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    conversationId: conv.id,
    model: m.segments?.at(-1)?.model ?? conv.model,
    costUSD: u.costUSD,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    webSearches: u.webSearches,
  };
  state.usage.push(record);
  try {
    await store.addUsage(record);
  } catch {
    /* usage stays in memory for this session */
  }
}

// ---------- conversations ----------

function openConversation(id: string): void {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  state.current = conv;
  state.editingId = null;
  app.classList.remove("nav-open");
  renderAll();
  scrollToBottom();
  if (window.matchMedia("(min-width: 861px)").matches) textarea.focus();
}

function startNewChat(): void {
  if (state.current && !state.current.started && !state.current.messages.length) {
    textarea.focus();
    app.classList.remove("nav-open");
    return;
  }
  state.current = newConversation();
  state.editingId = null;
  app.classList.remove("nav-open");
  renderAll();
  textarea.focus();
}

async function removeConversation(conv: Conversation): Promise<void> {
  if (state.streaming?.convId === conv.id) {
    toast("Stop the response before deleting this chat.", "error");
    return;
  }
  if (!confirm(`Delete “${conv.title}”? This can't be undone.`)) return;
  await store.deleteConversation(conv.id);
  state.conversations = state.conversations.filter((c) => c.id !== conv.id);
  state.current = null;
  renderAll();
  toast("Chat deleted.");
}

function conversationMarkdown(conv: Conversation): string {
  const lines = [`# ${conv.title}`, "", `_Exported from API B Claude on ${new Date().toLocaleString()}_`, ""];
  for (const m of conv.messages) {
    if (m.role === "user") {
      lines.push("## You", "");
      for (const a of m.attachments ?? []) lines.push(`_[attached: ${a.name}]_`);
      lines.push(m.text ?? "", "");
    } else {
      lines.push(`## ${modelLabel(m.segments?.at(-1)?.model ?? m.requestedModel)}`, "", assistantText(m) || `_(${m.status ?? "no answer"})_`, "");
    }
  }
  return lines.join("\n");
}

function exportConversation(conv: Conversation): void {
  const safe = conv.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "chat";
  download(`${safe}.md`, conversationMarkdown(conv), "text/markdown");
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    toast("Couldn't copy to the clipboard.", "error");
  }
}

// ---------- key ----------

function connectKey(key: string, remember: boolean): void {
  const wasDemo = state.demo;
  store.saveApiKey(key, remember);
  state.key = { key, remembered: remember };
  state.client = createClient(key);
  if (wasDemo) {
    // Demo chats hold sample replies Claude never wrote, so they can't continue for real.
    stopStreaming();
    state.demo = false;
    writeDemoFlag(false);
    state.current = null;
    void loadData().then(renderAll);
  }
  renderAll();
  textarea.focus();
  toast("Connected. Your key is stored only in this browser.");
}

function enterDemo(): void {
  state.demo = true;
  writeDemoFlag(true);
  state.client = createDemoClient();
  state.current = null;
  renderAll();
  textarea.focus();
}

function leaveDemo(): void {
  stopStreaming();
  state.demo = false;
  writeDemoFlag(false);
  state.client = state.key ? createClient(state.key.key) : null;
  state.current = null;
  void loadData().then(renderAll);
}

function disconnectKey(): void {
  stopStreaming();
  store.clearApiKey();
  state.key = null;
  state.client = null;
  renderAll();
}

// ---------- dialogs ----------

function dialogShell(title: string): { dialog: HTMLDialogElement; body: HTMLElement } {
  const dialog = h("dialog", { "aria-label": title });
  const body = h("div", { class: "dlg-body" });
  dialog.append(
    h("div", { class: "dlg" }, [
      h("div", { class: "dlg-head" }, [h("h2", { text: title }), iconButton("close", "Close", () => dialog.close())]),
      body,
    ]),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  return { dialog, body };
}

type SettingsTab = "key" | "chat" | "limits" | "appearance" | "data";

function openSettings(initial: SettingsTab = state.key ? "chat" : "key"): void {
  document.querySelector("dialog[open]")?.remove();
  const { dialog, body } = dialogShell("Settings");
  const nav = h("div", { class: "dlg-nav", role: "tablist", "aria-label": "Settings sections" });
  const panel = h("div", { class: "dlg-panel", role: "tabpanel" });
  const tabs: { id: SettingsTab; label: string; render: () => Node[] }[] = [
    { id: "key", label: "API key", render: keyPanel },
    { id: "chat", label: "Chat defaults", render: chatPanel },
    { id: "limits", label: "Limits", render: limitsPanel },
    { id: "appearance", label: "Appearance", render: appearancePanel },
    { id: "data", label: "Your data", render: dataPanel },
  ];
  const show = (id: SettingsTab) => {
    for (const b of nav.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === id));
    panel.replaceChildren(...tabs.find((t) => t.id === id)!.render());
  };
  for (const t of tabs) {
    nav.append(h("button", { type: "button", role: "tab", "data-tab": t.id, text: t.label, on: { click: () => show(t.id) } }));
  }
  body.append(nav, panel);
  show(initial);
  dialog.showModal();

  function keyPanel(): Node[] {
    const input = h("input", { class: "input", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "sk-ant-…" });
    const remember = h("input", { type: "checkbox", checked: state.key ? state.key.remembered : true });
    const status = h("p", {
      text: state.key
        ? `Connected with a key ending in ${state.key.key.slice(-4)}${state.key.remembered ? ", remembered on this device." : ", for this browser session only."}`
        : state.demo
          ? "Demo mode is on: replies are free samples. Connect a key below to chat with the real Claude."
          : "No key connected.",
    });
    const save: HTMLButtonElement = h("button", {
      type: "button",
      class: "btn btn-primary",
      text: state.key ? "Replace key" : "Connect",
      on: {
        click: async () => {
          const key = input.value.trim() || state.key?.key || "";
          if (!key) return;
          save.disabled = true;
          save.textContent = "Checking…";
          try {
            await verifyKey(key);
            connectKey(key, remember.checked);
            dialog.close();
          } catch (err) {
            toast(describeError(err).message, "error");
          } finally {
            save.disabled = false;
            save.textContent = state.key ? "Replace key" : "Connect";
          }
        },
      },
    });
    return [
      h("h3", { text: "Anthropic API key" }),
      status,
      h("label", { class: "field" }, [h("span", { text: state.key ? "New key (leave empty to keep the current one)" : "API key" }), input]),
      h("label", { class: "check" }, [remember, h("span", { text: "Remember on this device (untick on shared computers)" })]),
      h("div", { class: "row-actions" }, [
        save,
        state.key
          ? h("button", {
              type: "button",
              class: "btn btn-danger",
              text: "Remove key",
              on: {
                click: () => {
                  disconnectKey();
                  dialog.close();
                },
              },
            })
          : null,
      ]),
      h("p", {}, [
        "Get or revoke keys at ",
        h("a", { href: "https://console.anthropic.com/settings/keys", target: "_blank", rel: "noopener noreferrer", text: "console.anthropic.com" }),
        ". The key is sent only to api.anthropic.com. API usage is billed to your Console account, separately from any Claude subscription.",
      ]),
    ];
  }

  function chatPanel(): Node[] {
    const s = state.settings;
    const model = h(
      "select",
      { class: "select" },
      MODELS.map((m) => h("option", { value: m.id, text: `${m.label} — ${m.blurb}`, selected: m.id === s.defaultModel })),
    );
    const effort = h(
      "select",
      { class: "select" },
      EFFORTS.map((e) => h("option", { value: e.id, text: `${e.label} — ${e.hint}`, selected: e.id === s.defaultEffort })),
    );
    const maxTokens = h("input", { class: "input", type: "number", min: "1024", max: "128000", step: "1024", value: String(s.maxTokens) });
    const system = h("textarea", { class: "textarea", placeholder: "For example: Answer concisely. I'm a data scientist working in Python." });
    system.value = s.systemPrompt;
    const includeDate = h("input", { type: "checkbox", checked: s.includeDate });
    const web = h("input", { type: "checkbox", checked: s.webSearchDefault });
    const thinking = h("input", { type: "checkbox", checked: s.showThinking });
    const enter = h("input", { type: "checkbox", checked: s.enterToSend });
    const save: HTMLButtonElement = h("button", {
      type: "button",
      class: "btn btn-primary",
      text: "Save",
      on: {
        click: () => {
          s.defaultModel = getModel(model.value).id;
          s.defaultEffort = (EFFORTS.find((e) => e.id === effort.value) ?? EFFORTS[1]).id;
          s.maxTokens = Math.min(128000, Math.max(1024, Math.round(Number(maxTokens.value) || 64000)));
          s.systemPrompt = system.value;
          s.includeDate = includeDate.checked;
          s.webSearchDefault = web.checked;
          s.showThinking = thinking.checked;
          s.enterToSend = enter.checked;
          saveSettings();
          if (state.current && !state.current.started) {
            state.current.model = s.defaultModel;
            state.current.effort = s.defaultEffort;
            state.current.webSearch = s.webSearchDefault;
          }
          renderAll();
          toast("Settings saved.");
        },
      },
    });
    return [
      h("h3", { text: "Defaults for new chats" }),
      h("div", { class: "grid-2" }, [
        h("label", { class: "field" }, [h("span", { text: "Model" }), model]),
        h("label", { class: "field" }, [h("span", { text: "Effort" }), effort]),
      ]),
      h("label", { class: "field" }, [
        h("span", { text: "Max response length (tokens)" }),
        maxTokens,
        h("small", { text: "Includes Claude's thinking. 64,000 is a good default; you only pay for what's used." }),
      ]),
      h("label", { class: "field" }, [
        h("span", { text: "Custom instructions" }),
        system,
        h("small", { text: "Sent as the system prompt. Each chat keeps the instructions it started with." }),
      ]),
      h("label", { class: "check" }, [includeDate, h("span", { text: "Tell Claude today's date at the start of each chat" })]),
      h("label", { class: "check" }, [web, h("span", { text: "Turn on web search for new chats (about $0.01 per search)" })]),
      h("label", { class: "check" }, [thinking, h("span", { text: "Show Claude's thinking summaries" })]),
      h("label", { class: "check" }, [enter, h("span", { text: "Press Enter to send (Shift+Enter for a new line)" })]),
      h("div", { class: "row-actions" }, [save]),
    ];
  }

  function limitsPanel(): Node[] {
    const l = state.settings.limits;
    const status = checkLimits(state.usage, l);
    const daily = h("input", { class: "input", type: "number", min: "0", step: "0.5", value: String(l.dailyUSD) });
    const monthly = h("input", { class: "input", type: "number", min: "0", step: "1", value: String(l.monthlyUSD) });
    const msgs = h("input", { class: "input", type: "number", min: "0", step: "1", value: String(l.messagesPerWindow) });
    const hours = h("input", { class: "input", type: "number", min: "1", max: "168", step: "1", value: String(l.windowHours) });
    const save: HTMLButtonElement = h("button", {
      type: "button",
      class: "btn btn-primary",
      text: "Save limits",
      on: {
        click: () => {
          const n = (el: HTMLInputElement, min = 0) => Math.max(min, Number(el.value) || 0);
          l.dailyUSD = n(daily);
          l.monthlyUSD = n(monthly);
          l.messagesPerWindow = Math.round(n(msgs));
          l.windowHours = Math.min(168, Math.round(n(hours, 1)) || 5);
          saveSettings();
          renderAll();
          toast("Limits saved.");
        },
      },
    });
    return [
      h("h3", { text: "Your own limits" }),
      h("p", {
        text: "Claude subscription limits can't be read or shared with the API, so set your own here. The app warns you at 80% and stops sending at 100% (you can still send one message anyway). Use 0 for no limit.",
      }),
      h("div", { class: "stat-grid" }, [
        h("div", { class: "stat" }, [h("b", { text: formatUSD(status.todayUSD) }), h("span", { text: "spent today" })]),
        h("div", { class: "stat" }, [h("b", { text: formatUSD(status.monthUSD) }), h("span", { text: "spent this month" })]),
        h("div", { class: "stat" }, [h("b", { text: String(status.windowMessages) }), h("span", { text: `messages in the last ${l.windowHours} h` })]),
      ]),
      h("div", { class: "grid-2" }, [
        h("label", { class: "field" }, [h("span", { text: "Daily spending limit ($)" }), daily]),
        h("label", { class: "field" }, [h("span", { text: "Monthly spending limit ($)" }), monthly]),
        h("label", { class: "field" }, [h("span", { text: "Messages per window" }), msgs, h("small", { text: "Like a plan's usage window." })]),
        h("label", { class: "field" }, [h("span", { text: "Window length (hours)" }), hours]),
      ]),
      h("div", { class: "row-actions" }, [save]),
      h("p", {}, [
        "For a hard cap that also covers other apps, set a spend limit on your key in the ",
        h("a", { href: "https://console.anthropic.com/settings/limits", target: "_blank", rel: "noopener noreferrer", text: "Claude Console" }),
        ".",
      ]),
    ];
  }

  function appearancePanel(): Node[] {
    const choices: { id: Settings["theme"]; label: string }[] = [
      { id: "system", label: "Match my device" },
      { id: "light", label: "Light" },
      { id: "dark", label: "Dark" },
    ];
    return [
      h("h3", { text: "Theme" }),
      ...choices.map((c) =>
        h("label", { class: "check" }, [
          h("input", {
            type: "radio",
            name: "theme",
            checked: state.settings.theme === c.id,
            on: {
              change: () => {
                state.settings.theme = c.id;
                saveSettings();
                applyTheme();
              },
            },
          }),
          h("span", { text: c.label }),
        ]),
      ),
    ];
  }

  function dataPanel(): Node[] {
    const importInput: HTMLInputElement = h("input", {
      type: "file",
      accept: "application/json,.json",
      hidden: true,
      on: { change: () => void importData(importInput.files?.[0]) },
    });
    return [
      h("h3", { text: "Your data" }),
      h("p", {
        text: `${state.conversations.length} chat${state.conversations.length === 1 ? "" : "s"} saved in this browser. Nothing is stored on a server, and none of it appears in your claude.ai history. The API itself keeps requests only as Anthropic's API data policy describes.`,
      }),
      h("div", { class: "row-actions" }, [
        h("button", { type: "button", class: "btn", on: { click: () => void exportAll() } }, [icon("download"), "Export all chats"]),
        h("button", { type: "button", class: "btn", text: "Import chats", on: { click: () => importInput.click() } }),
        importInput,
      ]),
      h("h3", { text: "Delete everything" }),
      h("p", { text: "Removes all chats, usage history, settings and the saved key from this browser." }),
      h("div", { class: "row-actions" }, [
        h("button", {
          type: "button",
          class: "btn btn-danger",
          text: "Delete all data",
          on: {
            click: async () => {
              if (!confirm("Delete all chats, usage history, settings and your saved key from this browser?")) return;
              stopStreaming();
              await store.clearAllData();
              location.reload();
            },
          },
        }),
      ]),
    ];
  }
}

async function exportAll(): Promise<void> {
  const data = {
    app: "api-b-claude",
    version: 1,
    exportedAt: new Date().toISOString(),
    conversations: await store.listConversations(),
    usage: await store.listAllUsage(),
  };
  download(`api-b-claude-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
}

function looksLikeConversation(c: unknown): c is Conversation {
  const x = c as Conversation;
  return Boolean(x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.messages));
}

async function importData(file: File | undefined): Promise<void> {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text()) as { conversations?: unknown[]; usage?: UsageRecord[] };
    const convs = (data.conversations ?? []).filter(looksLikeConversation);
    for (const c of convs) {
      c.started = true;
      c.model = getModel(c.model).id;
      await store.putConversation(c);
    }
    for (const u of data.usage ?? []) {
      if (u && typeof u.id === "string" && typeof u.ts === "number") await store.addUsage(u);
    }
    await loadData();
    renderAll();
    toast(`Imported ${convs.length} chat${convs.length === 1 ? "" : "s"}.`);
  } catch (err) {
    toast(`That file couldn't be imported: ${(err as Error).message}`, "error");
  }
}

async function openUsage(): Promise<void> {
  document.querySelector("dialog[open]")?.remove();
  const { dialog, body } = dialogShell("Usage and limits");
  body.style.display = "block";
  const panel = h("div", { class: "dlg-panel" });
  body.append(panel);
  dialog.showModal();

  const all = await store.listAllUsage().catch(() => state.usage);
  const now = Date.now();
  const sum = (records: UsageRecord[]) =>
    records.reduce(
      (t, r) => ({
        cost: t.cost + r.costUSD,
        input: t.input + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens,
        output: t.output + r.outputTokens,
        cached: t.cached + r.cacheReadTokens,
        count: t.count + 1,
      }),
      { cost: 0, input: 0, output: 0, cached: 0, count: 0 },
    );
  const today = sum(all.filter((r) => r.ts >= new Date(now).setHours(0, 0, 0, 0)));
  const month = sum(all.filter((r) => r.ts >= startOfMonth(now)));
  const total = sum(all);
  const byModel = new Map<string, UsageRecord[]>();
  for (const r of all.filter((x) => x.ts >= startOfMonth(now))) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);

  const rl = state.rateLimits;
  const rlNode: Node[] = !rl
    ? [h("p", { text: "Send a message to see your API rate limits." })]
    : !rl.available
      ? [h("p", { text: "The API didn't share rate-limit details with this browser. If you hit a limit, the app tells you how long to wait." })]
      : [
          h("div", { class: "stat-grid" }, [
            rl.requestsRemaining !== undefined
              ? h("div", { class: "stat" }, [h("b", { text: `${rl.requestsRemaining}${rl.requestsLimit ? ` / ${rl.requestsLimit}` : ""}` }), h("span", { text: "requests left this minute" })])
              : null,
            rl.inputTokensRemaining !== undefined
              ? h("div", { class: "stat" }, [h("b", { text: formatTokens(rl.inputTokensRemaining) }), h("span", { text: "input tokens left this minute" })])
              : null,
            rl.outputTokensRemaining !== undefined
              ? h("div", { class: "stat" }, [h("b", { text: formatTokens(rl.outputTokensRemaining) }), h("span", { text: "output tokens left this minute" })])
              : null,
          ]),
        ];

  const cachePct = month.input ? Math.round((month.cached / month.input) * 100) : 0;
  panel.append(
    h("h3", { text: "Spending (estimated at API list prices)" }),
    h("div", { class: "stat-grid" }, [
      h("div", { class: "stat" }, [h("b", { text: formatUSD(today.cost) }), h("span", { text: `today · ${today.count} replies` })]),
      h("div", { class: "stat" }, [h("b", { text: formatUSD(month.cost) }), h("span", { text: `this month · ${month.count} replies` })]),
      h("div", { class: "stat" }, [h("b", { text: formatUSD(total.cost) }), h("span", { text: "all time in this browser" })]),
    ]),
    h("h3", { text: "Tokens this month" }),
    h("div", { class: "stat-grid" }, [
      h("div", { class: "stat" }, [h("b", { text: formatTokens(month.input) }), h("span", { text: "input tokens" })]),
      h("div", { class: "stat" }, [h("b", { text: formatTokens(month.output) }), h("span", { text: "output tokens" })]),
      h("div", { class: "stat" }, [h("b", { text: `${cachePct}%` }), h("span", { text: "of input served from cache" })]),
    ]),
    byModel.size
      ? h("table", { class: "table" }, [
          h("thead", {}, [h("tr", {}, [h("th", { text: "Model" }), h("th", { text: "Replies" }), h("th", { text: "Tokens" }), h("th", { text: "Cost" })])]),
          h(
            "tbody",
            {},
            [...byModel.entries()].map(([model, records]) => {
              const t = sum(records);
              return h("tr", {}, [
                h("td", { text: modelLabel(model) }),
                h("td", { text: String(t.count) }),
                h("td", { text: formatTokens(t.input + t.output) }),
                h("td", { text: formatUSD(t.cost) }),
              ]);
            }),
          ),
        ])
      : h("p", { text: "No usage this month yet." }),
    h("h3", { text: "API rate limits" }),
    ...rlNode,
    h("p", {
      text: "Your Claude subscription's limits (Pro or Max) apply only to claude.ai and Claude Code, and can't be read from here. This app uses your API key's own limits, plus any limits you set yourself.",
    }),
    h("div", { class: "row-actions" }, [
      h("button", {
        type: "button",
        class: "btn",
        text: "Set my limits",
        on: {
          click: () => {
            dialog.close();
            openSettings("limits");
          },
        },
      }),
    ]),
  );
}

// ---------- render all and start ----------

function renderAll(): void {
  renderList();
  renderUsageMini();
  renderTopbar();
  renderThread();
  syncComposer();
}

async function loadData(): Promise<void> {
  try {
    state.conversations = await store.listConversations();
    const since = Math.min(startOfMonth(Date.now()), Date.now() - state.settings.limits.windowHours * 3_600_000);
    state.usage = await store.listUsageSince(since);
  } catch (err) {
    toast(`Couldn't open saved chats: ${(err as Error).message}`, "error");
  }
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    startNewChat();
  }
});

window.matchMedia("(max-width: 560px)").addEventListener("change", () => syncComposer());

window.addEventListener("beforeunload", (e) => {
  if (state.streaming) e.preventDefault();
});

async function start(): Promise<void> {
  applyTheme();
  if (state.key) state.client = createClient(state.key.key);
  else if (state.demo) state.client = createDemoClient();
  await loadData();
  renderAll();
  if (connected() && window.matchMedia("(min-width: 861px)").matches) textarea.focus();
}

void start();
