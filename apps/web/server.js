import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "dist");
const port = Number(process.env.PORT ?? 3000);
const fallback = join(root, "index.html");
const apiOrigin = normalizeOrigin(process.env.PROOFFLOW_API_ORIGIN ?? process.env.RAILWAY_SERVICE__PROOFFLOW_API_URL ?? "http://localhost:8787");

function normalizeOrigin(value) {
  if (!value) return "http://localhost:8787";
  return value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
}

function contentType(pathname) {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

export default {
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "proofflow-web" });
    if (url.pathname.startsWith("/api-proxy/")) {
      const upstream = await fetch(`${apiOrigin}${url.pathname.replace(/^\/api-proxy/, "\/api")}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        duplex: "half",
      });
      const headers = new Headers(upstream.headers);
      headers.delete("content-length");
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const candidate = relative && !relative.includes("..") ? join(root, relative) : fallback;
    const path = existsSync(candidate) ? candidate : fallback;
    return new Response(Bun.file(path), { headers: { "content-type": contentType(path), "cache-control": path === fallback ? "no-cache" : "public, max-age=31536000, immutable" } });
  },
};
