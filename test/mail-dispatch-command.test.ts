import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as mailDispatch from "../src/dispatch.cjs";

describe("mail dispatch command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects mail commands, with or without the old prefix", () => {
    expect(mailDispatch.isMailCommand("mail.help")).toBe(true);
    expect(mailDispatch.isMailCommand("whoami")).toBe(true);
    expect(mailDispatch.isMailCommand("mail.tags")).toBe(true);
    expect(mailDispatch.isMailCommand("open")).toBe(false);
  });

  it("leaves rooms and wires to lens-room", () => {
    expect(mailDispatch.isMailCommand("mail.room.open")).toBe(false);
    expect(mailDispatch.isMailCommand("mail.wire.open")).toBe(false);
    expect(mailDispatch.isMailCommand("room.open")).toBe(false);
    expect(mailDispatch.isMailCommand("wire.open")).toBe(false);
  });

  it("prints help and exits zero for short-help requests", () => {
    const exit = vi.fn();
    const write = vi.fn();

    mailDispatch.runMailCommand({
      command: "mail.setup",
      args: ["-h"],
      processRef: { exit, stderr: { write } },
      consoleRef: { error: vi.fn() },
    });

    expect(write).toHaveBeenCalledWith(expect.stringContaining("lens-mail"));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("delegates to the correct family runner", () => {
    const runMailManagementCommand = vi.fn();

    mailDispatch.runMailCommand({
      command: "mail.tags",
      args: ["--pretty"],
      isMailSetupCommand: () => false,
      isMailboxMailCommand: () => false,
      isMailManagementCommand: (command: string) => command === "mail.tags",
      isMailSecurityCommand: () => false,
      isMailDaemonCommand: () => false,
      runMailManagementCommand,
      processRef: { exit: vi.fn(), stderr: { write: vi.fn() } },
      consoleRef: { error: vi.fn() },
    });

    expect(runMailManagementCommand).toHaveBeenCalledWith({ command: "mail.tags", args: ["--pretty"] });
  });
});
