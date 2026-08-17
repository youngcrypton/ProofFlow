import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);

describe("production container startup", () => {
  it("uses the entrypoint as the root-to-bun privilege boundary", async () => {
    const [dockerfile, entrypoint, storage] = await Promise.all([
      readFile(new URL("Dockerfile.api", root), "utf8"),
      readFile(new URL("docker/api-entrypoint.sh", root), "utf8"),
      readFile(new URL("apps/api/src/runtime-storage.ts", root), "utf8")
    ]);

    expect(dockerfile).toContain("util-linux");
    expect(dockerfile).toContain('USER root');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/proofflow-api-entrypoint"]');
    expect(dockerfile).toContain('CMD ["bun", "run", "apps/api/src/server.ts"]');
    expect(dockerfile).toContain("sed -i 's/\\r$//' /usr/local/bin/proofflow-api-entrypoint");
    expect(entrypoint).toContain('mkdir -p /data/evidence/quarantine /data/evidence/clean');
    expect(entrypoint).toContain('chown -R bun:bun /data');
    expect(entrypoint).toContain('exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"');
    expect(storage).not.toMatch(/initgroups|setgid|setuid/);
    expect(storage).toContain("if (uid === 0)");
  });

  it("uses the minimal runtime image and preserves the Railway healthcheck", async () => {
    const [dockerfile, railway] = await Promise.all([
      readFile(new URL("Dockerfile.api", root), "utf8"),
      readFile(new URL("railway.toml", root), "utf8")
    ]);
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM oven/bun:1.2.15-debian"));

    expect(runtimeStage).toContain("nodejs");
    expect(runtimeStage).toContain("util-linux");
    expect(railway).toContain('healthcheckPath = "/health"');
    expect(railway.match(/^startCommand\s*=\s*""\s*$/gm)).toHaveLength(1);
    expect(railway.match(/^startCommand\s*=/gm)).toHaveLength(1);
  });
});
