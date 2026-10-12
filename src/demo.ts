// Demo mode: a stand-in for the Claude API that runs entirely in the browser.
// It answers with clearly labelled sample replies so you can try the interface
// for free. It plugs in as the SDK's `fetch`, so the app's real streaming code runs.

const enc = new TextEncoder();

interface DemoBlock {
  kind: "thinking" | "text" | "search";
  text: string;
  query?: string;
}

const NOTE = "*This is a sample reply from demo mode. It doesn't come from Claude and costs nothing.*";

function pickReply(prompt: string, webSearch: boolean): DemoBlock[] {
  const p = prompt.toLowerCase();
  const blocks: DemoBlock[] = [
    { kind: "thinking", text: `The user asked: "${prompt.slice(0, 120)}". In demo mode I show a sample answer that exercises the interface.` },
  ];
  if (webSearch) blocks.push({ kind: "search", text: "", query: prompt.slice(0, 60) || "Claude API prompt caching" });

  if (/\b(code|python|function|bug|script|sql)\b/.test(p)) {
    blocks.push({
      kind: "text",
      text: [
        "Here's a small, tidy example of the kind of code review you'd get:",
        "",
        "```python",
        "def average(values: list[float]) -> float:",
        '    """Return the mean, or 0.0 for an empty list."""',
        "    if not values:",
        "        return 0.0",
        "    return sum(values) / len(values)",
        "```",
        "",
        "**What changed**",
        "",
        "1. Added type hints so editors can catch mistakes.",
        "2. Handled the empty list, which used to raise `ZeroDivisionError`.",
        "3. Added a docstring that says what the function returns.",
        "",
        NOTE,
      ].join("\n"),
    });
  } else if (/\b(compare|table|price|cost|cheap)\b/.test(p)) {
    blocks.push({
      kind: "text",
      text: [
        "Here's how the models in this app compare:",
        "",
        "| Model | Best for | Price per million input / output tokens |",
        "|---|---|---|",
        "| Opus 5.5 | Hard questions, coding, analysis | $4 / $20 |",
        "| Sonnet 5.5 | Fast everyday work | $2 / $10 |",
        "| Haiku 5.5 | Quick, simple tasks | $0.10 / $0.50 |",
        "| Fable 5.1 | The hardest problems | $10 / $50 |",
        "",
        "Follow-up messages in a chat are cheaper because earlier messages come from the prompt cache.",
        "",
        NOTE,
      ].join("\n"),
    });
  } else {
    blocks.push({
      kind: "text",
      text: [
        "## Welcome to the demo",
        "",
        "You're trying **API B Claude** without an API key. Everything works the way it will for real:",
        "",
        "- **Chats are saved** in the sidebar while you try things (demo chats aren't kept after you leave).",
        "- **Thinking** appears in the collapsible box above this reply.",
        "- **Usage** under each reply shows tokens and an example cost.",
        "- Try **Settings**, **Usage**, the model and effort pickers, attaching an image, or the globe button for web search.",
        "",
        "Ask for *code* or a *comparison table* to see code blocks and tables.",
        "",
        "When you're ready to talk to the real Claude, connect an API key in **Settings → API key**.",
        "",
        NOTE,
      ].join("\n"),
    });
  }
  return blocks;
}

type DemoEvent = Record<string, unknown> & { type: string };

function buildEvents(model: string, prompt: string, webSearch: boolean, priorTurns: number): DemoEvent[] {
  const blocks = pickReply(prompt, webSearch);
  const inputTokens = 900 + prompt.length / 4;
  const cached = priorTurns > 0 ? Math.round(600 + priorTurns * 350) : 0;
  const events: DemoEvent[] = [
    {
      type: "message_start",
      message: {
        id: `msg_demo_${Math.random().toString(36).slice(2)}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: Math.round(inputTokens),
          output_tokens: 1,
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: priorTurns === 0 ? 700 : 300,
        },
      },
    },
  ];
  let index = 0;
  let outputChars = 0;
  for (const block of blocks) {
    if (block.kind === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const piece of block.text.match(/[\s\S]{1,24}/g) ?? []) {
        events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: piece } });
      }
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "demo" } });
      events.push({ type: "content_block_stop", index });
      outputChars += block.text.length;
      index++;
    } else if (block.kind === "search") {
      const id = `srvtoolu_demo_${index}`;
      events.push({ type: "content_block_start", index, content_block: { type: "server_tool_use", id, name: "web_search", input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: block.query }) } });
      events.push({ type: "content_block_stop", index });
      index++;
      events.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: id,
          content: [
            { type: "web_search_result", url: "https://docs.claude.com/en/docs/build-with-claude/prompt-caching", title: "Prompt caching (sample result)", encrypted_content: "demo", page_age: null },
            { type: "web_search_result", url: "https://www.anthropic.com/pricing", title: "Pricing (sample result)", encrypted_content: "demo", page_age: null },
          ],
        },
      });
      events.push({ type: "content_block_stop", index });
      index++;
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: null },
      });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: "Demo search results are samples, like this one" } });
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "citations_delta",
          citation: {
            type: "web_search_result_location",
            url: "https://docs.claude.com/en/docs/build-with-claude/prompt-caching",
            title: "Prompt caching (sample result)",
            cited_text: "Prompt caching",
            encrypted_index: "demo",
          },
        },
      });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: ".\n\n" } });
      events.push({ type: "content_block_stop", index });
      index++;
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } });
      for (const piece of block.text.match(/[\s\S]{1,18}/g) ?? []) {
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
      }
      events.push({ type: "content_block_stop", index });
      outputChars += block.text.length;
      index++;
    }
  }
  events.push({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: {
      output_tokens: Math.round(outputChars / 4),
      ...(webSearch ? { server_tool_use: { web_search_requests: 1 } } : {}),
    },
  });
  events.push({ type: "message_stop" });
  return events;
}

function lastUserText(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    for (const b of m.content as { type: string; text?: string }[]) if (b.type === "text" && b.text) return b.text;
  }
  return "";
}

function abortError(): DOMException {
  return new DOMException("The user aborted a request.", "AbortError");
}

/** A drop-in `fetch` for the SDK that serves demo replies instead of calling the network. */
export const demoFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = {
    "request-id": "req_demo",
    "anthropic-ratelimit-requests-limit": "50",
    "anthropic-ratelimit-requests-remaining": "49",
    "anthropic-ratelimit-input-tokens-limit": "2000000",
    "anthropic-ratelimit-input-tokens-remaining": "1998000",
    "anthropic-ratelimit-output-tokens-limit": "400000",
    "anthropic-ratelimit-output-tokens-remaining": "399000",
  };
  if (url.includes("/v1/models")) {
    return new Response(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }), {
      status: 200,
      headers: { ...headers, "content-type": "application/json" },
    });
  }
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    model?: string;
    messages?: { role: string; content: unknown }[];
    tools?: unknown[];
  };
  const messages = body.messages ?? [];
  const priorTurns = messages.filter((m) => m.role === "assistant").length;
  const events = buildEvents(body.model ?? "claude-opus-5-5", lastUserText(messages), Boolean(body.tools?.length), priorTurns);
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) throw abortError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0;
      const onAbort = () => {
        clearTimeout(timer);
        try {
          controller.error(abortError());
        } catch {
          /* already closed */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const tick = () => {
        if (i >= events.length) {
          signal?.removeEventListener("abort", onAbort);
          controller.close();
          return;
        }
        const e = events[i++];
        controller.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        const pause = e.type === "content_block_delta" ? 22 : e.type === "content_block_start" ? 180 : 40;
        timer = setTimeout(tick, pause);
      };
      timer = setTimeout(tick, 450);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
  return new Response(stream, { status: 200, headers: { ...headers, "content-type": "text/event-stream" } });
};
