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
    expect(dockerfile).toContain("clamav-daemon");
    expect(dockerfile).toContain('USER root');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/proofflow-api-entrypoint"]');
    expect(dockerfile).toContain('CMD ["bun", "run", "apps/api/src/server.ts"]');
    expect(dockerfile).toContain("sed -i 's/\\r$//' /usr/local/bin/proofflow-api-entrypoint");
    expect(entrypoint).toContain('mkdir -p /data/evidence/quarantine /data/evidence/clean');
    expect(entrypoint).toContain('chown -R bun:bun /data');
    expect(entrypoint).toContain('exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"');
    expect(entrypoint).toContain("LocalSocket /run/clamav/clamd.ctl");
    expect(entrypoint).toContain("MaxThreads 1");
    expect(entrypoint).toContain("clamdscan --config-file=/run/clamav/proofflow-clamd.conf --ping=1");
    expect(entrypoint).toContain("clamd exited before becoming ready");
    expect(entrypoint).toContain("clamd did not become ready within 60 seconds");
    expect(entrypoint).toContain("clamd readiness scan did not return clean");
    expect(storage).not.toMatch(/initgroups|setgid|setuid/);
    expect(storage).toContain("if (uid === 0)");
  });

  it("preserves the verified ClamAV build flow and Railway healthcheck", async () => {
    const [dockerfile, railway] = await Promise.all([
      readFile(new URL("Dockerfile.api", root), "utf8"),
      readFile(new URL("railway.toml", root), "utf8")
    ]);
    const definitionsStage = dockerfile.slice(
      dockerfile.indexOf("FROM oven/bun:1.2.15-debian AS clamav-definitions"),
      dockerfile.lastIndexOf("FROM oven/bun:1.2.15-debian")
    );
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM oven/bun:1.2.15-debian"));

    expect(definitionsStage).toContain("freshclam --config-file");
    expect(definitionsStage).toContain("freshclam attempt $attempt of 3");
    expect(definitionsStage).toContain("clamscan --no-summary --stdout");
    expect(dockerfile).toContain("COPY --from=clamav-definitions --chown=clamav:clamav");
    expect(runtimeStage).not.toContain("clamav-freshclam");
    expect(railway).toContain('healthcheckPath = "/health"');
    expect(railway.match(/^startCommand\s*=\s*""\s*$/gm)).toHaveLength(1);
    expect(railway.match(/^startCommand\s*=/gm)).toHaveLength(1);
  });
});
