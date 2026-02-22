"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const daemon = require("../daemon.cjs");

const LOG_PATH = path.join(os.homedir(), ".lens", "mail-daemon.log");

const MAIL_DAEMON_COMMANDS = new Set([
  "mail.daemon",
  "mail.daemon.start",
  "mail.daemon.stop",
  "mail.daemon.status",
  "mail.daemon.logs",
]);

function isMailDaemonCommand(command) {
  return MAIL_DAEMON_COMMANDS.has(command);
}

function printLogs(args) {
  const linesIndex = args.indexOf("--lines");
  const lines = linesIndex !== -1 ? parseInt(args[linesIndex + 1], 10) || 50 : 50;

  let content;
  try {
    content = fs.readFileSync(LOG_PATH, "utf8");
  } catch {
    console.log("No daemon log yet.");
    return;
  }

  console.log(content.trimEnd().split("\n").slice(-lines).join("\n"));
}

async function runMailDaemonCommand({ command, args = [] }) {
  if (command === "mail.daemon.start") {
    await daemon.ensureDaemon();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await daemon.getDaemonStatus();
    console.log(status.running === false ? "Daemon failed to start." : `Daemon running (pid ${status.pid}).`);
    return;
  }

  if (command === "mail.daemon.stop") {
    await daemon.stopDaemon();
    console.log("Daemon stopped.");
    return;
  }

  if (command === "mail.daemon.logs") {
    printLogs(args);
    return;
  }

  const status = await daemon.getDaemonStatus();
  if (status.running === false) {
    console.log("Daemon: not running");
    return;
  }
  console.log(`Daemon: running (pid ${status.pid}, up ${status.uptime}s, polling ${status.polling ? "yes" : "no"})`);
  if (status.lastPoll) {
    console.log(`Last poll: ${status.lastPoll}`);
  }
}

module.exports = { MAIL_DAEMON_COMMANDS, isMailDaemonCommand, runMailDaemonCommand };
