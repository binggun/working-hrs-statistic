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

Create people independently of shops. Groomers are not linked to shops; managers can view the shared groomer directory and manage groomer invitations. Accounts can be created and invited before any shops exist. Manager shop permissions still control attendance access. Create shops as Owner when needed. Owner and manager login use email; App users use four-digit IDs. Groomer activation and reset links open the static website's password page. Links are seven-day, single-use; production activation requires SMTP and the encryption key. Accounts remain pending until the user sets a password. No automatic demo accounts are created.

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

Tests exercise real PostgreSQL and HTTP: permissions, late attendance approval, rejected adjustments, immutable originals, two-place hour calculations, single-use activation, cross-shop / cross-midnight errors, and PDF output. SMTP/S3 calls need mail-provider and AWS staging configuration and are not simulated as successful cloud delivery.

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

Use a separate private S3 photo bucket, Block Public Access enabled. Set PHOTO_BUCKET and AWS_REGION on EC2. Use an EC2 IAM instance role with narrowly scoped `s3:PutObject` / `s3:GetObject` on the photo prefix; never expose AWS credentials in the browser. No public photo access or S3 browser uploads are needed.

Configure SMTP in `server/.env`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM`. Use your provider's SMTP password or app password. Port 587 uses `SMTP_SECURE=false` with required STARTTLS; port 465 uses `SMTP_SECURE=true`. TLS certificate verification remains enabled. Keep credentials only on the backend. Restart the API after changing configuration.

Set `WEB_ORIGIN` to the frontend address recipients can open (`http://localhost:5173` for local development; HTTPS in production). Set MAIL_ENCRYPTION_KEY to 32 cryptographically random bytes encoded as 64 hex characters and back it up securely: changing it without migrating queued encrypted invitations prevents delivery. The API processes one queued invitation approximately every minute with retry leases and five-minute retries. SENT means the SMTP server accepted the email, not guaranteed inbox delivery. SMTP is disabled while `SMTP_HOST` is unset; existing queued messages remain queued.


### Backups

Schedule `deploy/backup.sh` daily using a protected environment file and an EC2 role allowed to write a dedicated private backup bucket. Enable S3 versioning/lifecycle and test restoring a dump to a separate database. Do not rely solely on the EC2 disk. Daily schedules and retention should be chosen explicitly.

## Current implementation limits

- Implemented first version, not a claim of a completed production rollout. AWS resources, HTTPS certificates, live S3 uploads and SMTP delivery have not been provisioned or validated by this repository.
- Staff timesheet scheduling and account/profile edit/deactivation UI are not implemented. PDF is a basic English report; custom layout, embedded multilingual font and automated timesheet email are future work.
- App photo endpoint accepts JPEG/PNG/WebP up to 5 MB. Retention automation, sophisticated offline clock trust/conflict resolution, and IT permissions are not implemented. Conflicting pending edits return 409 for explicit handling.
- Session duration defaults to 12 hours; website stores the bearer in sessionStorage, clears it on logout/401, and does not promise persistent sign-in across browser restarts.

See [API design](docs/api-design.md), [database design](docs/database-design.md) and [product design](docs/product-design.md) for the broader design. Implemented endpoints are source-of-truth for current capabilities; documented proposals do not automatically mean implemented functionality.

## Shop address lookup

The Shops form accepts a full street address including city and country. The API sends the address to Photon, resolves coordinates and saves both. Unmatched addresses return 422; unavailable services return 503 without creating a shop. Existing API clients may still supply both coordinates explicitly. Set `GEOCODING_URL` to a Photon-compatible endpoint to switch providers. The public demo is for moderate use and has no availability guarantee; use a private service for production volume. See [Photon documentation and usage limits](https://github.com/komoot/photon). Location data: [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).


## Employee website access

Employees sign into the same website using their registered email or four-digit employee ID and the same password as the Android app. Managers continue to use email. Password recovery accepts an employee ID or a registered employee/manager email and uses the shared email reset page.

The employee workspace shows only the signed-in employee's attendance, filtered by store and a date range of up to 31 days in Pacific/Auckland time. Employees can submit time changes for manager approval. Original and confirmed timestamps remain visible; pending or deleted records cannot be edited again. Employee sessions cannot access manager pages or other employees' records. Store accounts continue to use the Android app.


## Android attendance flow

Personal employee accounts select a store, then query `/api/v1/attendance/status` for that store. The response includes `dailyCount`: an even count means SIGN_IN; an odd count means SIGN_OUT. Counts exclude effectively deleted records and use Pacific/Auckland calendar dates. First clock-in of the day retains the planned-start requirement.

The app uploads a JPEG selfie compressed to at most 100 KiB via multipart `/api/v1/photos`, then submits its photoId, employee ID, store ID, capture timestamp and expectedDailyCount to `/api/v1/attendance`. The server verifies identity, photo ownership, date and count while holding the worker lock. Stale or concurrent submissions return 409 and require a status refresh. Retrying an uncertain request reuses its operation IDs to prevent duplicate records.

For local development, `PHOTO_STORAGE=local` stores private files under `server/data/photos` (ignored by Git). Preserve this directory with the project bind mount or a persistent volume. Local photo reads require the normal session and ownership/shop permission checks. Production S3 remains available using `PHOTO_STORAGE=s3` and existing PHOTO_BUCKET/AWS configuration.


Attendance GPS: the Android employee flow requests foreground precise location, obtains a current GPS fix, and uploads latitude, longitude, accuracyMeters and capturedAt with the attendance snapshot. If GPS is off, permission is unavailable, a fix times out, or coordinates are stale, attendance still proceeds with location.status=UNAVAILABLE and no latitude/longitude. Coordinates are stored in attendance_records.location along with server-calculated distance and IN_RANGE/OUT_OF_RANGE status. Retry preserves the original capture location.


## Account profile

Android account settings load GET /api/v1/me/profile and save POST /api/v1/me/profile. Registered email is read-only. First name, last name, address, phone and preferred store are saved atomically for the authenticated account. Worker directory name/contact/address stay in sync. Version checks prevent stale edits overwriting newer changes; operation IDs make retries idempotent. Migration 004 preserves existing display names without guessing a first/last-name split and copies existing worker contact details.


The shared /api/v1/auth/login endpoint accepts exactly one of email or accountId plus password. Employee emails are case-insensitive. Account role still controls all manager access; email login does not grant manager permissions. If identical email/password credentials match more than one active role, use the employee ID to disambiguate.


## Local Web API proxy

During Vite development, leave web/.env VITE_API_URL empty. The browser requests /api on the website origin and Vite forwards it to http://127.0.0.1:3000 inside Docker. This works from localhost or the Windows LAN IP without browser CORS requests to port 3000. PAWHUB_API_PROXY_TARGET can override the internal target. For static production hosting, explicitly set VITE_API_URL to the production HTTPS API before building, unless the hosting origin also proxies /api.


## Manual attendance and removal

Employee My attendance and manager Attendance records now offer Add attendance record (store, Auckland date/time, clock-in/out, and employee selection for managers) and Remove after Adjust. Removal requires an explicit confirmation dialog. These actions use the existing approval workflow and idempotent request IDs.

Migration 005 adds record_status, generated as active or removal from effective_deleted. No attendance row, original evidence or photo is physically deleted. Removal rows disappear from employee and normal manager lists; the super administrator list retains them with a Removal label and history. Rejecting removal restores active state; approving keeps the removal state. Pending records must be resolved before another adjustment. Manual additions have no selfie/GPS and remain pending approval. Manager additions/removals follow existing shop scope and retain the real actor in the adjustment/audit log.

All manual additions, time changes and removal requests—including requests submitted by managers—require an explicit manager approval decision. The legacy manager corrections endpoint also queues a pending adjustment; it no longer automatically approves a time change. Confirmed attendance and calculated confirmed hours only change after approval.
