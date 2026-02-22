"use strict";

const MIN_TEMP_TTL_SECONDS = 5 * 60;
const MAX_TEMP_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TEMP_TTL_SECONDS = 60 * 60;

function parseTemporaryTtl(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_TEMP_TTL_SECONDS;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`TTL must be between ${MIN_TEMP_TTL_SECONDS} seconds and ${MAX_TEMP_TTL_SECONDS} seconds`);
  }
  const match = String(value).trim().match(/^(\d+)(s|m|h|d)?$/i);
  if (!match) throw new Error("TTL must be a whole number of seconds or use s, m, h, or d (for example, 15m)");
  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[(match[2] || "s").toLowerCase()];
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds < MIN_TEMP_TTL_SECONDS || seconds > MAX_TEMP_TTL_SECONDS) {
    throw new Error(`TTL must be between ${MIN_TEMP_TTL_SECONDS} seconds and ${MAX_TEMP_TTL_SECONDS} seconds`);
  }
  return seconds;
}

module.exports = {
  DEFAULT_TEMP_TTL_SECONDS,
  MAX_TEMP_TTL_SECONDS,
  MIN_TEMP_TTL_SECONDS,
  parseTemporaryTtl,
};
