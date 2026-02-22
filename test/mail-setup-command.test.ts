import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as setupCommands from "../src/commands/setup.cjs";

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
});
