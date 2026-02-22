"use strict";

const { isMailboxMailCommand, runMailboxMailCommand } = require("./commands/mailbox.cjs");
const { isMailManagementCommand, runMailManagementCommand } = require("./commands/management.cjs");
const { isMailSecurityCommand, runMailSecurityCommand } = require("./commands/security.cjs");
const { isMailSetupCommand, runMailSetupCommand } = require("./commands/setup.cjs");
const { isMailDaemonCommand, runMailDaemonCommand } = require("./commands/daemon.cjs");

const DAEMON_SUBCOMMANDS = ["start", "stop", "status", "logs"];

const MAIL_COMMANDS = new Set([
  "mail.setup", "mail.whoami", "mail.check", "mail.read", "mail.send",
  "mail.code", "mail.link", "mail.links", "mail.wait", "mail.delete", "mail.search",
  "mail.save",
  "mail.tag", "mail.untag", "mail.tags",
  "mail.filter.add", "mail.filter.list", "mail.filter.remove",
  "mail.draft",
  "mail.thread",
  "mail.daemon", "mail.daemon.start", "mail.daemon.stop", "mail.daemon.status", "mail.daemon.logs",
  "mail.verify",
  "mail.block", "mail.unblock", "mail.blocked",
  "mail.quarantine", "mail.release",
  "mail.help",
]);

// The binary is namespaced by being mail-only, so `lens-mail whoami` and
// `lens-mail mail.whoami` must both work. Handlers keep their internal names.
function canonicalMailCommand(command) {
  if (!command) return command;
  return command.startsWith("mail.") ? command : `mail.${command}`;
}

const MAIL_HELP = `
\x1b[1mlens-mail\x1b[0m — your agent's mailbox

\x1b[36mIDENTITY\x1b[0m
  setup [--name <n> --display <d>]    Provision a mailbox
  whoami                              Show the current identity

\x1b[36mMESSAGES\x1b[0m
  check [--unread] [--tag <t>] [--pretty]
  read <id> [--pretty] [--raw]
  send <to> --subject <s> [--body <b>] [--body-file <f>]
  wait [--from <f>] [--subject <s>] [--timeout 60]
  search [--q <query>] [--from <f>] [--last <n>]
  delete <id>
  thread <id> [--full]
  save <id> [filename] [--out <dir>] [--all]
  draft

\x1b[36mAGENT SHORTCUTS\x1b[0m
  code [--pretty]                     Latest verification code (alias: otp)
  link / links [--pretty]             Extract links from recent mail

\x1b[36mORGANISE\x1b[0m
  tag <id> <tag...> / untag <id> <tag...> / tags
  filter.add <name> --from <p> --subject <p> / filter.list / filter.remove <name>

\x1b[36mSECURITY\x1b[0m
  verify [code|remove]                TOTP-style owner verification
  block / unblock / blocked
  quarantine / release <id>

\x1b[36mDAEMON\x1b[0m
  daemon [start|stop|status|logs]

\x1b[36mFLAGS\x1b[0m
  --pretty   Human-readable output on stderr
  --as <id>  Use a named profile
  --json     Force JSON output

\x1b[36mENVIRONMENT\x1b[0m
  LENS_MAIL_KEY   API key override
  LENS_MAIL_API   API base URL

\x1b[36mFILES\x1b[0m
  ~/.lens/mail.json, mail-profiles/, mail.signal, mail.pid, mail-daemon.sock, mail-daemon.log

Rooms and wires live in lens-room (lens-room / lens-wire).
`;

function isMailCommand(command) {
  return MAIL_COMMANDS.has(canonicalMailCommand(command));
}

function printMailHelp(processRef = process) {
  processRef.stderr.write(MAIL_HELP.trim() + "\n");
}

function buildDependencies(overrides = {}) {
  return {
    isMailSetupCommand: overrides.isMailSetupCommand || isMailSetupCommand,
    runMailSetupCommand: overrides.runMailSetupCommand || runMailSetupCommand,
    isMailboxMailCommand: overrides.isMailboxMailCommand || isMailboxMailCommand,
    runMailboxMailCommand: overrides.runMailboxMailCommand || runMailboxMailCommand,
    isMailManagementCommand: overrides.isMailManagementCommand || isMailManagementCommand,
    runMailManagementCommand: overrides.runMailManagementCommand || runMailManagementCommand,
    isMailSecurityCommand: overrides.isMailSecurityCommand || isMailSecurityCommand,
    runMailSecurityCommand: overrides.runMailSecurityCommand || runMailSecurityCommand,
    isMailDaemonCommand: overrides.isMailDaemonCommand || isMailDaemonCommand,
    runMailDaemonCommand: overrides.runMailDaemonCommand || runMailDaemonCommand,
    processRef: overrides.processRef || process,
    consoleRef: overrides.consoleRef || console,
  };
}

function runMailCommand({ command, args, ...overrides }) {
  const deps = buildDependencies(overrides);
  let canonical = canonicalMailCommand(command);
  let effectiveArgs = args;

  // `daemon start` arrives as command "daemon" plus an argument.
  if (canonical === "mail.daemon" && DAEMON_SUBCOMMANDS.includes(args[0])) {
    canonical = `mail.daemon.${args[0]}`;
    effectiveArgs = args.slice(1);
  }

  if (canonical === "mail.help" || effectiveArgs.includes("--help-full") || effectiveArgs.includes("--help") || effectiveArgs.includes("-h")) {
    printMailHelp(deps.processRef);
    deps.processRef.exit(0);
    return;
  }

  if (deps.isMailSetupCommand(canonical)) {
    return deps.runMailSetupCommand({ command: canonical, args: effectiveArgs });
  }
  if (deps.isMailboxMailCommand(canonical)) {
    return deps.runMailboxMailCommand({ command: canonical, args: effectiveArgs });
  }
  if (deps.isMailManagementCommand(canonical)) {
    return deps.runMailManagementCommand({ command: canonical, args: effectiveArgs });
  }
  if (deps.isMailSecurityCommand(canonical)) {
    return deps.runMailSecurityCommand({ command: canonical, args: effectiveArgs });
  }
  if (deps.isMailDaemonCommand(canonical)) {
    return deps.runMailDaemonCommand({ command: canonical, args: effectiveArgs });
  }

  deps.consoleRef.error(`Error: Unknown command: ${command}`);
  deps.processRef.exit(1);
}

module.exports = {
  MAIL_COMMANDS,
  MAIL_HELP,
  isMailCommand,
  printMailHelp,
  runMailCommand,
};
