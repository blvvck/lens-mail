import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as mailboxCommands from "../src/commands/mailbox.cjs";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mail mailbox command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects mailbox command family members", () => {
    expect(mailboxCommands.isMailboxMailCommand("mail.whoami")).toBe(true);
    expect(mailboxCommands.isMailboxMailCommand("mail.check")).toBe(true);
    expect(mailboxCommands.isMailboxMailCommand("mail.read")).toBe(true);
    expect(mailboxCommands.isMailboxMailCommand("mail.send")).toBe(true);
    expect(mailboxCommands.isMailboxMailCommand("mail.code")).toBe(true);
    expect(mailboxCommands.isMailboxMailCommand("mail.links")).toBe(true);
    expect(mailboxCommands.isMailboxMailCommand("mail.wait")).toBe(true);
    expect(mailboxCommands.isMailboxMailCommand("mail.search")).toBe(true);
    expect(mailboxCommands.isMailboxMailCommand("mail.room.open")).toBe(false);
  });

  it("prints env override messaging for mail.whoami", async () => {
    const log = vi.fn();

    await mailboxCommands.executeMailboxMailCommand({
      command: "mail.whoami",
      args: [],
      resolveMailIdentity: () => ({ source: "env" }),
      checkMailPermissions: vi.fn(),
      consoleRef: { log, error: vi.fn() },
      processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
    });

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "(using LENS_MAIL_KEY env var)",
      "Address: unknown (env override — key only)",
    ]);
  });

  it("prints a non-broken fallback when the configured identity has no address", async () => {
    const log = vi.fn();

    await mailboxCommands.executeMailboxMailCommand({
      command: "mail.whoami",
      args: [],
      resolveMailIdentity: () => ({ apiKey: "key", source: "default" }),
      checkMailPermissions: vi.fn(),
      consoleRef: { log, error: vi.fn() },
      processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
    });

    expect(log).toHaveBeenCalledWith("Address: unknown");
  });

  it("preserves mail.read usage failure when message id is missing", async () => {
    const error = vi.fn();

    await expect(
      mailboxCommands.executeMailboxMailCommand({
        command: "mail.read",
        args: [],
        resolveMailIdentity: () => ({ apiKey: "key" }),
        checkMailPermissions: vi.fn(),
        consoleRef: { log: vi.fn(), error },
        processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
      }),
    ).rejects.toMatchObject({ code: 5 });

    expect(error).toHaveBeenCalledWith("Usage: lens mail.read <message-id>");
  });

  it("exits two when wrapped mailbox commands have no configured identity", async () => {
    const exit = vi.fn();
    const error = vi.fn();

    mailboxCommands.runMailboxMailCommand({
      command: "mail.check",
      args: [],
      resolveMailIdentity: () => null,
      checkMailPermissions: vi.fn(),
      consoleRef: { log: vi.fn(), error },
      processRef: { exit, stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(error).toHaveBeenCalledWith("No mail identity configured.");
    expect(error).toHaveBeenCalledWith("Run: lens mail.setup --name <name>");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("preserves auth exit semantics for mail.check", async () => {
    const exit = vi.fn();
    const error = vi.fn();

    mailboxCommands.runMailboxMailCommand({
      command: "mail.check",
      args: [],
      resolveMailIdentity: () => ({ apiKey: "key" }),
      checkMailPermissions: vi.fn(),
      mailRequest: vi.fn().mockResolvedValue({ status: 401, data: { error: "bad key" } }),
      consoleRef: { log: vi.fn(), error },
      processRef: { exit, stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(error).toHaveBeenCalledWith("Auth error: bad key");
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("Network error:"));
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("preserves not-found exit semantics for mail.read", async () => {
    const exit = vi.fn();
    const error = vi.fn();

    mailboxCommands.runMailboxMailCommand({
      command: "mail.read",
      args: ["msg-123"],
      resolveMailIdentity: () => ({ apiKey: "key" }),
      checkMailPermissions: vi.fn(),
      mailRequest: vi.fn().mockResolvedValue({ status: 404, data: { error: "missing" } }),
      consoleRef: { log: vi.fn(), error },
      processRef: { exit, stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(error).toHaveBeenCalledWith("Not found: missing");
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("Network error:"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("preserves validation exit semantics for mail.send", async () => {
    const exit = vi.fn();
    const error = vi.fn();
    const write = vi.fn();

    mailboxCommands.runMailboxMailCommand({
      command: "mail.send",
      args: ["to@example.com", "subject", "body"],
      resolveMailIdentity: () => ({ apiKey: "key" }),
      checkMailPermissions: vi.fn(),
      mailRequest: vi.fn().mockResolvedValue({ status: 422, data: { error: "bad payload" } }),
      consoleRef: { log: vi.fn(), error },
      processRef: { exit, stderr: { write } },
    });

    await flushMicrotasks();
    expect(error).toHaveBeenCalledWith("Validation error: bad payload");
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("Network error:"));
    expect(exit).toHaveBeenCalledWith(5);
    expect(write).toHaveBeenCalledWith("Sending to to@example.com...");
    expect(write).toHaveBeenCalledWith(" failed\n");
  });

  it("does not force a success exit for wrapped mail.check", async () => {
    const exit = vi.fn();
    const log = vi.fn();

    mailboxCommands.runMailboxMailCommand({
      command: "mail.check",
      args: [],
      resolveMailIdentity: () => ({ apiKey: "key" }),
      checkMailPermissions: vi.fn(),
      mailRequest: vi.fn().mockResolvedValue({
        status: 200,
        data: { data: { count: 1, unread: 0, messages: [{ id: "msg-1" }] } },
      }),
      consoleRef: { log, error: vi.fn() },
      processRef: { exit, stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ data: { count: 1, unread: 0, messages: [{ id: "msg-1" }] } }, null, 2),
    );
    expect(exit).not.toHaveBeenCalled();
  });
});
