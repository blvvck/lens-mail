"use strict";

// Public surface for other packages: identity, transport and the command dispatch.
// @lens-cli/room uses the identity and client; nothing here depends on the CLI.

const config = require("./config.cjs");
const client = require("./client.cjs");
const dispatch = require("./dispatch.cjs");

module.exports = { ...config, ...client, ...dispatch };
