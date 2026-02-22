"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const {
  checkMailPermissions,
  getMailBaseUrl,
  parseMailFlags,
  resolveMailIdentity,
} = require("../config.cjs");
const { mailRequest } = require("../client.cjs");

const MAIL_MANAGEMENT_COMMANDS = new Set([
  "mail.save",
  "mail.tag",
  "mail.untag",
  "mail.tags",
  "mail.filter.add",
  "mail.filter.list",
  "mail.filter.remove",
  "mail.draft",
  "mail.thread",
]);

class MailManagementExit extends Error {
  constructor(code, message) {
    super(message || `Mail management command exited with code ${code}`);
    this.name = "MailManagementExit";
    this.code = code;
  }
}

function isMailManagementCommand(command) {
  return MAIL_MANAGEMENT_COMMANDS.has(command);
}

function buildDependencies(overrides = {}) {
  return {
    fsRef: overrides.fsRef || fs,
    pathRef: overrides.pathRef || path,
    httpRef: overrides.httpRef || http,
    httpsRef: overrides.httpsRef || https,
    parseMailFlags: overrides.parseMailFlags || parseMailFlags,
    resolveMailIdentity: overrides.resolveMailIdentity || resolveMailIdentity,
    checkMailPermissions: overrides.checkMailPermissions || checkMailPermissions,
    getMailBaseUrl: overrides.getMailBaseUrl || getMailBaseUrl,
    mailRequest: overrides.mailRequest || mailRequest,
    consoleRef: overrides.consoleRef || console,
    processRef: overrides.processRef || process,
    handleMailError: overrides.handleMailError,
    dateNow: overrides.dateNow || Date.now,
  };
}

function requireIdentity(flags, deps) {
  deps.checkMailPermissions();
  const identity = deps.resolveMailIdentity(flags);
  if (!identity) {
    deps.consoleRef.error("No mail identity configured.");
    deps.consoleRef.error("Run: lens mail.setup --name <name>");
    throw new MailManagementExit(2);
  }
  return identity;
}

function relativeTime(isoDate, deps) {
  const now = deps.dateNow();
  const then = new Date(isoDate).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function defaultHandleMailError(response, context, deps) {
  const { status, data } = response;
  if (status === 401 || status === 403) {
    deps.consoleRef.error(`Auth error: ${data.error || "Invalid API key"}`);
    throw new MailManagementExit(2);
  }
  if (status === 404) {
    deps.consoleRef.error(`Not found: ${data.error || context || "Resource not found"}`);
    throw new MailManagementExit(1);
  }
  if (status === 429) {
    const retryAfter = data.retryAfter || "unknown";
    deps.consoleRef.error(`Rate limited. Retry in ${retryAfter}s`);
    throw new MailManagementExit(4);
  }
  if (status === 400 || status === 422) {
    deps.consoleRef.error(`Validation error: ${data.error || "Bad request"}`);
    throw new MailManagementExit(5);
  }
  deps.consoleRef.error(`Error: HTTP ${status} — ${data.error || "Unknown error"}`);
  throw new MailManagementExit(3);
}

function handleMailError(response, context, deps) {
  if (deps.handleMailError) {
    return deps.handleMailError(response, context, deps);
  }
  return defaultHandleMailError(response, context, deps);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mailDownloadRaw(apiPath, apiKey, deps) {
  return new Promise((resolve, reject) => {
    const baseUrl = deps.getMailBaseUrl();
    const fullUrl = new URL(apiPath, baseUrl);
    const isHttps = fullUrl.protocol === "https:";
    const lib = isHttps ? deps.httpsRef : deps.httpRef;
    const headers = { Accept: "*/*" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const options = {
      method: "GET",
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      headers,
    };

    const req = lib.request(options, (res) => {
      if (res.statusCode >= 400) {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, data: { error: data } });
          }
        });
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), headers: res.headers });
      });
    });

    req.on("error", reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("Download timeout"));
    });
    req.end();
  });
}

async function runSave(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const messageId = positional[0];
  if (!messageId) {
    deps.consoleRef.error("Usage: lens mail.save <message-id> [filename] [--out <dir>] [--all]");
    throw new MailManagementExit(5);
  }

  const requestedFilename = positional[1];
  const outDir = flags.out ? deps.pathRef.resolve(flags.out) : deps.processRef.cwd();

  try {
    const msgResponse = await deps.mailRequest(
      "GET",
      `/api/v1/mail/messages/${encodeURIComponent(messageId)}`,
      null,
      identity.apiKey,
    );
    if (msgResponse.status !== 200) return handleMailError(msgResponse, `message ${messageId}`, deps);

    const msg = msgResponse.data.data || msgResponse.data;
    const attachments = msg.attachments || [];

    if (attachments.length === 0) {
      deps.processRef.stderr.write("No attachments\n");
      return;
    }

    let toDownload = [];
    if (requestedFilename) {
      const att = attachments.find((attachment) => attachment.filename === requestedFilename);
      if (!att) {
        deps.consoleRef.error(`Attachment "${requestedFilename}" not found. Available:`);
        for (const attachment of attachments) deps.consoleRef.error(`  ${attachment.filename}`);
        throw new MailManagementExit(1);
      }
      toDownload = [att];
    } else if (flags.all) {
      toDownload = attachments;
    } else if (attachments.length === 1) {
      toDownload = [attachments[0]];
    } else {
      deps.processRef.stderr.write(`${attachments.length} attachments found:\n`);
      for (const attachment of attachments) {
        const size = attachment.size ? ` (${formatFileSize(attachment.size)})` : "";
        deps.processRef.stderr.write(`  ${attachment.filename}${size}\n`);
      }
      deps.consoleRef.error("Specify a filename or use --all");
      throw new MailManagementExit(5);
    }

    if (!deps.fsRef.existsSync(outDir)) deps.fsRef.mkdirSync(outDir, { recursive: true });

    for (const attachment of toDownload) {
      const apiPath = `/api/v1/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.filename)}`;
      const dlResponse = await mailDownloadRaw(apiPath, identity.apiKey, deps);
      if (dlResponse.status >= 400) {
        handleMailError({ status: dlResponse.status, data: dlResponse.data || {} }, attachment.filename, deps);
        continue;
      }

      const savePath = deps.pathRef.join(outDir, attachment.filename);
      deps.fsRef.writeFileSync(savePath, dlResponse.buffer);
      deps.processRef.stderr.write(`Saved ${attachment.filename} (${formatFileSize(dlResponse.buffer.length)})\n`);
    }
  } catch (err) {
    if (err instanceof MailManagementExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailManagementExit(3);
  }
}

async function runTag(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const messageId = positional[0];
  const tags = positional.slice(1);
  if (!messageId || tags.length === 0) {
    deps.consoleRef.error("Usage: lens mail.tag <message-id> <tag> [tag2...]");
    throw new MailManagementExit(5);
  }

  try {
    const response = await deps.mailRequest("POST", `/api/v1/mail/messages/${encodeURIComponent(messageId)}/tags`, { tags }, identity.apiKey);
    if (response.status === 200 || response.status === 201) {
      deps.processRef.stderr.write(`Tagged: ${tags.join(", ")}\n`);
      return;
    }
    handleMailError(response, "tag", deps);
  } catch (err) {
    if (err instanceof MailManagementExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailManagementExit(3);
  }
}

async function runUntag(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const messageId = positional[0];
  const tags = positional.slice(1);
  if (!messageId || tags.length === 0) {
    deps.consoleRef.error("Usage: lens mail.untag <message-id> <tag> [tag2...]");
    throw new MailManagementExit(5);
  }

  try {
    const response = await deps.mailRequest("DELETE", `/api/v1/mail/messages/${encodeURIComponent(messageId)}/tags`, { tags }, identity.apiKey);
    if (response.status === 200 || response.status === 204) {
      deps.processRef.stderr.write(`Untagged: ${tags.join(", ")}\n`);
      return;
    }
    handleMailError(response, "untag", deps);
  } catch (err) {
    if (err instanceof MailManagementExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailManagementExit(3);
  }
}

async function runTags(args, deps) {
  const { flags } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);

  try {
    const response = await deps.mailRequest("GET", "/api/v1/mail/tags", null, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, "tags", deps);

    const result = response.data;
    const tags = (result.data && result.data.tags) || result.tags || [];

    if (flags.pretty) {
      if (tags.length === 0) {
        deps.processRef.stderr.write("  (no tags)\n");
      } else {
        const hdr = `  ${"TAG".padEnd(30)}COUNT`;
        deps.processRef.stderr.write(`${hdr}\n`);
        deps.processRef.stderr.write(`  ${"-".repeat(hdr.trim().length)}\n`);
        for (const tag of tags) {
          const name = (tag.name || tag.tag || String(tag)).slice(0, 28).padEnd(30);
          const count = String(tag.count !== undefined ? tag.count : "");
          deps.processRef.stderr.write(`  ${name}${count}\n`);
        }
      }
    } else {
      deps.consoleRef.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    if (err instanceof MailManagementExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailManagementExit(3);
  }
}

async function runFilterAdd(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const name = positional[0];
  if (!name) {
    deps.consoleRef.error("Usage: lens mail.filter.add <name> --from <pattern> --subject <pattern>");
    throw new MailManagementExit(5);
  }
  if (!flags.from && !flags.subject) {
    deps.consoleRef.error("Error: At least one of --from or --subject is required");
    throw new MailManagementExit(5);
  }

  const rules = {};
  if (flags.from) rules.from = flags.from;
  if (flags.subject) rules.subject = flags.subject;

  try {
    const response = await deps.mailRequest("POST", "/api/v1/mail/filters", { name, rules }, identity.apiKey);
    if (response.status === 200 || response.status === 201) {
      deps.processRef.stderr.write(`Filter '${name}' created\n`);
      return;
    }
    handleMailError(response, "filter", deps);
  } catch (err) {
    if (err instanceof MailManagementExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailManagementExit(3);
  }
}

async function runFilterList(args, deps) {
  const { flags } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);

  try {
    const response = await deps.mailRequest("GET", "/api/v1/mail/filters", null, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, "filters", deps);

    const result = response.data;
    const filters = (result.data && result.data.filters) || result.filters || [];

    if (flags.pretty) {
      if (filters.length === 0) {
        deps.processRef.stderr.write("  (no filters)\n");
      } else {
        const hdr = `  ${"NAME".padEnd(25)}RULES`;
        deps.processRef.stderr.write(`${hdr}\n`);
        deps.processRef.stderr.write(`  ${"-".repeat(hdr.trim().length + 30)}\n`);
        for (const filter of filters) {
          const name = (filter.name || "unnamed").slice(0, 23).padEnd(25);
          const rulesParts = [];
          if (filter.rules) {
            if (filter.rules.from) rulesParts.push(`from:${filter.rules.from}`);
            if (filter.rules.subject) rulesParts.push(`subject:${filter.rules.subject}`);
          }
          deps.processRef.stderr.write(`  ${name}${rulesParts.join(", ") || "(none)"}\n`);
        }
      }
    } else {
      deps.consoleRef.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    if (err instanceof MailManagementExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailManagementExit(3);
  }
}

async function runFilterRemove(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const name = positional[0];
  if (!name) {
    deps.consoleRef.error("Usage: lens mail.filter.remove <name>");
    throw new MailManagementExit(5);
  }

  try {
    const response = await deps.mailRequest("DELETE", `/api/v1/mail/filters/${encodeURIComponent(name)}`, null, identity.apiKey);
    if (response.status === 200 || response.status === 204) {
      deps.processRef.stderr.write(`Filter '${name}' deleted\n`);
      return;
    }
    handleMailError(response, `filter '${name}'`, deps);
  } catch (err) {
    if (err instanceof MailManagementExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailManagementExit(3);
  }
}

async function runDraft(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const subCmd = positional[0];
  if (!subCmd) {
    deps.consoleRef.error("Usage: lens mail.draft <save|list|read|edit|send|delete> [args]");
    throw new MailManagementExit(5);
  }

  const subPositional = positional.slice(1);

  try {
    if (subCmd === "save") {
      if (!flags.to || !flags.subject) {
        deps.consoleRef.error("Usage: lens mail.draft save --to <addr> --subject <subj> --body <text>");
        throw new MailManagementExit(5);
      }
      const payload = { to: flags.to, subject: flags.subject };
      if (flags.body) payload.body = flags.body;

      const response = await deps.mailRequest("POST", "/api/v1/mail/drafts", payload, identity.apiKey);
      if (response.status === 200 || response.status === 201) {
        const draft = response.data.data || response.data;
        deps.processRef.stderr.write(`Draft saved: ${draft.id || draft.draftId || "unknown"}\n`);
        return;
      }
      handleMailError(response, "draft save", deps);
      return;
    }

    if (subCmd === "list") {
      const response = await deps.mailRequest("GET", "/api/v1/mail/drafts", null, identity.apiKey);
      if (response.status !== 200) return handleMailError(response, "drafts", deps);

      const result = response.data;
      const drafts = (result.data && result.data.drafts) || result.drafts || [];

      if (flags.pretty) {
        if (drafts.length === 0) {
          deps.processRef.stderr.write("  (no drafts)\n");
        } else {
          const hdr = `  ${"ID".padEnd(15)}${"TO".padEnd(30)}${"SUBJECT".padEnd(35)}UPDATED`;
          deps.processRef.stderr.write(`${hdr}\n`);
          deps.processRef.stderr.write(`  ${"-".repeat(hdr.trim().length)}\n`);
          for (const draft of drafts) {
            const id = (draft.id || "").slice(0, 13).padEnd(15);
            const to = (draft.to || "").slice(0, 28).padEnd(30);
            const subject = (draft.subject || "(no subject)").slice(0, 33).padEnd(35);
            const updated = draft.updated_at ? relativeTime(draft.updated_at, deps) : "";
            deps.processRef.stderr.write(`  ${id}${to}${subject}${updated}\n`);
          }
        }
      } else {
        deps.consoleRef.log(JSON.stringify(result, null, 2));
      }
      return;
    }

    if (subCmd === "read") {
      const draftId = subPositional[0];
      if (!draftId) {
        deps.consoleRef.error("Usage: lens mail.draft read <id>");
        throw new MailManagementExit(5);
      }
      const response = await deps.mailRequest("GET", `/api/v1/mail/drafts/${encodeURIComponent(draftId)}`, null, identity.apiKey);
      if (response.status !== 200) return handleMailError(response, `draft ${draftId}`, deps);

      const draft = response.data.data || response.data;
      if (flags.pretty) {
        deps.processRef.stderr.write(`To:      ${draft.to || ""}\n`);
        deps.processRef.stderr.write(`Subject: ${draft.subject || "(no subject)"}\n`);
        if (draft.updated_at) deps.processRef.stderr.write(`Updated: ${draft.updated_at}\n`);
        deps.processRef.stderr.write("\n");
        deps.consoleRef.log(draft.body || "");
      } else {
        deps.consoleRef.log(JSON.stringify(response.data, null, 2));
      }
      return;
    }

    if (subCmd === "edit") {
      const draftId = subPositional[0];
      if (!draftId) {
        deps.consoleRef.error("Usage: lens mail.draft edit <id> --to <addr> --subject <subj> --body <text>");
        throw new MailManagementExit(5);
      }

      const payload = {};
      if (flags.to) payload.to = flags.to;
      if (flags.subject) payload.subject = flags.subject;
      if (flags.body) payload.body = flags.body;

      const response = await deps.mailRequest("PUT", `/api/v1/mail/drafts/${encodeURIComponent(draftId)}`, payload, identity.apiKey);
      if (response.status === 200) {
        deps.processRef.stderr.write("Draft updated\n");
        return;
      }
      handleMailError(response, `draft ${draftId}`, deps);
      return;
    }

    if (subCmd === "send") {
      const draftId = subPositional[0];
      if (!draftId) {
        deps.consoleRef.error("Usage: lens mail.draft send <id>");
        throw new MailManagementExit(5);
      }
      const response = await deps.mailRequest("POST", `/api/v1/mail/drafts/${encodeURIComponent(draftId)}/send`, null, identity.apiKey);
      if (response.status === 200 || response.status === 201) {
        const sendData = response.data.data || response.data;
        deps.processRef.stderr.write(`Draft sent (queued): ${sendData.sendId || sendData.id || "unknown"}\n`);
        return;
      }
      handleMailError(response, `draft send ${draftId}`, deps);
      return;
    }

    if (subCmd === "delete") {
      const draftId = subPositional[0];
      if (!draftId) {
        deps.consoleRef.error("Usage: lens mail.draft delete <id>");
        throw new MailManagementExit(5);
      }
      const response = await deps.mailRequest("DELETE", `/api/v1/mail/drafts/${encodeURIComponent(draftId)}`, null, identity.apiKey);
      if (response.status === 200 || response.status === 204) {
        deps.processRef.stderr.write("Draft deleted\n");
        return;
      }
      handleMailError(response, `draft ${draftId}`, deps);
      return;
    }

    deps.consoleRef.error(`Unknown draft command: ${subCmd}`);
    deps.consoleRef.error("Usage: lens mail.draft <save|list|read|edit|send|delete> [args]");
    throw new MailManagementExit(5);
  } catch (err) {
    if (err instanceof MailManagementExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailManagementExit(3);
  }
}

async function runThread(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const messageId = positional[0];
  if (!messageId) {
    deps.consoleRef.error("Usage: lens mail.thread <message-id> [--full]");
    throw new MailManagementExit(5);
  }

  try {
    const response = await deps.mailRequest("GET", `/api/v1/mail/messages/${encodeURIComponent(messageId)}/thread`, null, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, `thread for ${messageId}`, deps);

    const result = response.data;
    const threadData = result.data || result;
    const messages = threadData.messages || [];

    if (flags.pretty || !flags.json) {
      deps.processRef.stderr.write(`Thread: ${messages.length} messages\n\n`);
      for (const msg of messages) {
        const isCurrent = msg.id === messageId;
        const arrow = isCurrent ? "\x1b[36m→ " : "  ";
        const reset = isCurrent ? "\x1b[0m" : "";
        const direction = msg.direction === "outbound" ? "\x1b[33m↑ OUT\x1b[0m" : "\x1b[32m↓ IN\x1b[0m";
        const sender = msg.from || "unknown";
        const date = msg.date || msg.received_at || "";
        const subject = msg.subject || "(no subject)";

        deps.processRef.stderr.write(`${arrow}${direction} ${sender}  ${date ? relativeTime(date, deps) : ""}${reset}\n`);
        deps.processRef.stderr.write(`  Subject: ${subject}\n`);

        if (flags.full) {
          deps.processRef.stderr.write(`  ${msg.body_text || msg.body || ""}\n`);
        } else {
          const snippet = msg.snippet || msg.body_text || msg.body || "";
          const truncated = snippet.slice(0, 120).replace(/\n/g, " ");
          deps.processRef.stderr.write(`  ${truncated}${snippet.length > 120 ? "..." : ""}\n`);
        }
        deps.processRef.stderr.write("\n");
      }
    } else {
      deps.consoleRef.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    if (err instanceof MailManagementExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailManagementExit(3);
  }
}

async function executeMailManagementCommand({ command, args, ...overrides }) {
  const deps = buildDependencies(overrides);
  const runner =
    command === "mail.save" ? runSave :
    command === "mail.tag" ? runTag :
    command === "mail.untag" ? runUntag :
    command === "mail.tags" ? runTags :
    command === "mail.filter.add" ? runFilterAdd :
    command === "mail.filter.list" ? runFilterList :
    command === "mail.filter.remove" ? runFilterRemove :
    command === "mail.draft" ? runDraft :
    command === "mail.thread" ? runThread : null;

  if (!runner) return false;
  await runner(args, deps);
  return true;
}

function runMailManagementCommand({ command, args, ...overrides }) {
  return executeMailManagementCommand({ command, args, ...overrides }).catch((error) => {
    const deps = buildDependencies(overrides);
    if (error instanceof MailManagementExit) {
      if (error.message && !/^Mail management command exited/.test(error.message)) {
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
  MAIL_MANAGEMENT_COMMANDS,
  MailManagementExit,
  executeMailManagementCommand,
  isMailManagementCommand,
  runMailManagementCommand,
};
