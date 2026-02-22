"use strict";

const {
  checkMailPermissions,
  parseMailFlags,
  resolveMailIdentity,
} = require("../config.cjs");
const { mailRequest } = require("../client.cjs");

const MAIL_SECURITY_COMMANDS = new Set([
  "mail.verify",
  "mail.block",
  "mail.unblock",
  "mail.blocked",
  "mail.quarantine",
  "mail.release",
]);

class MailSecurityExit extends Error {
  constructor(code, message) {
    super(message || `Mail security command exited with code ${code}`);
    this.name = "MailSecurityExit";
    this.code = code;
  }
}

function isMailSecurityCommand(command) {
  return MAIL_SECURITY_COMMANDS.has(command);
}

function buildDependencies(overrides = {}) {
  return {
    parseMailFlags: overrides.parseMailFlags || parseMailFlags,
    resolveMailIdentity: overrides.resolveMailIdentity || resolveMailIdentity,
    checkMailPermissions: overrides.checkMailPermissions || checkMailPermissions,
    mailRequest: overrides.mailRequest || mailRequest,
    consoleRef: overrides.consoleRef || console,
    processRef: overrides.processRef || process,
    handleMailError: overrides.handleMailError,
  };
}

function requireIdentity(flags, deps) {
  deps.checkMailPermissions();
  const identity = deps.resolveMailIdentity(flags);
  if (!identity) {
    deps.consoleRef.error("No mail identity configured.");
    deps.consoleRef.error("Run: lens mail.setup --name <name>");
    throw new MailSecurityExit(2);
  }
  return identity;
}

function defaultHandleMailError(response, context, deps) {
  const { status, data } = response;
  if (status === 401 || status === 403) {
    deps.consoleRef.error(`Auth error: ${data.error || "Invalid API key"}`);
    throw new MailSecurityExit(2);
  }
  if (status === 404) {
    deps.consoleRef.error(`Not found: ${data.error || context || "Resource not found"}`);
    throw new MailSecurityExit(1);
  }
  if (status === 429) {
    const retryAfter = data.retryAfter || "unknown";
    deps.consoleRef.error(`Rate limited. Retry in ${retryAfter}s`);
    throw new MailSecurityExit(4);
  }
  if (status === 400 || status === 422) {
    deps.consoleRef.error(`Validation error: ${data.error || "Bad request"}`);
    throw new MailSecurityExit(5);
  }
  deps.consoleRef.error(`Error: HTTP ${status} — ${data.error || "Unknown error"}`);
  throw new MailSecurityExit(3);
}

function handleMailError(response, context, deps) {
  if (deps.handleMailError) return deps.handleMailError(response, context, deps);
  return defaultHandleMailError(response, context, deps);
}

async function runVerify(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const sub = positional[0];

  try {
    if (sub === "remove" || sub === "delete") {
      const response = await deps.mailRequest("DELETE", "/api/v1/mail/owner-token", null, identity.apiKey);
      if (response.status !== 200) return handleMailError(response, "owner verification", deps);
      deps.processRef.stderr.write("Owner verification removed.\n");
      return;
    }

    if (sub === "code") {
      const response = await deps.mailRequest("GET", "/api/v1/mail/owner-token/code", null, identity.apiKey);
      if (response.status !== 200) return handleMailError(response, "verify code", deps);
      const data = response.data.data || response.data;
      deps.processRef.stderr.write(`\n  verify:${data.code}\n\n`);
      deps.processRef.stderr.write(`  Expires in ${data.expires_in}s. Include "verify:${data.code}" in your email.\n\n`);
      return;
    }

    const body = {};
    if (sub && sub !== "setup" && sub !== "rotate") {
      body.custom = sub;
    } else if (positional[1]) {
      body.custom = positional[1];
    }
    const response = await deps.mailRequest("POST", "/api/v1/mail/owner-token", body, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, "owner verification", deps);
    const data = response.data.data || response.data;
    deps.processRef.stderr.write(`\n  Secret: ${data.secret}\n`);
    deps.processRef.stderr.write("  SAVE THIS — it won't be shown again.\n\n");
    deps.processRef.stderr.write(`  Your first code: verify:${data.first_code} (expires in ${data.expires_in}s)\n\n`);
    deps.processRef.stderr.write("  Usage:\n");
    deps.processRef.stderr.write("    lens mail.verify code     → get current 6-digit code\n");
    deps.processRef.stderr.write("    Include \"verify:XXXXXX\" in your email to authenticate.\n\n");
  } catch (err) {
    if (err instanceof MailSecurityExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailSecurityExit(3);
  }
}

async function runBlock(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const sender = positional[0];
  if (!sender) {
    deps.consoleRef.error("Usage: lens mail.block <email-or-@domain> [reason]");
    throw new MailSecurityExit(5);
  }
  const reason = positional.slice(1).join(" ");
  try {
    const response = await deps.mailRequest("POST", "/api/v1/mail/block", { sender, reason }, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, "block", deps);
    const data = response.data.data || response.data;
    deps.processRef.stderr.write(`Blocked: ${data.blocked}\n`);
    if (data.reason) deps.processRef.stderr.write(`Reason: ${data.reason}\n`);
  } catch (err) {
    if (err instanceof MailSecurityExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailSecurityExit(3);
  }
}

async function runUnblock(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const sender = positional[0];
  if (!sender) {
    deps.consoleRef.error("Usage: lens mail.unblock <email-or-@domain>");
    throw new MailSecurityExit(5);
  }
  try {
    const response = await deps.mailRequest("DELETE", "/api/v1/mail/block", { sender }, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, "unblock", deps);
    const data = response.data.data || response.data;
    deps.processRef.stderr.write(`Unblocked: ${data.unblocked}\n`);
  } catch (err) {
    if (err instanceof MailSecurityExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailSecurityExit(3);
  }
}

async function runBlocked(args, deps) {
  const { flags } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  try {
    const response = await deps.mailRequest("GET", "/api/v1/mail/blocked", null, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, "blocked list", deps);
    const data = response.data.data || response.data;
    const list = data.blocked || [];

    if (list.length === 0) {
      deps.processRef.stderr.write("No blocked senders.\n");
      return;
    }

    deps.processRef.stderr.write(`Blocked senders (${list.length}):\n\n`);
    for (const entry of list) {
      const reason = entry.reason ? ` — ${entry.reason}` : "";
      deps.processRef.stderr.write(`  ${entry.sender}${reason} (by ${entry.blocked_by})\n`);
    }
  } catch (err) {
    if (err instanceof MailSecurityExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailSecurityExit(3);
  }
}

async function runQuarantine(args, deps) {
  const { flags } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  try {
    const response = await deps.mailRequest("GET", "/api/v1/mail/quarantine", null, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, "quarantine", deps);
    const data = response.data.data || response.data;
    const messages = data.messages || [];

    if (messages.length === 0) {
      deps.processRef.stderr.write("Quarantine is empty.\n");
      return;
    }

    deps.processRef.stderr.write(`Quarantine: ${data.count} held messages\n\n`);
    for (const msg of messages) {
      const flagsText = (msg.security_flags || []).map((flag) => flag.flag).join(", ");
      deps.processRef.stderr.write(`  ${msg.id}  ${(msg.from || "unknown").slice(0, 30).padEnd(32)}${(msg.subject || "(no subject)").slice(0, 40)}\n`);
      if (flagsText) deps.processRef.stderr.write(`    Flags: ${flagsText}\n`);
    }
    deps.processRef.stderr.write("\nUse 'lens mail.release <id>' to release to inbox.\n");
    deps.processRef.stderr.write("Use 'lens mail.delete <id>' to delete.\n");
    deps.processRef.stderr.write("Use 'lens mail.block <sender>' to block the sender.\n");
  } catch (err) {
    if (err instanceof MailSecurityExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailSecurityExit(3);
  }
}

async function runRelease(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const messageId = positional[0];
  if (!messageId) {
    deps.consoleRef.error("Usage: lens mail.release <message-id>");
    throw new MailSecurityExit(5);
  }
  try {
    const response = await deps.mailRequest(
      "POST",
      `/api/v1/mail/quarantine/${encodeURIComponent(messageId)}/release`,
      {},
      identity.apiKey,
    );
    if (response.status !== 200) return handleMailError(response, "release", deps);
    const data = response.data.data || response.data;
    deps.processRef.stderr.write(`Released: ${data.released}\n`);
  } catch (err) {
    if (err instanceof MailSecurityExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailSecurityExit(3);
  }
}

async function executeMailSecurityCommand({ command, args, ...overrides }) {
  const deps = buildDependencies(overrides);
  const runner =
    command === "mail.verify" ? runVerify :
    command === "mail.block" ? runBlock :
    command === "mail.unblock" ? runUnblock :
    command === "mail.blocked" ? runBlocked :
    command === "mail.quarantine" ? runQuarantine :
    command === "mail.release" ? runRelease : null;

  if (!runner) return false;
  await runner(args, deps);
  return true;
}

function runMailSecurityCommand({ command, args, ...overrides }) {
  return executeMailSecurityCommand({ command, args, ...overrides }).catch((error) => {
    const deps = buildDependencies(overrides);
    if (error instanceof MailSecurityExit) {
      if (error.message && !/^Mail security command exited/.test(error.message)) {
        deps.consoleRef.error(error.message);
      }
      deps.processRef.exit(error.code);
      return;
    }
    deps.consoleRef.error(`Error: ${error.message}`);
    deps.processRef.exit(1);
  });
}

module.exports = {
  MAIL_SECURITY_COMMANDS,
  MailSecurityExit,
  executeMailSecurityCommand,
  isMailSecurityCommand,
  runMailSecurityCommand,
};
