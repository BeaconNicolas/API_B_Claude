// Everything is stored in this browser only: conversations and usage in IndexedDB,
// settings in localStorage, and the API key in localStorage or sessionStorage.

import { DEFAULT_MODEL, isKnownModel } from "./models";
import type { Conversation, Settings, UsageRecord } from "./types";

const DB_NAME = "api-b-claude";
const DB_VERSION = 1;
const SETTINGS_KEY = "abc.settings";
const KEY_NAME = "abc.apiKey";

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: DEFAULT_MODEL,
  defaultEffort: "medium",
  maxTokens: 64000,
  systemPrompt: "",
  includeDate: true,
  webSearchDefault: false,
  showThinking: true,
  enterToSend: true,
  theme: "system",
  limits: { dailyUSD: 0, monthlyUSD: 0, messagesPerWindow: 0, windowHours: 5 },
};

// ---------- small safe wrappers around Web Storage ----------
function read(store: Storage | undefined, key: string): string | null {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function write(store: Storage | undefined, key: string, value: string | null): void {
  try {
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* storage blocked or full; the app keeps working for this session */
  }
}

const local = typeof localStorage !== "undefined" ? localStorage : undefined;
const session = typeof sessionStorage !== "undefined" ? sessionStorage : undefined;

// ---------- settings ----------
export function loadSettings(): Settings {
  const raw = read(local, SETTINGS_KEY);
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged: Settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      limits: { ...DEFAULT_SETTINGS.limits, ...(parsed.limits ?? {}) },
    };
    if (!isKnownModel(merged.defaultModel)) merged.defaultModel = DEFAULT_MODEL;
    return merged;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings: Settings): void {
  write(local, SETTINGS_KEY, JSON.stringify(settings));
}

// ---------- API key ----------
export function loadApiKey(): { key: string; remembered: boolean } | null {
  const remembered = read(local, KEY_NAME);
  if (remembered) return { key: remembered, remembered: true };
  const temporary = read(session, KEY_NAME);
  if (temporary) return { key: temporary, remembered: false };
  return null;
}

export function saveApiKey(key: string, remember: boolean): void {
  write(local, KEY_NAME, remember ? key : null);
  write(session, KEY_NAME, remember ? null : key);
}

export function clearApiKey(): void {
  write(local, KEY_NAME, null);
  write(session, KEY_NAME, null);
}

// ---------- IndexedDB ----------
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("conversations")) {
        db.createObjectStore("conversations", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("usage")) {
        const usage = db.createObjectStore("usage", { keyPath: "id" });
        usage.createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("The database is open in another tab with an older version."));
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  storeName: "conversations" | "usage",
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  const transaction = db.transaction(storeName, mode);
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  const result = await promisify(run(transaction.objectStore(storeName)));
  await done;
  return result;
}

export async function listConversations(): Promise<Conversation[]> {
  const all = await tx<Conversation[]>("conversations", "readonly", (s) => s.getAll() as IDBRequest<Conversation[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putConversation(conversation: Conversation): Promise<void> {
  // Never persist a half-streamed turn as "streaming"; it would look stuck after a reload.
  const copy: Conversation = structuredClone(conversation);
  for (const m of copy.messages) {
    if (m.status === "streaming") m.status = "stopped";
  }
  await tx("conversations", "readwrite", (s) => s.put(copy));
}

export async function deleteConversation(id: string): Promise<void> {
  await tx("conversations", "readwrite", (s) => s.delete(id));
}

export async function addUsage(record: UsageRecord): Promise<void> {
  await tx("usage", "readwrite", (s) => s.put(record));
}

export async function listUsageSince(ts: number): Promise<UsageRecord[]> {
  return tx<UsageRecord[]>("usage", "readonly", (s) =>
    s.index("ts").getAll(IDBKeyRange.lowerBound(ts)) as IDBRequest<UsageRecord[]>,
  );
}

export async function listAllUsage(): Promise<UsageRecord[]> {
  return tx<UsageRecord[]>("usage", "readonly", (s) => s.getAll() as IDBRequest<UsageRecord[]>);
}

export async function clearAllData(): Promise<void> {
  await tx("conversations", "readwrite", (s) => s.clear());
  await tx("usage", "readwrite", (s) => s.clear());
  write(local, SETTINGS_KEY, null);
  clearApiKey();
}
