import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as setupCommands from "../src/commands/setup.cjs";
// @ts-expect-error CommonJS module without type definitions
import * as temporary from "../src/temporary.cjs";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mail setup command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects the mail.setup command", () => {
    expect(setupCommands.isMailSetupCommand("mail.setup")).toBe(true);
    expect(setupCommands.isMailSetupCommand("mail.check")).toBe(false);
    expect(setupCommands.isMailSetupCommand("mail.temp")).toBe(true);
  });

  it("parses temporary mailbox TTLs with a five-minute minimum and one-day maximum", () => {
    expect(temporary.parseTemporaryTtl()).toBe(3600);
    expect(temporary.parseTemporaryTtl("15m")).toBe(900);
    expect(temporary.parseTemporaryTtl("1h")).toBe(3600);
    expect(() => temporary.parseTemporaryTtl("4m")).toThrow();
    expect(() => temporary.parseTemporaryTtl("25h")).toThrow();
  });

  it("creates and persists a temporary mailbox profile with expiry", async () => {
    const log = vi.fn();
    const saveMailConfig = vi.fn();
    const saveMailProfile = vi.fn();
    setupCommands.runMailSetupCommand({
      command: "mail.temp",
      args: ["--name", "my-agent", "--ttl", "15m"],
      parseMailFlags: () => ({ flags: { name: "my-agent", ttl: "15m" } }),
      getMailBaseUrl: () => "https://api.lenscli.com",
      mailRequest: vi.fn().mockResolvedValue({
        status: 201,
        data: { data: { address: "my-agent-a1b2c3d4@lenscli.com", apiKey: "key", mailboxId: "mbx-1", mailboxType: "temporary", expiresAt: "2026-11-23T13:15:00.000Z" } },
      }),
      saveMailConfig,
      saveMailProfile,
      mailConfigPath: "/tmp/mail.json",
      mailProfilesDir: "/tmp/mail-profiles",
      consoleRef: { log, error: vi.fn() },
      processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(saveMailConfig).toHaveBeenCalledWith(expect.objectContaining({ mailboxType: "temporary", expiresAt: "2026-11-23T13:15:00.000Z" }), expect.anything());
    expect(saveMailProfile).toHaveBeenCalledWith("my-agent-a1b2c3d4", expect.objectContaining({ apiKey: "key" }), expect.anything());
    expect(log).toHaveBeenCalledWith(expect.stringContaining("my-agent-a1b2c3d4@lenscli.com"));
  });

  it("preserves validation failure when interactive setup gets no name", async () => {
    const error = vi.fn();

    await expect(
      setupCommands.executeMailSetupCommand({
        command: "mail.setup",
        args: [],
        parseMailFlags: () => ({ flags: {} }),
        prompt: vi.fn().mockResolvedValue(""),
        consoleRef: { log: vi.fn(), error },
        processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
      }),
    ).rejects.toMatchObject({ code: 5 });

    expect(error).toHaveBeenCalledWith("Error: Name is required");
  });

  it("does not force a success exit for wrapped non-interactive setup", async () => {
    const exit = vi.fn();
    const log = vi.fn();
    const saveMailConfig = vi.fn();
    const saveMailProfile = vi.fn();

    setupCommands.runMailSetupCommand({
      command: "mail.setup",
      args: ["--name", "godel"],
      parseMailFlags: () => ({ flags: { name: "godel" } }),
      getMailBaseUrl: () => "https://lenscli.com",
      mailRequest: vi.fn().mockResolvedValue({
        status: 201,
        data: { address: "godel@lenscli.com", apiKey: "key", mailboxId: "mbx-1" },
      }),
      saveMailConfig,
      saveMailProfile,
      mailConfigPath: "/tmp/mail.json",
      mailProfilesDir: "/tmp/mail-profiles",
      consoleRef: { log, error: vi.fn() },
      processRef: { exit, stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(saveMailConfig).toHaveBeenCalled();
    expect(saveMailProfile).toHaveBeenCalledWith(
      "godel",
      expect.objectContaining({ address: "godel@lenscli.com", apiKey: "key" }),
      expect.anything(),
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        { address: "godel@lenscli.com", mailboxId: "mbx-1", configPath: "/tmp/mail.json" },
        null,
        2,
      ),
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not fabricate a hosted address in the self-hosted confirmation prompt", async () => {
    const prompts = [];
    let promptCount = 0;
    const prompt = vi.fn(async (question) => {
      prompts.push(question);
      promptCount += 1;
      return promptCount === 1 ? "self-hosted-agent" : "yes";
    });

    await setupCommands.executeMailSetupCommand({
      command: "mail.setup",
      args: [],
      parseMailFlags: () => ({ flags: {} }),
      prompt,
      getMailBaseUrl: () => "https://mail.example.test",
      mailRequest: vi.fn().mockResolvedValue({
        status: 201,
        data: { address: "self-hosted-agent@example.test", apiKey: "key", mailboxId: "mbx-1" },
      }),
      saveMailConfig: vi.fn(),
      saveMailProfile: vi.fn(),
      consoleRef: { log: vi.fn(), error: vi.fn() },
      processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
    });

    expect(prompts[1]).toBe('Provision mailbox "self-hosted-agent"? (y/N): ');
  });

  it("forwards and persists the optional display name without changing the address", async () => {
    const mailRequest = vi.fn().mockResolvedValue({
      status: 201,
      data: { address: "checkout-agent@lenscli.com", apiKey: "key", mailboxId: "mbx-1", displayName: "Checkout Agent" },
    });
    const saveMailConfig = vi.fn();
    const saveMailProfile = vi.fn();

    setupCommands.runMailSetupCommand({
      command: "mail.setup",
      args: ["--name", "checkout-agent", "--display", "Checkout Agent"],
      parseMailFlags: () => ({ flags: { name: "checkout-agent", display: "Checkout Agent" } }),
      getMailBaseUrl: () => "https://api.lenscli.com",
      mailRequest,
      saveMailConfig,
      saveMailProfile,
      mailConfigPath: "/tmp/mail.json",
      mailProfilesDir: "/tmp/mail-profiles",
      consoleRef: { log: vi.fn(), error: vi.fn() },
      processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(mailRequest).toHaveBeenCalledWith("POST", "/api/v1/mail/provision", {
      name: "checkout-agent",
      displayName: "Checkout Agent",
    });
    expect(saveMailConfig).toHaveBeenCalledWith(
      expect.objectContaining({ address: "checkout-agent@lenscli.com", displayName: "Checkout Agent" }),
      expect.anything(),
    );
  });

  it("rejects display names for temporary mailboxes", async () => {
    const error = vi.fn();
    await expect(setupCommands.executeMailSetupCommand({
      command: "mail.temp",
      args: ["--display", "Checkout Agent"],
      parseMailFlags: () => ({ flags: { display: "Checkout Agent" } }),
      consoleRef: { log: vi.fn(), error },
      processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
    })).rejects.toMatchObject({ code: 5 });
    expect(error).toHaveBeenCalledWith("Error: Display names are not supported for temporary mailboxes");
  });
});
