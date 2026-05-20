import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/db",
      "packages/adapters/opencode-local",
      "packages/plugins/examples/plugin-pacc",
      "server",
      "ui",
      "cli",
    ],
  },
});
