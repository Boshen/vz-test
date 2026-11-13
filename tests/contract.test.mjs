import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile, stat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { createBuilder, createLogger } from "vite-plus";
import vz from "../.vz-source/packages/vite-plugin-vz/dist/index.mjs";

async function exercise({
  app = "site",
  enabled,
  strict = true,
  ci = true,
  missingOidc = false,
  failureStatus = 0,
  failures = 0,
} = {}) {
  const originalFetch = globalThis.fetch,
    originalWarn = console.warn;
  const names = [
    "GITHUB_ACTIONS",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.GITHUB_ACTIONS = String(ci);
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
    "https://pipelines.actions.githubusercontent.com/token";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "test-request-token";
  if (missingOidc) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const state = {
    manifests: [],
    completed: 0,
    attempts: 0,
    requestCount: 0,
    warnings: [],
    payloads: new Map(),
    attemptIds: [],
  };
  console.warn = (...args) => state.warnings.push(args.join(" "));
  const logger = createLogger("silent");
  logger.warn = (message) => state.warnings.push(message);
  const parts = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    state.requestCount++;
    if (url.startsWith("https://pipelines.actions.githubusercontent.com/")) {
      assert.equal(new URL(url).searchParams.get("audience"), "https://capture.invalid");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-request-token");
      return Response.json({ value: "test-oidc" });
    }
    assert.ok(
      url.startsWith("https://capture.invalid/api/v1/uploads"),
      "No real network access is permitted in contract tests",
    );
    if (url === "https://capture.invalid/api/v1/uploads") {
      state.attempts++;
      const manifest = JSON.parse(init.body);
      state.attemptIds.push(manifest.captureId);
      if (failureStatus || state.attempts <= failures)
        return Response.json({ error: "fixture rejection" }, { status: failureStatus || 503 });
      state.manifests.push(manifest);
      return Response.json({
        id: "capture",
        token: "test-upload",
        reportUrl: "https://capture.invalid/reports/capture",
      });
    }
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-upload");
    const match = url.match(/\/artifacts\/([^/]+)\/parts\/(\d+)$/);
    if (match) {
      const entry = parts.get(match[1]) ?? new Map();
      entry.set(Number(match[2]), Buffer.from(init.body));
      parts.set(match[1], entry);
      return Response.json({ ok: true });
    }
    const complete = url.match(/\/artifacts\/([^/]+)\/complete$/);
    if (complete) {
      const descriptor = state.manifests[0].artifacts.find(
        (artifact) => artifact.id === complete[1],
      );
      const body = Buffer.concat(
        [...parts.get(complete[1])].sort(([a], [b]) => a - b).map(([, value]) => value),
      );
      assert.equal(body.length, descriptor.bytes);
      assert.equal(createHash("sha256").update(body).digest("hex"), descriptor.sha256);
      state.payloads.set(complete[1], body);
      return Response.json({ ok: true });
    }
    assert.ok(url.endsWith("/capture/complete"));
    assert.equal(state.payloads.size, state.manifests[0].artifacts.length);
    state.completed++;
    return Response.json({ ok: true });
  };
  try {
    const root = resolve("apps", app),
      outDir = resolve(".artifacts/contracts", app);
    await rm(outDir, { recursive: true, force: true });
    const builder = await createBuilder(
      {
        configFile: false,
        root,
        customLogger: logger,
        plugins: [vz({ endpoint: "https://capture.invalid", project: app, enabled, strict })],
        build: {
          sourcemap: true,
          assetsInlineLimit: 0,
          outDir,
          emptyOutDir: true,
          ...(app === "library"
            ? { lib: { entry: resolve(root, "index.ts"), formats: ["es"] } }
            : {}),
        },
      },
      true,
    );
    await builder.buildApp();
    assert.ok((await stat(outDir)).isDirectory(), "The application build must exist");
    return state;
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    for (const name of names)
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
  }
}
for (const app of ["site", "library"]) {
  void test(`${app}: complete compiled-plugin capture with graph, source, and timing datasets`, async () => {
    const result = await exercise({ app });
    assert.equal(result.completed, 1);
    assert.equal(result.manifests.length, 1);
    const manifest = result.manifests[0];
    assert.equal(manifest.project, app);
    assert.equal(manifest.version, 1);
    assert.match(manifest.checkoutSha, /^[a-f0-9]{40}$/);
    assert.ok(manifest.summary.modules > 0);
    assert.ok(manifest.summary.packages > 0);
    for (const name of ["modules", "chunks", "assets", "packages", "plugins", "events"]) {
      const descriptor = manifest.artifacts.find((artifact) => artifact.dataset === name);
      assert.ok(descriptor, `${name} must be available`);
      assert.ok(
        JSON.parse(
          descriptor.contentType === "application/gzip"
            ? gunzipSync(result.payloads.get(descriptor.id)).toString()
            : result.payloads.get(descriptor.id),
        ).length > 0,
      );
    }
    const raw = manifest.artifacts.find((artifact) => artifact.kind === "raw");
    const events = gunzipSync(result.payloads.get(raw.id))
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.action === "ModuleGraphReady"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.kind === "source"));
    assert.ok(
      manifest.artifacts
        .filter((artifact) => artifact.kind === "dataset")
        .every((artifact) => artifact.bytes <= 512 * 1024),
    );
  });
}
void test("local builds perform no capture or requests", async () => {
  assert.equal((await exercise({ ci: false })).requestCount, 0);
});
void test("explicit condition disables CI capture", async () => {
  assert.equal((await exercise({ enabled: false })).requestCount, 0);
});
void test("missing OIDC warns without breaking a non-strict build", async () => {
  const result = await exercise({ missingOidc: true, strict: false });
  assert.equal(result.requestCount, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("id-token")));
});
void test("missing OIDC fails strict builds", async () => {
  await assert.rejects(exercise({ missingOidc: true }), /id-token/);
});
void test("upload rejection warns without breaking default builds", async () => {
  const result = await exercise({ failureStatus: 400, strict: false });
  assert.equal(result.completed, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("HTTP 400")));
});
void test("upload rejection fails strict builds", async () => {
  await assert.rejects(exercise({ failureStatus: 400 }), /HTTP 400/);
});
void test("transient retries keep one capture identity and finish the upload", async () => {
  const result = await exercise({ failures: 2 });
  assert.equal(result.attempts, 3);
  assert.equal(new Set(result.attemptIds).size, 1);
  assert.equal(result.completed, 1);
});
void test("two fixture apps have distinct source entry points", async () => {
  assert.notEqual(
    await readFile("apps/site/main.ts", "utf8"),
    await readFile("apps/library/index.ts", "utf8"),
  );
});
