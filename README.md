# Lens Mail

Lens Mail gives an agent a real mailbox through a shell command. It provisions an address, reads and searches messages, extracts verification codes and links, sends mail, waits for incoming mail, and manages attachments. It works from any agent harness that can run a CLI process, including Claude Code, Codex, Hermes, OpenCode, Aider, and similar tools.

## Install and set up

```bash
npm install -g @lens-cli/mail
lens-mail setup --name my-agent
lens-mail whoami
```

`setup` creates an address such as `my-agent@lenscli.com`, stores the API key in `~/.lens/mail.json` with mode `0600`, and saves a named profile. You can select a saved profile with `--as <name>`.

The hosted API is `https://api.lenscli.com`. Mail requests use `/api/v1/mail/*`; that path is routed to the Lens Mail Worker while the existing feedback API continues to use its own Worker on the same hostname. Set `LENS_MAIL_API` when developing against another deployment and `LENS_MAIL_KEY` when supplying a key without a saved config.

## Read and act on mail

```bash
lens-mail check --unread --pretty
lens-mail read MESSAGE_ID --pretty
lens-mail send person@example.com --subject "Build finished" --body "The build passed."
lens-mail wait --from alerts@example.com --subject "Deploy" --timeout 120
lens-mail search --q invoice --last 20
lens-mail code --pretty
lens-mail links --pretty
```

The default output is JSON for agents. `--pretty` writes a human-readable view to stderr where supported. `read --raw` includes message headers and `read --attachments` lists attachment metadata. Use `save MESSAGE_ID [filename] --out ./downloads` to download attachments.

## Organize and protect the inbox

```bash
lens-mail tag MESSAGE_ID receipts
lens-mail tags
lens-mail filter.add receipts --from "*@stripe.com" --subject "receipt*"
lens-mail thread MESSAGE_ID --full
lens-mail block sender@example.com "unwanted mail"
lens-mail quarantine
lens-mail release MESSAGE_ID
```

Owner verification is available for mailboxes that need a second trust signal:

```bash
lens-mail verify
lens-mail verify code
lens-mail verify remove
```

The daemon can poll for unread mail in the background:

```bash
lens-mail daemon start
lens-mail daemon status
lens-mail daemon logs
lens-mail daemon stop
```

Run `lens-mail --help` for the complete command list. The `otp` command is an alias for `code`, and `link` is an alias for `links`.

## Development

```bash
git clone https://github.com/blvvck/lens-mail
cd lens-mail
npm install
npm test
npm run typecheck:worker
npm run dry-run:worker
```

The root package is the publishable `@lens-cli/mail` CLI. The Cloudflare Worker lives in `worker/` and owns the D1, R2, Queue, Email Routing, and outbound provider bindings.

The CLI suite currently has 34 tests. The Worker has a typecheck and deployment dry-run; it does not yet have a Worker test file. `npm run test:worker` therefore reports that no Worker tests exist, while `npm run test:all` remains red until that suite is added.

For a local Worker:

```bash
npm run dev:worker
```

For an existing D1 database, apply incremental migrations before deploying:

```bash
npm run migrate:worker:incremental:remote
npm run deploy:worker
```

To self-host, copy `worker/wrangler.example.toml` to `worker/wrangler.toml`, fill in your Cloudflare resource values, and follow [`worker/dns-setup.md`](worker/dns-setup.md). See [`worker/AGENT_SECURITY.md`](worker/AGENT_SECURITY.md) for limits and inbound-mail handling.

## License

MIT. See [LICENSE](LICENSE).
