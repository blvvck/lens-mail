import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as notify from "../src/notify.cjs";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lens-mail-notify-"));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".lens"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeSignal(total: number, from?: string) {
  fs.writeFileSync(
    path.join(home, ".lens", "mail.signal"),
    JSON.stringify({
      total_unread: total,
      accounts: from ? { "me@example.com": { latest: { from } } } : {},
    }),
  );
}

function writeConfig(value: unknown) {
  fs.writeFileSync(path.join(home, ".lens", "mail.json"), JSON.stringify(value));
}

describe("unread mail indicator", () => {
  it("stays silent when there is no signal", () => {
    const write = vi.fn();
    expect(notify.notifyUnreadMail({ stderr: { write } })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("reports the count and the latest sender", () => {
    writeSignal(2, "noreply@example.com");
    const write = vi.fn();
    notify.notifyUnreadMail({ stderr: { write } });
    expect(write).toHaveBeenCalledWith(expect.stringContaining("2 new emails (latest from noreply@example.com)"));
  });

  it("respects notify:false", () => {
    writeSignal(1, "someone@example.com");
    writeConfig({ notify: false });
    const write = vi.fn();
    notify.notifyUnreadMail({ stderr: { write } });
    expect(write).not.toHaveBeenCalled();
  });

  it("throttles repeats within a minute", () => {
    writeSignal(1, "someone@example.com");
    const write = vi.fn();
    notify.notifyUnreadMail({ stderr: { write }, now: Date.now() });
    notify.notifyUnreadMail({ stderr: { write }, now: Date.now() });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("says nothing when nothing is unread", () => {
    writeSignal(0);
    const write = vi.fn();
    notify.notifyUnreadMail({ stderr: { write } });
    expect(write).not.toHaveBeenCalled();
  });
});
