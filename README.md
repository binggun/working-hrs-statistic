# Pawhub

Express.js / PostgreSQL API and a React + Tabler desktop manager website with teal styling. Website supports monthly queries, confirmed hours, PDF export, attendance history, time corrections, validation, shops, people and email invitations.

## Local development

Requires Node.js 24 LTS and PostgreSQL 17 (or Docker for the database).

```bash
npm ci
# Choose a local-only password. Compose requires it rather than embedding one.
export POSTGRES_PASSWORD='your-local-password'
docker compose up -d db
cp server/.env.example server/.env
# Edit DATABASE_URL, WEB_ORIGIN=http://localhost:5173 and MAIL_ENCRYPTION_KEY.
cd server
npm run migrate
# Set ADMIN_EMAIL / ADMIN_PASSWORD in .env for the one-time owner bootstrap.
npm run bootstrap
npm run dev
```

In another terminal, from the repository root run `npm run dev:web`. API default port is 3000 and website development port is 5173. Use the existing checkout; no worktree is needed.

Create a shop as Owner, then create groomers/managers and assign shops. Owner and manager login use email; App users use four-digit IDs. Groomer activation and reset links open the static website's password page. Links are seven-day, single-use; production activation requires SES and the encryption key. Accounts remain pending until the user sets a password. No automatic demo accounts are created.

`npm run build` creates static files under `web/dist`; `VITE_API_URL` is public build-time configuration, never put AWS keys there.

## Tests

`npm test` runs pure date/calculation tests; integration is skipped unless `TEST_DATABASE_URL` points to a dedicated disposable database with a name ending `_test`. Do not use a live database: integration truncates test tables and creates test accounts and attendance. To run the full suite:

```bash
# Create a separate pawhub_test database, with credentials you control.
export TEST_DATABASE_URL='postgresql://.../pawhub_test'
# 64 hexadecimal characters, set securely without committing a value.
export MAIL_ENCRYPTION_KEY='...'
npm run migrate -w server
npm test
```

Tests exercise real PostgreSQL and HTTP: permissions, late attendance approval, rejected adjustments, immutable originals, two-place hour calculations, single-use activation, cross-shop / cross-midnight errors, and PDF output. SES/S3 calls need an AWS staging configuration and are not simulated as successful cloud delivery.

Desktop browser smoke test (Chromium installed, API and website running):

```bash
# Use a local/test owner account; never commit these values.
BROWSER_EMAIL=... BROWSER_PASSWORD=... node tests/browser-smoke.mjs
```

Set CHROMIUM_PATH if Chromium is installed elsewhere. It checks login, month filtering, navigation, PDF download and logout, and fails on browser runtime errors.

## AWS deployment: EC2 + S3

### API and database on Ubuntu EC2

1. Use Ubuntu 24.04, Node.js 24 LTS, PostgreSQL 17, Nginx and Certbot. Start with 2 GB RAM. Bind PostgreSQL to localhost; EC2 security group exposes HTTPS and SSH restricted to your IP, never 5432/3000 to the Internet.
2. Create a dedicated `pawhub` OS user, PostgreSQL role and `pawhub` database. Create the database password securely, URL-encode it in DATABASE_URL. Install Node from its official supported distribution, preserving signature/TLS verification.
3. Copy this checkout to `/opt/pawhub`, install using `npm ci --omit=dev`. Put runtime settings from `server/.env.example` in `/etc/pawhub/server.env`, readable only by root and the pawhub service group. Create `/var/lib/pawhub` owned by pawhub. No secrets in Git or S3 website files.
4. From `/opt/pawhub/server`, load the environment securely and run `npm run migrate`, then `npm run bootstrap` once. Remove ADMIN_PASSWORD from normal runtime settings afterwards. Migrations preserve existing data and record their applied version.
5. Install `deploy/pawhub.service` into `/etc/systemd/system/`, verify the Node path, then `sudo systemctl daemon-reload` and `sudo systemctl enable --now pawhub`. Inspect `journalctl -u pawhub` for failures.
6. Use `deploy/nginx.conf`, replacing the API hostname. Verify `sudo nginx -t`, then use Certbot to obtain HTTPS for that hostname and redirect HTTP to HTTPS. Set `TRUST_PROXY=1` only when the API is accessible solely through the trusted local Nginx proxy.
7. Check `/api/v1/health`, sign in, create a shop/person, and exercise monthly queries/validation before accepting real records.

### Static manager site on S3 / CloudFront

Use a dedicated **private website bucket**, CloudFront with Origin Access Control, HTTPS and `index.html` as the default root object. Do not use an HTTP-only S3 website endpoint with a production login page. SPA navigation is in-app, invitations use a URL fragment and root index, so no arbitrary path fallback is required.

Set the API's WEB_ORIGIN to the actual CloudFront/custom website HTTPS origin. Build using that API origin:

```bash
export VITE_API_URL='https://api.your-domain.example'
export WEB_BUCKET='your-private-website-bucket'
export CLOUDFRONT_DISTRIBUTION_ID='your-distribution-id'
bash deploy/publish-web.sh
```

This script uploads static files and optionally invalidates CloudFront. It does not create AWS infrastructure, alter bucket policies or delete existing objects. Execute it yourself with your authorized AWS profile after reviewing the build.

### Photos and invitations

Use a separate private S3 photo bucket, Block Public Access enabled. Set PHOTO_BUCKET and AWS_REGION on EC2. Use an EC2 IAM instance role with narrowly scoped `s3:PutObject` / `s3:GetObject` on the photo prefix and SES send permission for your verified sender; never expose AWS credentials in the browser. No public photo access or S3 browser uploads are needed.

Verify MAIL_FROM in SES. If SES is in sandbox, also verify recipients or request production access. Set MAIL_ENCRYPTION_KEY to 32 cryptographically random bytes encoded as 64 hex characters and back it up securely: changing it without migrating queued encrypted invitations prevents delivery. WEBSITE origin must be HTTPS in production. The API processes queued invitations approximately every minute with retry leases. SENT means SES accepted the email, not guaranteed inbox delivery. AWS delivery/permissions must be checked in your AWS account.

### Backups

Schedule `deploy/backup.sh` daily using a protected environment file and an EC2 role allowed to write a dedicated private backup bucket. Enable S3 versioning/lifecycle and test restoring a dump to a separate database. Do not rely solely on the EC2 disk. Daily schedules and retention should be chosen explicitly.

## Current implementation limits

- Implemented first version, not a claim of a completed production rollout. AWS resources, HTTPS certificates, live S3 uploads and SES delivery have not been provisioned or validated by this repository.
- Staff timesheet scheduling and account/profile edit/deactivation UI are not implemented. PDF is a basic English report; custom layout, embedded multilingual font and automated timesheet email are future work.
- App photo endpoint accepts JPEG/PNG/WebP up to 5 MB. Retention automation, sophisticated offline clock trust/conflict resolution, and IT permissions are not implemented. Conflicting pending edits return 409 for explicit handling.
- Session duration defaults to 12 hours; website stores the bearer in sessionStorage, clears it on logout/401, and does not promise persistent sign-in across browser restarts.

See [API design](docs/api-design.md), [database design](docs/database-design.md) and [product design](docs/product-design.md) for the broader design. Implemented endpoints are source-of-truth for current capabilities; documented proposals do not automatically mean implemented functionality.
