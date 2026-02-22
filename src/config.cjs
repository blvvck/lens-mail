"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_MAIL_API = "https://api.lenscli.com";
const MAIL_CONFIG_PATH = path.join(os.homedir(), ".lens", "mail.json");
const MAIL_PROFILES_DIR = path.join(os.homedir(), ".lens", "mail-profiles");
const MAIL_BOOL_FLAGS = ["pretty", "unread", "raw", "attachments", "has-code", "has-attachment", "all", "live", "follow", "json", "full"];

function getMailBaseUrl(env = process.env) {
  return env.LENS_MAIL_API || DEFAULT_MAIL_API;
}

function parseMailFlags(rawArgs) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (MAIL_BOOL_FLAGS.includes(key)) {
        flags[key] = true;
      } else if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith("--")) {
        flags[key] = rawArgs[++i];
      } else {
        flags[key] = true;
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function loadMailConfig(overrides = {}) {
  const fsRef = overrides.fsRef || fs;
  const configPath = overrides.mailConfigPath || MAIL_CONFIG_PATH;
  try {
    return JSON.parse(fsRef.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function saveMailConfig(config, overrides = {}) {
  const fsRef = overrides.fsRef || fs;
  const pathRef = overrides.pathRef || path;
  const osRef = overrides.osRef || os;
  const configPath = overrides.mailConfigPath || MAIL_CONFIG_PATH;
  const dir = pathRef.join(osRef.homedir(), ".lens");
  if (!fsRef.existsSync(dir)) fsRef.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsRef.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function saveMailProfile(name, config, overrides = {}) {
  const fsRef = overrides.fsRef || fs;
  const pathRef = overrides.pathRef || path;
  const profilesDir = overrides.mailProfilesDir || MAIL_PROFILES_DIR;
  if (!fsRef.existsSync(profilesDir)) fsRef.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  const profilePath = pathRef.join(profilesDir, `${name}.json`);
  fsRef.writeFileSync(profilePath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function loadMailProfile(addressOrName, overrides = {}) {
  const fsRef = overrides.fsRef || fs;
  const pathRef = overrides.pathRef || path;
  const profilesDir = overrides.mailProfilesDir || MAIL_PROFILES_DIR;
  const name = addressOrName.includes("@") ? addressOrName.split("@")[0] : addressOrName;
  const profilePath = pathRef.join(profilesDir, `${name}.json`);
  try {
    return JSON.parse(fsRef.readFileSync(profilePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveMailIdentity(flags, overrides = {}) {
  const env = overrides.env || process.env;
  const processRef = overrides.processRef || process;
  const consoleRef = overrides.consoleRef || console;
  const getBaseUrl = overrides.getMailBaseUrl || getMailBaseUrl;
  const loadProfile = overrides.loadMailProfile || ((addressOrName) => loadMailProfile(addressOrName, overrides));
  const loadConfig = overrides.loadMailConfig || (() => loadMailConfig(overrides));
  const profilesDir = overrides.mailProfilesDir || MAIL_PROFILES_DIR;

  const envKey = env.LENS_MAIL_KEY;
  if (envKey) {
    return { apiKey: envKey, address: "(env override)", baseUrl: getBaseUrl(env), source: "env" };
  }

  if (flags.as) {
    const profile = loadProfile(flags.as);
    if (profile) return { ...profile, source: "profile" };
    const config = loadConfig();
    if (config && config.address === flags.as) return { ...config, source: "default" };
    consoleRef.error(`Error: No mail profile found for "${flags.as}"`);
    consoleRef.error(`Profiles directory: ${profilesDir}`);
    processRef.exit(2);
    return null;
  }

  const config = loadConfig();
  if (config) return { ...config, source: "default" };
  return null;
}

function checkMailPermissions(overrides = {}) {
  const fsRef = overrides.fsRef || fs;
  const processRef = overrides.processRef || process;
  const configPath = overrides.mailConfigPath || MAIL_CONFIG_PATH;
  const profilesDir = overrides.mailProfilesDir || MAIL_PROFILES_DIR;

  try {
    const stat = fsRef.statSync(configPath);
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      const octal = "0" + mode.toString(8);
      processRef.stderr.write(
        `\x1b[33mWarning: ${configPath} has permissions ${octal} (group/world accessible)\x1b[0m\n` +
        `Run: chmod 600 ${configPath}\n`,
      );
    }
  } catch {
    // File doesn't exist yet.
  }

  if (fsRef.existsSync(profilesDir)) {
    try {
      const entries = fsRef.readdirSync(profilesDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const profilePath = path.join(profilesDir, entry);
        const stat = fsRef.statSync(profilePath);
        const mode = stat.mode & 0o777;
        if (mode & 0o077) {
          const octal = "0" + mode.toString(8);
          processRef.stderr.write(
            `\x1b[33mWarning: ${profilePath} has permissions ${octal} (group/world accessible)\x1b[0m\n` +
            `Run: chmod 600 ${profilePath}\n`,
          );
        }
      }
    } catch {}
  }
}

module.exports = {
  DEFAULT_MAIL_API,
  MAIL_BOOL_FLAGS,
  MAIL_CONFIG_PATH,
  MAIL_PROFILES_DIR,
  checkMailPermissions,
  getMailBaseUrl,
  loadMailConfig,
  loadMailProfile,
  parseMailFlags,
  resolveMailIdentity,
  saveMailConfig,
  saveMailProfile,
};
