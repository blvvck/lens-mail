"use strict";

// Passive unread-mail indicator. Runs on every command: a stat and a JSON parse,
// and only when a signal exists and the user has not opted out.

const fs = require("fs");
const os = require("os");
const path = require("path");

const THROTTLE_MS = 60_000;

function lensPath(...parts) {
  return path.join(os.homedir(), ".lens", ...parts);
}

function notifyUnreadMail({ now = Date.now(), stderr = process.stderr } = {}) {
  const signalPath = lensPath("mail.signal");
  const configPath = lensPath("mail.json");
  const lastNotifyPath = lensPath(".last-notify");

  let signal;
  try {
    fs.statSync(signalPath);
    signal = JSON.parse(fs.readFileSync(signalPath, "utf8"));
  } catch {
    return null;
  }

  try {
    if (now - fs.statSync(lastNotifyPath).mtimeMs < THROTTLE_MS) {
      return null;
    }
  } catch {
    // No throttle file yet: show it.
  }

  try {
    if (JSON.parse(fs.readFileSync(configPath, "utf8")).notify === false) {
      return null;
    }
  } catch {
    // No config: notifications stay on.
  }

  const unread = signal.total_unread || 0;
  if (unread <= 0) {
    return null;
  }

  let message = `\u{1f4ec} ${unread} new email${unread > 1 ? "s" : ""}`;
  const accounts = signal.accounts || {};
  for (const address of Object.keys(accounts)) {
    const latest = accounts[address]?.latest;
    if (latest?.from) {
      message += ` (latest from ${latest.from})`;
      break;
    }
  }

  stderr.write(message + "\n");
  try {
    fs.writeFileSync(lastNotifyPath, "", { mode: 0o600 });
  } catch {
    // The indicator is best effort; failing to record it costs one repeat.
  }

  return message;
}

module.exports = { notifyUnreadMail, THROTTLE_MS };
