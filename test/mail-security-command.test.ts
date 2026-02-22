import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as securityCommands from "../src/commands/security.cjs";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mail security command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects mail security commands", () => {
    expect(securityCommands.isMailSecurityCommand("mail.verify")).toBe(true);
    expect(securityCommands.isMailSecurityCommand("mail.block")).toBe(true);
    expect(securityCommands.isMailSecurityCommand("mail.unblock")).toBe(true);
    expect(securityCommands.isMailSecurityCommand("mail.blocked")).toBe(true);
    expect(securityCommands.isMailSecurityCommand("mail.quarantine")).toBe(true);
    expect(securityCommands.isMailSecurityCommand("mail.release")).toBe(true);
    expect(securityCommands.isMailSecurityCommand("mail.draft")).toBe(false);
  });

  it("preserves mail.release usage failure when message id is missing", async () => {
    const error = vi.fn();

    await expect(
      securityCommands.executeMailSecurityCommand({
        command: "mail.release",
        args: [],
        parseMailFlags: () => ({ flags: {}, positional: [] }),
        resolveMailIdentity: () => ({ apiKey: "key" }),
        checkMailPermissions: vi.fn(),
        consoleRef: { log: vi.fn(), error },
        processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
      }),
    ).rejects.toMatchObject({ code: 5 });

    expect(error).toHaveBeenCalledWith("Usage: lens mail.release <message-id>");
  });

  it("preserves auth exit semantics for wrapped mail.blocked", async () => {
    const exit = vi.fn();
    const error = vi.fn();

    securityCommands.runMailSecurityCommand({
      command: "mail.blocked",
      args: [],
      parseMailFlags: () => ({ flags: {}, positional: [] }),
      resolveMailIdentity: () => ({ apiKey: "key" }),
      checkMailPermissions: vi.fn(),
      mailRequest: vi.fn().mockResolvedValue({ status: 401, data: { error: "bad key" } }),
      handleMailError: ({ data }: { data: { error: string } }) => {
        throw new securityCommands.MailSecurityExit(2, `Auth error: ${data.error}`);
      },
      consoleRef: { log: vi.fn(), error },
      processRef: { exit, stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(error).toHaveBeenCalledWith("Auth error: bad key");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("does not force a success exit for wrapped mail.blocked", async () => {
    const exit = vi.fn();
    const write = vi.fn();

    securityCommands.runMailSecurityCommand({
      command: "mail.blocked",
      args: [],
      parseMailFlags: () => ({ flags: {}, positional: [] }),
      resolveMailIdentity: () => ({ apiKey: "key" }),
      checkMailPermissions: vi.fn(),
      mailRequest: vi.fn().mockResolvedValue({
        status: 200,
        data: { data: { blocked: [{ sender: "spam@example.com", blocked_by: "owner" }] } },
      }),
      handleMailError: vi.fn(),
      consoleRef: { log: vi.fn(), error: vi.fn() },
      processRef: { exit, stderr: { write } },
    });

    await flushMicrotasks();
    expect(write).toHaveBeenCalledWith("Blocked senders (1):\n\n");
    expect(exit).not.toHaveBeenCalled();
  });
});
