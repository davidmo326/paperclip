import { describe, expect, it } from "vitest";
import { pluginHostEnv } from "../services/plugin-host-env.js";

const env = {
  PACC_BRIEFER_MODEL: "on",
  PACC_STEWARD_AUTH: "api",
  ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
  ANTHROPIC_AUTH_TOKEN: "tok",
  ANTHROPIC_API_KEY: "key",
  HOME: "/home/x",
  DATABASE_URL: "postgres://secret",
  pacc_lower: "nope",
  UNDEF: undefined,
};

describe("pluginHostEnv", () => {
  it("passes PACC_* and the model-endpoint vars to the pacc plugin", () => {
    expect(pluginHostEnv("paperclip-pacc", env)).toEqual({
      PACC_BRIEFER_MODEL: "on",
      PACC_STEWARD_AUTH: "api",
      ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: "key",
    });
  });

  it("gives every other plugin nothing — the model token never leaks", () => {
    expect(pluginHostEnv("paperclip-founder-control-plane", env)).toEqual({});
    expect(pluginHostEnv("some-third-party-plugin", env)).toEqual({});
  });
});
