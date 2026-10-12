import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Adds a strict Content-Security-Policy to the built page. Scripts may only come from
// this site (plus the one small inline theme script, allowed by its hash), and the page
// may only talk to the Claude API, so injected content can't send your key anywhere else.
function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml(html) {
      const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
      );
      const policy = [
        "default-src 'none'",
        `script-src 'self' ${hashes.join(" ")}`.trim(),
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self' data: blob:",
        "connect-src https://api.anthropic.com",
        "manifest-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
      ].join("; ");
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}

// GitHub Pages serves the site from /<repo-name>/.
export default defineConfig({
  base: "/API_B_Claude/",
  plugins: [contentSecurityPolicy()],
  build: {
    target: "es2022",
    sourcemap: false,
    // Emit every asset as a file: the CSP doesn't allow data: fonts.
    assetsInlineLimit: 0,
  },
  test: {
    environment: "node",
  },
});
