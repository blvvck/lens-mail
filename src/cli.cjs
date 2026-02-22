#!/usr/bin/env node
"use strict";

const { isMailCommand, printMailHelp, runMailCommand } = require("./dispatch.cjs");
const { notifyUnreadMail } = require("./notify.cjs");

const argv = process.argv.slice(2);

// This is the only CLI that reads mail, so the unread indicator lives here now.
notifyUnreadMail();

if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  printMailHelp();
  process.exit(0);
}

const command = argv[0] === "otp" ? "mail.code" : argv[0];

if (!isMailCommand(command)) {
  console.error(`Error: Unknown command: ${argv[0]}`);
  printMailHelp();
  process.exit(1);
}

try {
  runMailCommand({ command, args: argv.slice(1) });
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
