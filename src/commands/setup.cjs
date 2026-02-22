"use strict";

const readline = require("readline");

const {
  MAIL_CONFIG_PATH,
  MAIL_PROFILES_DIR,
  getMailBaseUrl,
  parseMailFlags,
  saveMailConfig,
  saveMailProfile,
} = require("../config.cjs");
const { mailRequest } = require("../client.cjs");
const { parseTemporaryTtl } = require("../temporary.cjs");

const MAIL_SETUP_COMMANDS = new Set(["mail.setup", "mail.temp"]);

class MailSetupExit extends Error {
  constructor(code, message) {
    super(message || `Mail setup command exited with code ${code}`);
    this.name = "MailSetupExit";
    this.code = code;
  }
}

function isMailSetupCommand(command) {
  return MAIL_SETUP_COMMANDS.has(command);
}

function parseDisplayName(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Display name must be text");
  const displayName = value.trim();
  if (!displayName) throw new Error("Display name cannot be empty");
  if (displayName.length > 100) throw new Error("Display name must be at most 100 characters");
  if (/[\u0000-\u001f\u007f]/u.test(displayName)) throw new Error("Display name contains invalid control characters");
  return displayName;
}

function hostedMailboxAddress(name, baseUrl) {
  try {
    return new URL(baseUrl).hostname === "api.lenscli.com" ? `${name}@lenscli.com` : null;
  } catch {
    return null;
  }
}

function defaultPrompt(question, deps) {
  const rl = deps.readlineRef.createInterface({
    input: deps.processRef.stdin,
    output: deps.processRef.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function buildDependencies(overrides = {}) {
  return {
    readlineRef: overrides.readlineRef || readline,
    parseMailFlags: overrides.parseMailFlags || parseMailFlags,
    getMailBaseUrl: overrides.getMailBaseUrl || getMailBaseUrl,
    saveMailConfig: overrides.saveMailConfig || saveMailConfig,
    saveMailProfile: overrides.saveMailProfile || saveMailProfile,
    mailRequest: overrides.mailRequest || mailRequest,
    prompt: overrides.prompt,
    mailConfigPath: overrides.mailConfigPath || MAIL_CONFIG_PATH,
    mailProfilesDir: overrides.mailProfilesDir || MAIL_PROFILES_DIR,
    consoleRef: overrides.consoleRef || console,
    processRef: overrides.processRef || process,
  };
}

async function executeMailSetupCommand({ command, args, ...overrides }) {
  if (command === "mail.temp") return executeTemporaryMailboxCommand({ command, args, ...overrides });
  if (command !== "mail.setup") return false;

  const deps = buildDependencies(overrides);
  const prompt = deps.prompt || ((question) => defaultPrompt(question, deps));
  const { flags } = deps.parseMailFlags(args);
  let name = flags.name;
  let displayName;
  try {
    displayName = parseDisplayName(flags.display);
  } catch (error) {
    deps.consoleRef.error(`Error: ${error.message}`);
    throw new MailSetupExit(5);
  }

  if (!name) {
    deps.processRef.stderr.write("Lens Mail — Provision a new agent mailbox\n\n");
    name = await prompt("Agent name (lowercase, e.g. godel): ");
    if (!name) {
      deps.consoleRef.error("Error: Name is required");
      throw new MailSetupExit(5);
    }
  }

  name = name.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (name.length < 1 || name.length > 64) {
    deps.consoleRef.error("Error: Name must be 1-64 chars, lowercase alphanumeric with . _ -");
    throw new MailSetupExit(5);
  }

  const expectedAddress = hostedMailboxAddress(name, deps.getMailBaseUrl());

  if (!flags.name) {
    const confirmation = expectedAddress
      ? `Provision ${expectedAddress}? (y/N): `
      : `Provision mailbox "${name}"? (y/N): `;
    const confirm = await prompt(confirmation);
    const normalized = confirm.toLowerCase();
    if (normalized !== "y" && normalized !== "yes") {
      deps.consoleRef.error("Cancelled.");
      throw new MailSetupExit(0);
    }
  }

  deps.processRef.stderr.write(`Provisioning ${name}...`);
  try {
    const response = await deps.mailRequest("POST", "/api/v1/mail/provision", { name, ...(displayName ? { displayName } : {}) });

    if (response.status === 201 || response.status === 200) {
      const payload = response.data?.data || response.data;
      const { address, apiKey, mailboxId } = payload;
      deps.processRef.stderr.write(" done\n\n");

      const savedDisplayName = payload.displayName || displayName;
      const config = { address, apiKey, baseUrl: deps.getMailBaseUrl(), ...(savedDisplayName ? { displayName: savedDisplayName } : {}) };
      deps.saveMailConfig(config, deps);
      deps.saveMailProfile(name, config, deps);

      deps.consoleRef.log(JSON.stringify({ address, mailboxId, ...(savedDisplayName ? { displayName: savedDisplayName } : {}), configPath: deps.mailConfigPath }, null, 2));
      deps.processRef.stderr.write(`\nStored credentials at ${deps.mailConfigPath} (mode 0600)\n`);
      deps.processRef.stderr.write(`Profile saved at ${deps.mailProfilesDir}/${name}.json\n`);
      return true;
    }

    if (response.status === 429) {
      deps.processRef.stderr.write(" rate limited\n");
      const retryAfter = response.data.retryAfter || "unknown";
      deps.consoleRef.error(`Rate limited. Retry in ${retryAfter}s`);
      throw new MailSetupExit(4);
    }

    if (response.status === 400 || response.status === 422) {
      deps.processRef.stderr.write(" failed\n");
      deps.consoleRef.error(`Error: ${response.data.error || "Could not provision mailbox"}`);
      throw new MailSetupExit(5);
    }

    deps.processRef.stderr.write(" failed\n");
    deps.consoleRef.error(`Error: HTTP ${response.status} — ${response.data.error || "Unknown error"}`);
    throw new MailSetupExit(3);
  } catch (error) {
    if (error instanceof MailSetupExit) throw error;
    deps.processRef.stderr.write(" failed\n");
    deps.consoleRef.error(`Network error: ${error.message}`);
    throw new MailSetupExit(3);
  }
}

async function executeTemporaryMailboxCommand({ command, args, ...overrides }) {
  const deps = buildDependencies(overrides);
  const { flags } = deps.parseMailFlags(args);
  if (flags.display !== undefined) {
    deps.consoleRef.error("Error: Display names are not supported for temporary mailboxes");
    throw new MailSetupExit(5);
  }
  let ttl;
  try {
    ttl = parseTemporaryTtl(flags.ttl);
  } catch (error) {
    deps.consoleRef.error(`Error: ${error.message}`);
    throw new MailSetupExit(5);
  }

  const name = flags.name;
  if (name !== undefined && (typeof name !== "string" || name.length > 64)) {
    deps.consoleRef.error("Error: Name must be at most 64 characters");
    throw new MailSetupExit(5);
  }

  deps.processRef.stderr.write("Creating temporary mailbox...");
  try {
    const response = await deps.mailRequest("POST", "/api/v1/mail/temp", { ...(name ? { name } : {}), ttl });
    if (response.status === 201 || response.status === 200) {
      const payload = response.data?.data || response.data;
      const { address, apiKey, mailboxId, mailboxType, expiresAt } = payload;
      const profileName = address.split("@")[0];
      const config = { address, apiKey, baseUrl: deps.getMailBaseUrl(), mailboxType, expiresAt };
      deps.saveMailConfig(config, deps);
      deps.saveMailProfile(profileName, config, deps);
      deps.processRef.stderr.write(" done\n\n");
      deps.consoleRef.log(JSON.stringify({ address, mailboxId, mailboxType, expiresAt, configPath: deps.mailConfigPath }, null, 2));
      deps.processRef.stderr.write(`\nStored temporary credentials at ${deps.mailConfigPath} (mode 0600)\n`);
      deps.processRef.stderr.write(`Profile saved at ${deps.mailProfilesDir}/${profileName}.json\n`);
      return true;
    }
    deps.processRef.stderr.write(" failed\n");
    if (response.status === 429) {
      const retryAfter = response.data.retryAfter || "unknown";
      deps.consoleRef.error(`Rate limited. Retry in ${retryAfter}s`);
      throw new MailSetupExit(4);
    }
    if (response.status === 400 || response.status === 422) {
      deps.consoleRef.error(`Error: ${response.data.error || "Could not create temporary mailbox"}`);
      throw new MailSetupExit(5);
    }
    deps.consoleRef.error(`Error: HTTP ${response.status} — ${response.data.error || "Unknown error"}`);
    throw new MailSetupExit(3);
  } catch (error) {
    if (error instanceof MailSetupExit) throw error;
    deps.processRef.stderr.write(" failed\n");
    deps.consoleRef.error(`Network error: ${error.message}`);
    throw new MailSetupExit(3);
  }
}

function runMailSetupCommand({ command, args, ...overrides }) {
  return executeMailSetupCommand({ command, args, ...overrides }).catch((error) => {
    const deps = buildDependencies(overrides);
    if (error instanceof MailSetupExit) {
      deps.processRef.exit(error.code);
      return;
    }
    deps.consoleRef.error(`Error: ${error.message}`);
    deps.processRef.exit(1);
  });
}

module.exports = {
  MAIL_SETUP_COMMANDS,
  MailSetupExit,
  executeMailSetupCommand,
  executeTemporaryMailboxCommand,
  isMailSetupCommand,
  runMailSetupCommand,
};
