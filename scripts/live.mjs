import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Live uploads only run in GitHub Actions");
const endpoint = new URL(process.env.VZ_ENDPOINT ?? "");
assert.equal(endpoint.protocol, "https:");
assert.notEqual(
  endpoint.hostname,
  "api.void.cloud",
  "Use the deployed VZ application URL, not Void's deployment API",
);
async function request(path, options) {
  const response = await fetch(new URL(`/api/v1${path}`, endpoint), options);
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response;
}
const links = [];
for (const app of ["site", "library"]) {
  const ids = [];
  for (let iteration = 0; iteration < 2; iteration++) {
    const output = execFileSync("vp", ["build"], {
      encoding: "utf8",
      env: { ...process.env, VZ_APP: app, VZ_UPLOAD: "true", NO_COLOR: "1" },
      maxBuffer: 4 * 1024 ** 2,
    });
    process.stdout.write(output);
    // eslint-disable-next-line no-control-regex
    const link = output.match(/report:\s+(https:\/\/[^\s\x1b]+)/)?.[1];
    assert.ok(link, "Plugin must print a completed report URL");
    const url = new URL(link);
    assert.equal(url.origin, endpoint.origin);
    const id = url.pathname.split("/").at(-1);
    ids.push(id);
    links.push(link);
    const build = await (await request(`/builds/${id}`)).json();
    assert.equal(build.project, app);
    assert.equal(build.provenance.repository, "Boshen/vz-test");
    assert.equal(build.provenance.sha, process.env.GITHUB_SHA);
    assert.ok(build.manifest.summary.modules > 0);
    for (const dataset of ["modules", "chunks", "assets", "packages", "plugins", "events"]) {
      const data = await (await request(`/builds/${id}/datasets/${dataset}`)).json();
      assert.ok(data.pages > 0 && data.rows.length > 0, `Missing ${dataset}`);
    }
    const source = build.manifest.artifacts.find((artifact) => artifact.kind === "source");
    assert.ok(source);
    const preview = await request(`/builds/${id}/artifacts/${source.id}`, {
      headers: { Range: "bytes=0-1023" },
    });
    assert.equal(preview.status, 206);
    assert.match(preview.headers.get("Content-Disposition"), /attachment/);
    assert.equal(preview.headers.get("Cache-Control"), "no-store");
    const deletion = await fetch(new URL(`/api/v1/builds/${id}`, endpoint), { method: "DELETE" });
    assert.equal(deletion.status, 403, "Anonymous deletion must be rejected");
  }
  const compared = await (await request(`/builds/${ids[1]}/compare?before=${ids[0]}`)).json();
  assert.equal(compared.before, ids[0]);
  assert.equal(typeof compared.metrics.modules.delta, "number");
}
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## VZ live reports\n${links.map((link) => `- ${link}`).join("\n")}\n`,
  );
console.log(`Verified ${links.length} public reports across two app projects.`);
