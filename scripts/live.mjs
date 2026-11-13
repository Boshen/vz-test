import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
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
    const artifacts = build.manifest.artifacts;
    assert.ok(artifacts.some((artifact) => artifact.kind === "output"));
    const map = artifacts.find((artifact) => artifact.kind === "sourcemap");
    assert.ok(map, "Generated source maps must be uploaded");
    async function compressed(id) {
      const response = await request(`/builds/${build.id}/artifacts/${id}`);
      return gunzipSync(Buffer.from(await response.arrayBuffer()));
    }
    assert.ok(JSON.parse((await compressed(map.id)).toString()).sources.length > 0);
    const snapshot = JSON.parse((await compressed("vite-output-0")).toString());
    assert.equal(snapshot.environment, "client");
    assert.ok(snapshot.modules.length > 0 && snapshot.chunks.length > 0);
    assert.ok(snapshot.chunks.some((chunk) => chunk.details.rendering.length > 0));
    assert.equal(snapshot.config.build.sourcemap, true);
    const context = JSON.parse((await compressed("build-context")).toString());
    assert.ok(context.memory.rss > 0);
    if (app === "site") {
      const binary = artifacts.find(
        (artifact) => artifact.kind === "output" && artifact.name.endsWith(".bin"),
      );
      assert.ok(binary, "Binary output must be uploaded");
      assert.deepEqual([...(await compressed(binary.id))], [0, 255, 1, 2, 127, 128]);
    }
    const source = build.manifest.artifacts.find((artifact) => artifact.kind === "source");
    assert.ok(source);
    const preview = await request(`/builds/${id}/artifacts/${source.id}`, {
      headers: { Range: "bytes=0-1023" },
    });
    assert.equal(preview.status, 206);
    assert.match(preview.headers.get("Content-Disposition"), /attachment/);
    assert.equal(preview.headers.get("Cache-Control"), "no-store");
    const totals = await (
      await request(
        `/projects/${build.projectId}/trends?dataset=build&branch=main&environment=client`,
      )
    ).json();
    const point = totals.points.find((point) => point.id === id);
    assert.ok(point?.indexed, "Completed uploads must be indexed immediately");
    assert.equal(point.values.outputBytes, build.manifest.summary.outputBytes);
    assert.equal(totals.branch, "refs/heads/main");
    for (const dataset of [
      "modules",
      "chunks",
      "assets",
      "packages",
      "plugins",
      "events",
      "artifacts",
      "runtime",
    ]) {
      const series = await (
        await request(
          `/projects/${build.projectId}/trends?dataset=${dataset}&branch=main&environment=client`,
        )
      ).json();
      const current = series.points.find((point) => point.id === id);
      assert.ok(current?.values, `Missing ${dataset} trend point`);
      if (dataset === "runtime") assert.ok(current.values.rss > 0);
      else assert.ok(current.values.records > 0);
      if (dataset === "artifacts") assert.equal(current.values.records, artifacts.length);
    }
    const modulesSeries = await (
      await request(
        `/projects/${build.projectId}/trends?dataset=modules&branch=main&environment=client`,
      )
    ).json();
    assert.ok(modulesSeries.entities.length > 0);
    const entitySeries = await (
      await request(
        `/projects/${build.projectId}/trends?dataset=modules&entity=${modulesSeries.entities[0].id}`,
      )
    ).json();
    assert.ok(entitySeries.points.some((point) => point.id === id && point.values?.records > 0));
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
