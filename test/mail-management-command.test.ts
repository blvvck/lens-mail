import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as managementCommands from "../src/commands/management.cjs";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mail management command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects non-mailbox management commands", () => {
    expect(managementCommands.isMailManagementCommand("mail.save")).toBe(true);
    expect(managementCommands.isMailManagementCommand("mail.tag")).toBe(true);
    expect(managementCommands.isMailManagementCommand("mail.untag")).toBe(true);
    expect(managementCommands.isMailManagementCommand("mail.tags")).toBe(true);
    expect(managementCommands.isMailManagementCommand("mail.filter.add")).toBe(true);
    expect(managementCommands.isMailManagementCommand("mail.filter.list")).toBe(true);
    expect(managementCommands.isMailManagementCommand("mail.filter.remove")).toBe(true);
    expect(managementCommands.isMailManagementCommand("mail.draft")).toBe(true);
    expect(managementCommands.isMailManagementCommand("mail.thread")).toBe(true);
    expect(managementCommands.isMailManagementCommand("mail.check")).toBe(false);
  });

  it("preserves mail.save usage failure when message id is missing", async () => {
    const error = vi.fn();

    await expect(
      managementCommands.executeMailManagementCommand({
        command: "mail.save",
        args: [],
        parseMailFlags: () => ({ flags: {}, positional: [] }),
        resolveMailIdentity: () => ({ apiKey: "key" }),
        checkMailPermissions: vi.fn(),
        consoleRef: { log: vi.fn(), error },
        processRef: { exit: vi.fn(), cwd: () => process.cwd(), stderr: { write: vi.fn() } },
      }),
    ).rejects.toMatchObject({ code: 5 });

    expect(error).toHaveBeenCalledWith("Usage: lens mail.save <message-id> [filename] [--out <dir>] [--all]");
  });

  it("preserves auth exit semantics for wrapped mail.tags", async () => {
    const exit = vi.fn();
    const error = vi.fn();

    managementCommands.runMailManagementCommand({
      command: "mail.tags",
      args: [],
      parseMailFlags: () => ({ flags: {}, positional: [] }),
      resolveMailIdentity: () => ({ apiKey: "key" }),
      checkMailPermissions: vi.fn(),
      mailRequest: vi.fn().mockResolvedValue({ status: 401, data: { error: "bad key" } }),
      handleMailError: ({ data }: { data: { error: string } }) => {
        throw new managementCommands.MailManagementExit(2, `Auth error: ${data.error}`);
      },
      consoleRef: { log: vi.fn(), error },
      processRef: { exit, cwd: () => process.cwd(), stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(error).toHaveBeenCalledWith("Auth error: bad key");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("does not force a success exit for wrapped mail.tags", async () => {
    const exit = vi.fn();
    const log = vi.fn();

    managementCommands.runMailManagementCommand({
      command: "mail.tags",
      args: [],
      parseMailFlags: () => ({ flags: {}, positional: [] }),
      resolveMailIdentity: () => ({ apiKey: "key" }),
      checkMailPermissions: vi.fn(),
      mailRequest: vi.fn().mockResolvedValue({
        status: 200,
        data: { data: { tags: [{ name: "receipts", count: 2 }] } },
      }),
      handleMailError: vi.fn(),
      consoleRef: { log, error: vi.fn() },
      processRef: { exit, cwd: () => process.cwd(), stderr: { write: vi.fn() } },
    });

    await flushMicrotasks();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ data: { tags: [{ name: "receipts", count: 2 }] } }, null, 2),
    );
    expect(exit).not.toHaveBeenCalled();
  });
});
