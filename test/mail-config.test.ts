import { describe, expect, it } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as mailConfig from "../src/config.cjs";

describe("mail config module", () => {
  it("exports the shared mail paths and helpers", () => {
    expect(typeof mailConfig.DEFAULT_MAIL_API).toBe("string");
    expect(typeof mailConfig.MAIL_CONFIG_PATH).toBe("string");
    expect(typeof mailConfig.MAIL_PROFILES_DIR).toBe("string");
    expect(typeof mailConfig.parseMailFlags).toBe("function");
    expect(typeof mailConfig.resolveMailIdentity).toBe("function");
  });

  it("parses bool and value mail flags while preserving positional args", () => {
    expect(
      mailConfig.parseMailFlags([
        "--pretty",
        "--subject",
        "hello",
        "msg-123",
        "--full",
      ]),
    ).toEqual({
      flags: {
        pretty: true,
        subject: "hello",
        full: true,
      },
      positional: ["msg-123"],
    });
  });

  it("resolves mail identity from env before profile or default config", () => {
    expect(
      mailConfig.resolveMailIdentity(
        {},
        {
          env: { LENS_MAIL_KEY: "env-key" },
          getMailBaseUrl: () => "https://mail.example.test",
          loadMailProfile: () => ({ apiKey: "profile-key" }),
          loadMailConfig: () => ({ apiKey: "default-key" }),
          consoleRef: { error: () => {} },
          processRef: { exit: () => {} },
        },
      ),
    ).toEqual({
      apiKey: "env-key",
      address: "(env override)",
      baseUrl: "https://mail.example.test",
      source: "env",
    });
  });
});
