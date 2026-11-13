import { resolve } from "node:path";
import { defineConfig } from "vite-plus";
import vz from "./.vz-source/packages/vite-plugin-vz/dist/index.mjs";

const app = process.env.VZ_APP === "library" ? "library" : "site";
const endpoint = process.env.VZ_ENDPOINT;
export default defineConfig({
  root: resolve("apps", app),
  plugins: [
    vz({
      endpoint: endpoint ?? "https://unconfigured.invalid",
      project: app,
      enabled: Boolean(endpoint) && process.env.VZ_UPLOAD !== "false",
      strict: true,
    }),
  ],
  build: {
    outDir: resolve("dist", app),
    emptyOutDir: true,
    ...(app === "library"
      ? { lib: { entry: resolve("apps/library/index.ts"), formats: ["es" as const] } }
      : {}),
  },
  lint: { options: { typeAware: true, typeCheck: true } },
});
