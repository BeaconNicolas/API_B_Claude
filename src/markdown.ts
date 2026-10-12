// Markdown rendering for model output. Everything goes through DOMPurify, and the page's
// Content-Security-Policy blocks remote images and scripts as a second line of defence.

import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, java, javascript, json, kotlin,
  markdown, php, python, r, ruby, rust, scala, shell, sql, swift, typescript, xml, yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);
hljs.registerAliases(["sh", "zsh", "console"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx", "mjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["tf", "hcl", "terraform"], { languageName: "ruby" });

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? "").trim().split(/\s+/)[0].toLowerCase();
      let highlighted: string;
      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      } else {
        highlighted = escapeHtml(text);
      }
      const label = language ? escapeHtml(language) : "text";
      return (
        // The copy button is added after sanitising (see enhanceCodeBlocks).
        `<div class="code-block"><div class="code-head"><span>${label}</span></div>` +
        `<pre><code class="hljs">${highlighted}</code></pre></div>`
      );
    },
  },
});

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["img", "style", "form", "input", "button", "textarea", "select", "iframe", "video", "audio", "source", "dialog"],
  FORBID_ATTR: ["style", "srcset", "id", "tabindex"],
};

// Model output may only use highlight.js classes and our code-block classes, so it
// can't borrow the app's own styles to draw fake UI (e.g. a fake "enter your key" box).
const ALLOWED_CLASS = /^(hljs(-[\w-]+)?|[a-z]+_|code-block|code-head|language-[\w-]+)$/;
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "class") {
    const kept = data.attrValue.split(/\s+/).filter((c) => ALLOWED_CLASS.test(c));
    if (kept.length) data.attrValue = kept.join(" ");
    else data.keepAttr = false;
  }
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href)) {
      node.removeAttribute("href");
    } else {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  }
});

/** Render untrusted Markdown to sanitised HTML. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
}

/** Add a copy button to every rendered code block that doesn't have one yet. */
export function enhanceCodeBlocks(root: HTMLElement): void {
  for (const head of root.querySelectorAll<HTMLElement>(".code-head")) {
    if (head.querySelector("button")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      const code = head.parentElement?.querySelector("code")?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      }
      setTimeout(() => (button.textContent = "Copy"), 1500);
    });
    head.appendChild(button);
  }
}

export { escapeHtml };
