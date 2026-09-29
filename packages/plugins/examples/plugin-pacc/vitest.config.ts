import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Existing brief/steward tests exercise the vault writer; production
    // defaults to vault-input-only (PACC_VAULT_WRITES unset).
    env: { PACC_VAULT_WRITES: "on" },
  },
});
