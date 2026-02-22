"use strict";

const fs = require("fs");
const path = require("path");
const {
  checkMailPermissions,
  parseMailFlags,
  resolveMailIdentity,
} = require("../config.cjs");
const { mailRequest } = require("../client.cjs");

const MAILBOX_MAIL_COMMANDS = new Set([
  "mail.whoami",
  "mail.check",
  "mail.read",
  "mail.send",
  "mail.code",
  "mail.link",
  "mail.links",
  "mail.wait",
  "mail.delete",
  "mail.search",
]);

class MailExit extends Error {
  constructor(code) {
    super(`Mail command exited with code ${code}`);
    this.name = "MailExit";
    this.code = code;
  }
}

function isMailboxMailCommand(command) {
  return MAILBOX_MAIL_COMMANDS.has(command);
}

function buildDependencies(overrides = {}) {
  return {
    fsRef: overrides.fsRef || fs,
    pathRef: overrides.pathRef || path,
    parseMailFlags: overrides.parseMailFlags || parseMailFlags,
    resolveMailIdentity: overrides.resolveMailIdentity || resolveMailIdentity,
    checkMailPermissions: overrides.checkMailPermissions || checkMailPermissions,
    mailRequest: overrides.mailRequest || mailRequest,
    consoleRef: overrides.consoleRef || console,
    processRef: overrides.processRef || process,
    setTimeoutRef: overrides.setTimeoutRef || setTimeout,
    clearTimeoutRef: overrides.clearTimeoutRef || clearTimeout,
    dateNow: overrides.dateNow || Date.now,
  };
}

function requireIdentity(flags, deps) {
  deps.checkMailPermissions();
  const identity = deps.resolveMailIdentity(flags);
  if (!identity) {
    deps.consoleRef.error("No mail identity configured.");
    deps.consoleRef.error("Run: lens mail.setup --name <name>");
    throw new MailExit(2);
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

function handleMailError(response, context, deps) {
  const { status, data } = response;
  if (status === 401 || status === 403) {
    deps.consoleRef.error(`Auth error: ${data.error || "Invalid API key"}`);
    throw new MailExit(2);
  }
  if (status === 404) {
    deps.consoleRef.error(`Not found: ${data.error || context || "Resource not found"}`);
    throw new MailExit(1);
  }
  if (status === 429) {
    const retryAfter = data.retryAfter || "unknown";
    deps.consoleRef.error(`Rate limited. Retry in ${retryAfter}s`);
    throw new MailExit(4);
  }
  if (status === 400 || status === 422) {
    deps.consoleRef.error(`Validation error: ${data.error || "Bad request"}`);
    throw new MailExit(5);
  }
  deps.consoleRef.error(`Error: HTTP ${status} — ${data.error || "Unknown error"}`);
  throw new MailExit(3);
}

function extractVerificationCode(text) {
  if (!text) return null;
  const codePatterns = [
    /(?:verification|confirm(?:ation)?|auth(?:entication)?|security|one[- ]?time|otp|2fa|mfa)\s*(?:code|pin|number|token)\s*(?:is|:)?\s*[:\-]?\s*([A-Z0-9]{4,8})/i,
    /(?:code|pin|otp|token)\s*(?:is|:)\s*[:\-]?\s*([A-Z0-9]{4,8})/i,
    /([A-Z0-9]{4,8})\s*(?:is your|is the)\s*(?:verification|confirm|auth|security|otp|code)/i,
    /\b(\d{4,8})\b/,
  ];
  for (const pattern of codePatterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

function extractLinks(text) {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return [...new Set(matches)];
}

function parseWaitFilter(filterStr) {
  const filters = {};
  if (!filterStr) return filters;
  const parts = filterStr.split(/\s+/);
  for (const part of parts) {
    if (part.startsWith("from:")) filters.from = part.slice(5);
    else if (part.startsWith("subject:")) filters.subject = part.slice(8);
    else filters.keyword = filters.keyword ? `${filters.keyword} ${part}` : part;
  }
  return filters;
}

async function runWhoami(args, deps) {
  const { flags } = deps.parseMailFlags(args);
  deps.checkMailPermissions();
  const identity = deps.resolveMailIdentity(flags);
  if (!identity) {
    deps.consoleRef.error("No mail identity configured.");
    deps.consoleRef.error("Run: lens mail.setup --name <name>");
    throw new MailExit(2);
  }
  if (identity.source === "env") {
    deps.consoleRef.log("(using LENS_MAIL_KEY env var)");
    deps.consoleRef.log("Address: unknown (env override — key only)");
  } else {
    deps.consoleRef.log(identity.address || "Address: unknown");
    if (identity.mailboxType === "temporary") {
      deps.consoleRef.log(`Type: temporary (expires ${identity.expiresAt || "unknown"})`);
    }
  }
}

async function runCheck(args, deps) {
  const { flags } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);

  const params = new URLSearchParams();
  if (flags.filter) params.set("filter", flags.filter);
  if (flags.unread) params.set("unread", "true");
  if (flags.limit) params.set("limit", flags.limit);
  if (flags.tag) params.set("tag", flags.tag);

  const queryStr = params.toString();
  const apiPath = "/api/v1/mail/messages" + (queryStr ? `?${queryStr}` : "");

  try {
    const response = await deps.mailRequest("GET", apiPath, null, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, "inbox", deps);

    const result = response.data;
    const data = result.data || result;

    if (flags.pretty) {
      deps.processRef.stderr.write(`Inbox: ${data.count || 0} messages (${data.unread || 0} unread)\n\n`);
      const messages = data.messages || [];
      if (messages.length === 0) {
        deps.processRef.stderr.write("  (no messages)\n");
      } else {
        const hdr = "  " + "STATUS".padEnd(8) + "FROM".padEnd(30) + "SUBJECT".padEnd(40) + "TIME";
        deps.processRef.stderr.write(hdr + "\n");
        deps.processRef.stderr.write("  " + "-".repeat(hdr.trim().length) + "\n");
        for (const msg of messages) {
          const status = msg.read ? "  read" : "* NEW ";
          const flagWarn = msg.flagged ? " \u26a0" : "";
          const from = (msg.from || "unknown").slice(0, 28).padEnd(30);
          const subject = (msg.subject || "(no subject)").slice(0, 38).padEnd(40);
          const time = msg.date ? relativeTime(msg.date, deps) : "";
          deps.processRef.stderr.write(`  ${status}${flagWarn}  ${from}${subject}${time}\n`);
        }
      }
    } else {
      deps.consoleRef.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    if (err instanceof MailExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailExit(3);
  }
}

async function runRead(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const messageId = positional[0];
  if (!messageId) {
    deps.consoleRef.error("Usage: lens mail.read <message-id>");
    throw new MailExit(5);
  }

  try {
    const params = new URLSearchParams();
    if (flags.raw) params.set("raw", "true");
    if (flags.attachments) params.set("attachments", "true");
    const queryStr = params.toString();
    const apiPath = `/api/v1/mail/messages/${encodeURIComponent(messageId)}` + (queryStr ? `?${queryStr}` : "");
    const response = await deps.mailRequest("GET", apiPath, null, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, `message ${messageId}`, deps);

    const msg = response.data.data || response.data;
    const secFlags = msg.security_flags || [];
    if (secFlags.length > 0) {
      deps.processRef.stderr.write("\n");
      for (const flag of secFlags) {
        deps.processRef.stderr.write(`${flag.message}\n`);
        if (flag.details) deps.processRef.stderr.write(`  Details: ${flag.details}\n`);
      }
      deps.processRef.stderr.write("\n");
    }
    const auth = msg.auth;
    if (auth && !auth.verified && auth.status !== "pass") {
      deps.processRef.stderr.write(`Auth: ${auth.spf ? "SPF=" + auth.spf : ""} ${auth.dkim ? "DKIM=" + auth.dkim : ""} ${auth.dmarc ? "DMARC=" + auth.dmarc : ""}\n`);
    }

    if (flags.attachments) {
      const atts = msg.attachments || [];
      if (atts.length === 0) {
        deps.processRef.stderr.write("No attachments.\n");
      } else {
        for (const att of atts) {
          const size = att.size ? ` (${att.size} bytes)` : "";
          const type = att.content_type ? ` [${att.content_type}]` : "";
          deps.consoleRef.log(`${att.filename || "unnamed"}${size}${type}`);
        }
      }
    } else if (flags.pretty) {
      deps.processRef.stderr.write(`From:    ${msg.from || "unknown"}\n`);
      deps.processRef.stderr.write(`To:      ${msg.to || "unknown"}\n`);
      deps.processRef.stderr.write(`Subject: ${msg.subject || "(no subject)"}\n`);
      deps.processRef.stderr.write(`Date:    ${msg.received_at || msg.date || "unknown"}\n`);
      if (msg.cc) deps.processRef.stderr.write(`Cc:      ${msg.cc}\n`);
      deps.processRef.stderr.write("\n");
      deps.consoleRef.log(msg.body_text || msg.body || "");
    } else if (flags.raw) {
      if (msg.headers) {
        for (const [key, val] of Object.entries(msg.headers)) deps.consoleRef.log(`${key}: ${val}`);
        deps.consoleRef.log("");
      }
      deps.consoleRef.log(msg.body_text || msg.body || "");
    } else {
      deps.consoleRef.log(msg.body_text || msg.body || "");
    }
  } catch (err) {
    if (err instanceof MailExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailExit(3);
  }
}

async function runSend(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const to = positional[0];
  const subject = positional[1];
  let body = positional[2] || "";
  if (!to || !subject) {
    deps.consoleRef.error('Usage: lens mail.send <to> "<subject>" "<body>"');
    deps.consoleRef.error("Options: --body-file <path>, --html <html>, --cc <addr>, --bcc <addr>, --attach <path>");
    throw new MailExit(5);
  }

  if (flags["body-file"]) {
    const filePath = deps.pathRef.resolve(flags["body-file"]);
    if (!deps.fsRef.existsSync(filePath)) {
      deps.consoleRef.error(`File not found: ${filePath}`);
      throw new MailExit(5);
    }
    body = deps.fsRef.readFileSync(filePath, "utf8");
  }

  const payload = { to, subject, body };
  if (flags.html) payload.html = flags.html;
  if (flags.cc) payload.cc = flags.cc;
  if (flags.bcc) payload.bcc = flags.bcc;

  if (flags.attach) {
    const attachPath = deps.pathRef.resolve(flags.attach);
    if (!deps.fsRef.existsSync(attachPath)) {
      deps.consoleRef.error(`Attachment not found: ${attachPath}`);
      throw new MailExit(5);
    }
    const fileData = deps.fsRef.readFileSync(attachPath);
    payload.attachments = [{
      filename: deps.pathRef.basename(attachPath),
      content: fileData.toString("base64"),
      encoding: "base64",
    }];
  }

  try {
    deps.processRef.stderr.write(`Sending to ${to}...`);
    const response = await deps.mailRequest("POST", "/api/v1/mail/send", payload, identity.apiKey);
    if (response.status === 200 || response.status === 201) {
      deps.processRef.stderr.write(" sent\n");
      const sendData = response.data.data || response.data;
      deps.consoleRef.log(JSON.stringify(sendData, null, 2));
    } else {
      deps.processRef.stderr.write(" failed\n");
      handleMailError(response, "send", deps);
    }
  } catch (err) {
    if (err instanceof MailExit) throw err;
    deps.processRef.stderr.write(" failed\n");
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailExit(3);
  }
}

async function runCode(args, deps) {
  const { flags } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  try {
    const params = new URLSearchParams();
    params.set("limit", "10");
    if (flags.from) params.set("from", flags.from);

    const checkRes = await deps.mailRequest("GET", "/api/v1/mail/messages?" + params.toString(), null, identity.apiKey);
    if (checkRes.status !== 200) return handleMailError(checkRes, "inbox", deps);
    const checkData = checkRes.data.data || checkRes.data;
    const messages = checkData.messages || [];
    if (messages.length === 0) {
      deps.processRef.stderr.write("No messages found.\n");
      throw new MailExit(1);
    }
    for (const msg of messages) {
      const subjectCode = extractVerificationCode(msg.subject || "");
      if (subjectCode) {
        deps.consoleRef.log(subjectCode);
        return;
      }
      const readRes = await deps.mailRequest("GET", `/api/v1/mail/messages/${encodeURIComponent(msg.id)}`, null, identity.apiKey);
      if (readRes.status !== 200) continue;
      const readMsg = readRes.data.data || readRes.data;
      const bodyCode = extractVerificationCode(readMsg.body_text || readMsg.body || "");
      if (bodyCode) {
        deps.consoleRef.log(bodyCode);
        return;
      }
    }
    deps.processRef.stderr.write("No verification code found in recent messages.\n");
    throw new MailExit(1);
  } catch (err) {
    if (err instanceof MailExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailExit(3);
  }
}

async function runLink(command, args, deps) {
  const allLinks = command === "mail.links";
  const { flags } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  try {
    const params = new URLSearchParams();
    params.set("limit", "10");
    if (flags.from) params.set("from", flags.from);
    const checkRes = await deps.mailRequest("GET", "/api/v1/mail/messages?" + params.toString(), null, identity.apiKey);
    if (checkRes.status !== 200) return handleMailError(checkRes, "inbox", deps);
    const checkData = checkRes.data.data || checkRes.data;
    const messages = checkData.messages || [];
    if (messages.length === 0) {
      deps.processRef.stderr.write("No messages found.\n");
      throw new MailExit(1);
    }
    const collectedLinks = [];
    for (const msg of messages) {
      const readRes = await deps.mailRequest("GET", `/api/v1/mail/messages/${encodeURIComponent(msg.id)}`, null, identity.apiKey);
      if (readRes.status !== 200) continue;
      const readMsg = readRes.data.data || readRes.data;
      const links = extractLinks(readMsg.body_text || readMsg.body || "");
      if (!allLinks && links.length > 0) {
        deps.consoleRef.log(links[0]);
        return;
      }
      collectedLinks.push(...links);
      if (!allLinks && collectedLinks.length > 0) break;
    }
    if (collectedLinks.length === 0) {
      deps.processRef.stderr.write("No links found in recent messages.\n");
      throw new MailExit(1);
    }
    for (const link of [...new Set(collectedLinks)]) deps.consoleRef.log(link);
  } catch (err) {
    if (err instanceof MailExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailExit(3);
  }
}

async function runWait(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const filterStr = positional[0] || "";
  const filters = parseWaitFilter(filterStr);
  const timeoutSec = parseInt(flags.timeout, 10) || 300;
  const pollIntervalMs = 5000;
  const extractMode = flags.extract || null;
  const startTime = deps.dateNow();
  const deadline = startTime + timeoutSec * 1000;
  const seenIds = new Set();

  try {
    const params = new URLSearchParams();
    params.set("limit", "50");
    if (filters.from) params.set("from", filters.from);
    if (filters.subject) params.set("subject", filters.subject);
    if (filters.keyword) params.set("q", filters.keyword);
    const initRes = await deps.mailRequest("GET", "/api/v1/mail/messages?" + params.toString(), null, identity.apiKey);
    if (initRes.status === 200) {
      const initData = initRes.data.data || initRes.data;
      for (const msg of initData.messages || []) seenIds.add(msg.id);
    }
  } catch {}

  deps.processRef.stderr.write(`Waiting for email matching '${filterStr || "(any)"}'... `);
  while (deps.dateNow() < deadline) {
    await new Promise((resolve) => deps.setTimeoutRef(resolve, pollIntervalMs));
    const elapsed = Math.floor((deps.dateNow() - startTime) / 1000);
    deps.processRef.stderr.write(`\rWaiting for email matching '${filterStr || "(any)"}'... (${elapsed}s)`);
    try {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (filters.from) params.set("from", filters.from);
      if (filters.subject) params.set("subject", filters.subject);
      if (filters.keyword) params.set("q", filters.keyword);
      const res = await deps.mailRequest("GET", "/api/v1/mail/messages?" + params.toString(), null, identity.apiKey);
      if (res.status !== 200) continue;
      const pollData = res.data.data || res.data;
      const messages = pollData.messages || [];
      const newMessages = messages.filter((msg) => !seenIds.has(msg.id));
      if (newMessages.length === 0) continue;
      deps.processRef.stderr.write("\n");
      const match = newMessages[0];
      if (extractMode === "code") {
        const readRes = await deps.mailRequest("GET", `/api/v1/mail/messages/${encodeURIComponent(match.id)}`, null, identity.apiKey);
        if (readRes.status === 200) {
          const codeMsg = readRes.data.data || readRes.data;
          const code = extractVerificationCode(codeMsg.body_text || codeMsg.body || "");
          if (code) {
            deps.consoleRef.log(code);
            return;
          }
        }
        deps.processRef.stderr.write("Email arrived but no verification code found.\n");
        throw new MailExit(1);
      }
      if (extractMode === "link" || extractMode === "links") {
        const readRes = await deps.mailRequest("GET", `/api/v1/mail/messages/${encodeURIComponent(match.id)}`, null, identity.apiKey);
        if (readRes.status === 200) {
          const linkMsg = readRes.data.data || readRes.data;
          const links = extractLinks(linkMsg.body_text || linkMsg.body || "");
          if (links.length > 0) {
            if (extractMode === "link") deps.consoleRef.log(links[0]);
            else for (const link of links) deps.consoleRef.log(link);
            return;
          }
        }
        deps.processRef.stderr.write("Email arrived but no links found.\n");
        throw new MailExit(1);
      }
      const readRes = await deps.mailRequest("GET", `/api/v1/mail/messages/${encodeURIComponent(match.id)}`, null, identity.apiKey);
      if (readRes.status === 200) deps.consoleRef.log(JSON.stringify(readRes.data.data || readRes.data, null, 2));
      else deps.consoleRef.log(JSON.stringify(match, null, 2));
      return;
    } catch (err) {
      if (err instanceof MailExit) throw err;
    }
  }
  deps.processRef.stderr.write("\n");
  deps.consoleRef.error(`Timeout: no matching email received within ${timeoutSec}s`);
  throw new MailExit(1);
}

async function runDelete(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const messageId = positional[0];
  if (!messageId) {
    deps.consoleRef.error("Usage: lens mail.delete <message-id>");
    throw new MailExit(5);
  }
  try {
    const response = await deps.mailRequest("DELETE", `/api/v1/mail/messages/${encodeURIComponent(messageId)}`, null, identity.apiKey);
    if (response.status === 200 || response.status === 204) {
      deps.processRef.stderr.write(`Deleted message ${messageId}\n`);
    } else {
      handleMailError(response, `message ${messageId}`, deps);
    }
  } catch (err) {
    if (err instanceof MailExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailExit(3);
  }
}

async function runSearch(args, deps) {
  const { flags, positional } = deps.parseMailFlags(args);
  const identity = requireIdentity(flags, deps);
  const query = positional[0] || "";
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (flags.from) params.set("from", flags.from);
  if (flags.last) params.set("last", flags.last);
  if (flags["has-code"]) params.set("has_code", "true");
  if (flags["has-attachment"]) params.set("has_attachment", "true");
  if (flags.limit) params.set("limit", flags.limit);
  const queryStr = params.toString();
  const apiPath = "/api/v1/mail/search" + (queryStr ? `?${queryStr}` : "");
  try {
    const response = await deps.mailRequest("GET", apiPath, null, identity.apiKey);
    if (response.status !== 200) return handleMailError(response, "search", deps);
    const result = response.data;
    const searchData = result.data || result;
    if (flags.pretty) {
      const messages = searchData.messages || [];
      deps.processRef.stderr.write(`Search results: ${messages.length} messages\n\n`);
      if (messages.length === 0) {
        deps.processRef.stderr.write("  (no results)\n");
      } else {
        const hdr = "  " + "STATUS".padEnd(8) + "FROM".padEnd(30) + "SUBJECT".padEnd(40) + "TIME";
        deps.processRef.stderr.write(hdr + "\n");
        deps.processRef.stderr.write("  " + "-".repeat(hdr.trim().length) + "\n");
        for (const msg of messages) {
          const status = msg.read ? "  read" : "* NEW ";
          const flagWarn = msg.flagged ? " \u26a0" : "";
          const from = (msg.from || "unknown").slice(0, 28).padEnd(30);
          const subject = (msg.subject || "(no subject)").slice(0, 38).padEnd(40);
          const time = msg.date ? relativeTime(msg.date, deps) : "";
          deps.processRef.stderr.write(`  ${status}${flagWarn}  ${from}${subject}${time}\n`);
        }
      }
    } else {
      deps.consoleRef.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    if (err instanceof MailExit) throw err;
    deps.consoleRef.error(`Network error: ${err.message}`);
    throw new MailExit(3);
  }
}

async function executeMailboxMailCommand({ command, args, ...overrides }) {
  const deps = buildDependencies(overrides);
  if (command === "mail.whoami") return runWhoami(args, deps);
  if (command === "mail.check") return runCheck(args, deps);
  if (command === "mail.read") return runRead(args, deps);
  if (command === "mail.send") return runSend(args, deps);
  if (command === "mail.code") return runCode(args, deps);
  if (command === "mail.link" || command === "mail.links") return runLink(command, args, deps);
  if (command === "mail.wait") return runWait(args, deps);
  if (command === "mail.delete") return runDelete(args, deps);
  if (command === "mail.search") return runSearch(args, deps);
  return false;
}

function runMailboxMailCommand({ command, args, ...overrides }) {
  const deps = buildDependencies(overrides);
  return executeMailboxMailCommand({ command, args, ...overrides }).catch((error) => {
    if (error instanceof MailExit) {
      deps.processRef.exit(error.code);
      return;
    }
    deps.consoleRef.error(`Error: ${error.message}`);
    deps.processRef.exit(1);
  });
}

module.exports = {
  executeMailboxMailCommand,
  isMailboxMailCommand,
  MAILBOX_MAIL_COMMANDS,
  MailExit,
  runMailboxMailCommand,
};
