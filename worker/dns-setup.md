# Lens Mail DNS and Email Routing setup

This guide is for a self-hosted deployment. Replace every `example.com` and
placeholder with a domain and Cloudflare resources you control. Do not copy
production credentials, account IDs, zone IDs, or records into tracked files.

## 1. Create the Cloudflare resources

Create a D1 database, an R2 bucket, and the inbound and outbound Queues in the
target Cloudflare account. Copy their IDs and names into a local ignored
`worker/wrangler.toml` based on [`wrangler.example.toml`](wrangler.example.toml)
from the repository root:

```bash
cp worker/wrangler.example.toml worker/wrangler.toml
```

Fill in the resource values, route, `DOMAIN`, `SEND_DOMAIN`, and send limits
before running any Worker command.

Apply the checked-in migrations to the intended database before deploying the
Worker. Store `ZEPTOMAIL_TOKEN` and `ADMIN_KEY` with Wrangler secrets rather
than in `wrangler.toml`.

## 2. Configure Email Routing

In the Cloudflare dashboard for the chosen zone, enable Email Routing and
configure the required MX records. Route the catch-all address for the domain
to the Lens Mail Worker. Follow Cloudflare's current Email Routing dashboard
instructions because the MX targets and verification records are supplied by
the account's configuration.

Keep the inbound route aligned with the Worker domain in `DOMAIN`. Verify that
the route accepts the addresses the Worker provisions before relying on the
mailbox for an account-recovery or verification flow.

## 3. Configure sending authentication

Configure the sender provider named by the Worker and publish the provider's
current SPF and DKIM records for `SEND_DOMAIN`. Add a DMARC policy appropriate
for the domain and monitor its reports before tightening enforcement. Do not
reuse records from another account or provider.

## 4. Configure the API route

The Worker serves mail requests under:

```
api.example.com/api/v1/mail/*
```

If the hostname is dedicated to this Worker, configure it as a Custom Domain.
If the hostname already belongs to another Worker, do not add a second Custom
Domain or override its origin; use a path route under the existing hostname or
choose a separate hostname that you control. Keep the route in the local
`wrangler.toml` aligned with the deployed zone and hostname.

## 5. Deploy and verify

Run these commands only after reviewing the target account and resource names:

```bash
npm install
npm run typecheck:worker
npm run dry-run:worker
npm run migrate:worker:incremental:remote
npm run deploy:worker
```

Then verify health and a disposable mailbox against the deployed API:

```bash
curl -fsS https://api.example.com/health
lens-mail setup --name smoke-agent
lens-mail whoami
```

Do not use a production mailbox for an unverified deployment. Confirm inbound
delivery and outbound provider delivery separately, and remove disposable
test data when the smoke test is complete.
