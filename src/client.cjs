"use strict";

const http = require("http");
const https = require("https");
const { getMailBaseUrl } = require("./config.cjs");

function requestJson(method, apiPath, body, apiKey, overrides = {}) {
  return new Promise((resolve, reject) => {
    const baseUrl = overrides.baseUrl || getMailBaseUrl(overrides.env || process.env);
    const fullUrl = new URL(apiPath, baseUrl);
    const isHttps = fullUrl.protocol === "https:";
    const lib = isHttps ? (overrides.httpsLib || https) : (overrides.httpLib || http);
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const options = {
      method,
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      headers,
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(overrides.timeoutMs || 30000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

module.exports = {
  mailRequest: requestJson,
};
