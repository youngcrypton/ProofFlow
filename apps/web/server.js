import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "dist");
const port = Number(process.env.PORT ?? 3000);
const fallback = join(root, "index.html");

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
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const candidate = relative && !relative.includes("..") ? join(root, relative) : fallback;
    const path = existsSync(candidate) ? candidate : fallback;
    return new Response(Bun.file(path), { headers: { "content-type": contentType(path), "cache-control": path === fallback ? "no-cache" : "public, max-age=31536000, immutable" } });
  },
};
