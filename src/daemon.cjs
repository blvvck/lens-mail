/**
 * mail-daemon.cjs — Wires + Mail Daemon for lens-cli
 *
 * Handles:
 *   - Nothing peer-to-peer: wires live in @lens-cli/wire
 *   - Inbox polling (periodic API calls for new mail)
 *   - Signal file writing (passive notifications)
 *   - Daemon lifecycle (background process management)
 *
 * Run directly:  node mail-daemon.cjs   (starts daemon)
 * Import as lib: require('./mail-daemon.cjs')  (client API)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LENS_DIR = path.join(os.homedir(), '.lens');
const PID_PATH = path.join(LENS_DIR, 'mail.pid');
const SOCK_PATH = path.join(LENS_DIR, 'mail-daemon.sock');
const SIGNAL_PATH = path.join(LENS_DIR, 'mail.signal');
const LOG_PATH = path.join(LENS_DIR, 'mail-daemon.log');
const MAIL_CONFIG_PATH = path.join(LENS_DIR, 'mail.json');
const MAIL_PROFILES_DIR = path.join(LENS_DIR, 'mail-profiles');
const DEFAULT_API = 'https://api.lenscli.com';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const POLL_INTERVAL_MS = 30000;
const AUTO_STOP_INTERVAL_MS = 600000; // 10 min
const CLIENT_TIMEOUT_MS = 10000;
const DAEMON_SETTLE_MS = 500;
const DAEMON_SOCKET_WAIT_MS = 1000;

// ---------------------------------------------------------------------------
// Daemon state (only populated when running as daemon)
// ---------------------------------------------------------------------------

let pollInterval = null;
let daemonStartTime = null;
let lastPollTime = null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    let stat;
    try {
      stat = fs.statSync(LOG_PATH);
    } catch {
      // File doesn't exist yet, that's fine
    }
    if (stat && stat.size > MAX_LOG_SIZE) {
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      fs.writeFileSync(LOG_PATH, content.slice(Math.floor(content.length / 2)));
    }
  } catch {
    // Best-effort logging
  }
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // If we can't log, carry on
  }
}

// ---------------------------------------------------------------------------
// Utility: Atomic file writes
// ---------------------------------------------------------------------------

function ensureLensDir() {
  if (!fs.existsSync(LENS_DIR)) {
    fs.mkdirSync(LENS_DIR, { recursive: true, mode: 0o700 });
  }
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up tmp on failure
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Utility: Process checks
// ---------------------------------------------------------------------------

function isProcessRunning(pid) {
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
function loadMailAccounts() {
  const accounts = [];

  // Load from ~/.lens/mail.json
  try {
    if (fs.existsSync(MAIL_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(MAIL_CONFIG_PATH, 'utf8'));
      if (Array.isArray(config.accounts)) {
        accounts.push(...config.accounts);
      } else if (config.address && config.apiKey) {
        accounts.push(config);
      }
    }
  } catch (err) {
    log(`Failed to load mail.json: ${err.message}`);
  }

  // Load from ~/.lens/mail-profiles/*.json
  try {
    if (fs.existsSync(MAIL_PROFILES_DIR)) {
      const files = fs.readdirSync(MAIL_PROFILES_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const profile = JSON.parse(fs.readFileSync(path.join(MAIL_PROFILES_DIR, file), 'utf8'));
          if (profile.address && profile.apiKey) {
            accounts.push(profile);
          }
        } catch (err) {
          log(`Failed to load profile ${file}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log(`Failed to read mail-profiles: ${err.message}`);
  }

  return accounts;
}

// ---------------------------------------------------------------------------
// State persistence: mail.signal
// ---------------------------------------------------------------------------

function writeSignalFile(signal) {
  try {
    atomicWrite(SIGNAL_PATH, signal);
  } catch (err) {
    log(`Failed to write signal file: ${err.message}`);
  }
}

function unreadTotal() {
  try {
    return JSON.parse(fs.readFileSync(SIGNAL_PATH, 'utf8')).total_unread || 0;
  } catch {
    return 0;
  }
}

function handleStatus() {
  return {
    ok: true,
    pid: process.pid,
    uptime: daemonStartTime ? Math.floor((Date.now() - daemonStartTime) / 1000) : 0,
    accounts: loadMailAccounts().length,
    unread: unreadTotal(),
    polling: pollInterval !== null,
    lastPoll: lastPollTime,
  };
}

// ---------------------------------------------------------------------------
// Inbox polling
// ---------------------------------------------------------------------------

function startPolling() {
  if (pollInterval) return;
  log('Starting inbox polling');
  // Poll immediately on start
  pollAllAccounts().catch((err) => {
    log(`Initial poll failed: ${err.message}`);
  });
  pollInterval = setInterval(async () => {
    try {
      await pollAllAccounts();
    } catch (err) {
      log(`Poll cycle failed: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    log('Stopped inbox polling');
  }
}

async function pollAllAccounts() {
  const accounts = loadMailAccounts();
  if (accounts.length === 0) return;

  const signal = {
    accounts: {},
    total_unread: 0,
    updated: new Date().toISOString(),
  };

  for (const account of accounts) {
    try {
      const baseUrl = account.baseUrl || DEFAULT_API;
      const url = `${baseUrl}/api/v1/mail/messages?unread=true&limit=1`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${account.apiKey}` },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        log(`Poll ${account.address}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      if (data.ok) {
        const unread = data.data?.unread || 0;
        const latest = data.data?.messages?.[0];
        signal.accounts[account.address] = {
          unread,
          latest: latest
            ? { from: latest.from_address, subject: latest.subject }
            : null,
        };
        signal.total_unread += unread;
      }
    } catch (err) {
      log(`Poll ${account.address}: ${err.message}`);
    }
  }

  writeSignalFile(signal);
  lastPollTime = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// IPC request dispatcher (daemon side)
// ---------------------------------------------------------------------------

async function handleIpcRequest(client, line) {
  try {
    const req = JSON.parse(line);
    let result;

    switch (req.cmd) {
      case 'status':
        result = handleStatus();
        break;
      case 'stop':
        result = { ok: true };
        client.write(JSON.stringify(result) + '\n');
        setTimeout(() => shutdown(), 100);
        return; // Don't write twice
      default:
        result = { ok: false, error: `Unknown command: ${req.cmd}` };
    }

    client.write(JSON.stringify(result) + '\n');
  } catch (err) {
    try {
      client.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    } catch {
      // Client may have disconnected
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

async function runDaemon() {
  ensureLensDir();

  // Check for stale PID
  if (fs.existsSync(PID_PATH)) {
    try {
      const existingPid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
      if (isProcessRunning(existingPid)) {
        console.error(`Daemon already running (PID ${existingPid})`);
        process.exit(1);
      }
      // Stale PID file — clean up
      fs.unlinkSync(PID_PATH);
    } catch {
      // Corrupted PID file — remove it
      try { fs.unlinkSync(PID_PATH); } catch {}
    }
  }

  // Write our PID
  fs.writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
  daemonStartTime = Date.now();

  // Clean up stale socket
  if (fs.existsSync(SOCK_PATH)) {
    try { fs.unlinkSync(SOCK_PATH); } catch {}
  }

  // Start IPC server
  const server = net.createServer((client) => {
    let buffer = '';

    client.on('data', (data) => {
      buffer += data.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) {
          handleIpcRequest(client, line);
        }
      }
    });

    client.on('error', (err) => {
      log(`IPC client error: ${err.message}`);
    });
  });

  server.on('error', (err) => {
    log(`IPC server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      // Try to clean up and retry once
      try { fs.unlinkSync(SOCK_PATH); } catch {}
      server.listen(SOCK_PATH);
    }
  });

  server.listen(SOCK_PATH, () => {
    // Set socket permissions so only the user can connect
    try { fs.chmodSync(SOCK_PATH, 0o600); } catch {}
    log(`IPC server listening on ${SOCK_PATH}`);
  });

  // Start inbox polling if any accounts are configured
  const accounts = loadMailAccounts();
  if (accounts.length > 0) {
    startPolling();
  }

  // Auto-stop timer: the mail daemon only stays up while polling is configured.
  const autoStopCheck = setInterval(() => {
    if (pollInterval === null) {
      log('No polling configured. Auto-stopping daemon.');
      clearInterval(autoStopCheck);
      shutdown();
    }
  }, AUTO_STOP_INTERVAL_MS);
  autoStopCheck.unref(); // Don't keep process alive just for this

  // Graceful shutdown handlers
  process.on('SIGTERM', () => {
    log('Received SIGTERM');
    shutdown();
  });
  process.on('SIGINT', () => {
    log('Received SIGINT');
    shutdown();
  });
  process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err.message}\n${err.stack}`);
    shutdown();
  });
  process.on('unhandledRejection', (reason) => {
    log(`Unhandled rejection: ${reason}`);
  });

  log(`Daemon started (PID ${process.pid})`);
}

let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log('Shutting down daemon...');

  // Stop polling. There is nothing peer-to-peer to close.
  stopPolling();

  // Clean up files
  try { fs.unlinkSync(PID_PATH); } catch {}
  try { fs.unlinkSync(SOCK_PATH); } catch {}

  log('Daemon stopped');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Client API (used by CLI — these run in the CLI process, not the daemon)
// ---------------------------------------------------------------------------

function sendDaemonCommand(cmd) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCK_PATH);
    let buffer = '';
    let settled = false;

    function settle(fn) {
      if (!settled) {
        settled = true;
        fn();
      }
    }

    client.on('connect', () => {
      client.write(JSON.stringify(cmd) + '\n');
    });

    client.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        try {
          const response = JSON.parse(buffer.slice(0, idx));
          client.end();
          settle(() => {
            if (response.ok === false) {
              reject(new Error(response.error || 'Daemon returned error'));
            } else {
              resolve(response);
            }
          });
        } catch (err) {
          client.end();
          settle(() => reject(new Error(`Invalid daemon response: ${err.message}`)));
        }
      }
    });

    client.on('error', (err) => {
      settle(() => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new Error('Daemon not running'));
        } else {
          reject(new Error(`Daemon connection error: ${err.message} (${err.code})`));
        }
      });
    });

    client.on('close', () => {
      settle(() => reject(new Error('Daemon connection closed unexpectedly')));
    });

    client.setTimeout(CLIENT_TIMEOUT_MS, () => {
      client.destroy();
      settle(() => reject(new Error('Daemon timeout')));
    });
  });
}

function isDaemonRunning() {
  if (!fs.existsSync(PID_PATH)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
    return isProcessRunning(pid);
  } catch {
    return false;
  }
}

function startDaemon() {
  const { spawn } = require('child_process');
  const daemonPath = __filename;

  ensureLensDir();

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  return new Promise((resolve) => setTimeout(resolve, DAEMON_SETTLE_MS));
}

async function ensureDaemon() {
  if (isDaemonRunning()) return;
  await startDaemon();
  // Wait for socket to be ready
  await new Promise((resolve) => setTimeout(resolve, DAEMON_SOCKET_WAIT_MS));
  // Verify it's actually running now
  if (!isDaemonRunning()) {
    throw new Error('Failed to start daemon — check ~/.lens/mail-daemon.log for details');
  }
}

async function stopDaemon() {
  try {
    return await sendDaemonCommand({ cmd: 'stop' });
  } catch (err) {
    // If daemon isn't running, that's fine — the intent was to stop it
    if (err.message === 'Daemon not running') {
      // Clean up stale files
      try { fs.unlinkSync(PID_PATH); } catch {}
      try { fs.unlinkSync(SOCK_PATH); } catch {}
      return { ok: true, already_stopped: true };
    }
    throw err;
  }
}

async function getDaemonStatus() {
  try {
    return await sendDaemonCommand({ cmd: 'status' });
  } catch (err) {
    if (err.message === 'Daemon not running') {
      return { ok: true, running: false };
    }
    throw err;
  }
}

if (require.main === module) {
  runDaemon().catch((err) => {
    log(`Daemon failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  ensureDaemon,
  getDaemonStatus,
  isDaemonRunning,
  sendDaemonCommand,
  startDaemon,
  stopDaemon,
};
