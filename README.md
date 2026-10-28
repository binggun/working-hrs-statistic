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

Create people independently of shops. Groomers are not linked to shops; managers can view the shared groomer directory and manage groomer invitations. Accounts can be created and invited before any shops exist. Manager shop permissions still control attendance access. Create shops as Owner when needed. Owner and manager login use email; App users use four-digit IDs. All active shop accounts use the fixed login password `123456`; store creation does not require password setup. Existing shop passwords are no longer used. Employee and manager passwords are unchanged. Groomer activation and reset links open the static website's password page. Links are seven-day, single-use; production activation requires SMTP and the encryption key. Accounts remain pending until the user sets a password. No automatic demo accounts are created.

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

Personal employee accounts select a store, then query `/api/v1/attendance/status` for that store. The app shows separate Clock in and Clock out buttons; the user explicitly selects the type. Daily counts are informational and do not determine or restrict the selected type. Dates use Pacific/Auckland. First clock-in of the day retains the planned-start requirement.

The app uploads a JPEG selfie compressed to at most 100 KiB via multipart `/api/v1/photos`, then submits its photoId, employee ID, store ID, capture timestamp and the explicitly selected type to `/api/v1/attendance`. The server verifies identity and photo ownership while holding the worker lock. Optional expectedDailyCount checks remain supported for older clients, without a type parity restriction. Retrying an uncertain request reuses its operation IDs to prevent duplicate records.

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

Employee changes, manual additions and removal requests require manager approval. Manager time/type corrections take effect immediately and record an approval and audit entry. Existing pending changes must be resolved first. Migration 006 preserves original_sign_type while permitting corrections to the current sign_type; original times, photos and planned starts remain immutable.

New passwords for activation, password reset, password changes, shop accounts and administrator bootstrap accept 6–128 characters, with no required character classes. Existing passwords remain valid.

Employee attendance adjustments can request a new clock-in/out type as well as a time. Pending proposals retain the confirmed sign_type, expose pending_sign_type in employee queries, and store before_type/after_type in adjustment history. Approval updates sign_type and rebuilds hours; rejection leaves the confirmed type unchanged.

## Employee attendance email export

Android personal attendance queries offer Add record and Export side by side. Export submits the displayed record IDs and versions plus the queried store/date range to POST /api/v1/attendance/exports. The server validates ownership, range and versions, freezes a snapshot, and queues a PDF attachment to the authenticated account’s registered email; recipients cannot be overridden. Changed records return 409 for a fresh query. Retried requests reuse their operation ID.

Migration 007 creates attendance_export_jobs. The backend maintenance worker sends queued exports through the existing SMTP configuration, retries failures, and records SENT only after SMTP acceptance. Subjects follow `Pawhub [shop name] [yyyy-MM-dd or yyyy-MM-dd - yyyy-MM-dd] attendence record`. PDFs use Auckland time, ascending chronological order and the bundled Noto CJK font (license in server/assets/fonts/LICENSE). Integration tests use an injected local mail transport; they do not send real email.

Android New user opens a two-email registration dialog. POST /api/v1/auth/register validates matching emails, creates a pending WORKER account without an employee code, and queues the existing first-setup email. The emailed single-use link sets the password; self-registered workers remain PENDING until a manager approves activation in the worker directory. After setting a password they can sign in and view/update their profile, but attendance writes and photo uploads remain blocked until activation. Existing active/disabled accounts remain unchanged; requests return a generic acceptance response. Pending-account mail requests have a five-minute cooldown and the endpoint has an IP rate limit.

Migration 008 records self-registration activation requirements, approving manager and approval timestamp. Managers can approve a pending self-registered worker only after a password is set, through POST /api/v1/manager/accounts/:id/approve. Existing administrator-created invitation behavior is unchanged.

Migration 009 defers four-digit employee ID allocation for self-registered pending workers until manager approval. Approval allocates an unused code under the shared allocation lock and queues an encrypted ACCOUNT_APPROVED confirmation mail in the same transaction. The email contains activation confirmation and the employee ID, never the password. Existing pending self-registrations have their provisional codes cleared; active employee codes remain unchanged. Android refreshes its cached employee code when it checks approval status, so existing email-login sessions can start attendance after approval.

## Submitted records and final manager confirmation

Original app attendance is saved immediately as Submitted and does not create an approval request. Its baseline time is used for hour calculations; confirmed_occurred_at alone does not indicate manager approval. Migration 010 introduces manager_confirmed, backfilled from actual approved adjustments and approved removals, to distinguish manager-approved records from original submissions.

Manual additions, changes and removals still require approval. Before approval the employee may repeatedly change the record, including replacing a pending removal with an update. The same pending adjustment is updated in place, so the manager reviews only the final proposal; original evidence and audit events remain preserved. Record versions reject stale manager approvals. Pending removals remain visible to their employee until decided. Once approved, manager_confirmed is permanent for employee permissions: only manager endpoints may modify the record further. The Android and employee web screens disable employee actions on confirmed records; the API independently enforces this rule.

## People directory

People shows the Android profile fields: first name, last name, registered email, address, phone and preferred store, alongside employee ID and account status. Add person opens an invitation form; Edit uses profile version checks and synchronizes accounts/workers so the Android profile immediately reflects changes. Registered email stays read-only when editing. Managers manage employees; only the owner manages manager accounts. Existing activation approval and resend invitation actions remain available.

Delete requires an explicit dialog confirmation and disables the account instead of deleting account/attendance evidence. Sessions and unused password links are revoked, queued mail is cancelled, and pending attendance export delivery is stopped. Deleted accounts are hidden by default with a Show deleted accounts toggle. Migration 011 allows a disabled self-registration to retain a null employee ID.


## Company structure and permissions

Migration 012 adds an independent GENERAL_MANAGER account and manager-to-groomer assignments. Owner (SUPER_MANAGER) opens Company structure to appoint the single General manager. To initialize, create a Manager in People, have them set their password, then appoint them; appointment activates that account. Replacing the General manager demotes the previous one to Manager. Role changes revoke affected sessions.

Owner and General manager can assign Manager/Groomer roles and multiple stores and groomers to each Manager. Each store or groomer can belong to multiple managers. A Manager may read or change attendance and approve adjustments when either the store OR the groomer is assigned. Full store and personal profiles require their respective assignment. Minimal attendance selectors support attendance access without exposing unrelated profiles. Revoking permissions also prevents replaying previously generated reports.

All new Manager and Groomer accounts require General manager activation after password setup; only the General manager sees personnel approvals in Confirmations. Owner appoints the General manager but does not approve other personnel. Self-registered groomers receive their employee ID and confirmation email on approval. This supersedes the earlier manager activation rules. Existing managers retain store assignments; configure groomer assignments in Company structure as needed. Organization edits use version checks to prevent overwriting concurrent changes.


## Shared personal web workspace

Groomer login opens a personal workspace with Account settings and Attendance. Settings reuse Android profile/password endpoints: registered email is read-only, followed by name, address, phone and preferred store; passwords require at least six characters. English/Chinese selection lives in the shared Website settings page and is saved in this browser after confirmation. It is separate from account profile fields. Attendance defaults to the current Auckland calendar month with All stores selected and runs only after Search, supports store/date queries and queues the displayed records as a PDF to the registered email using the existing Android export flow.

Manager, General manager and Owner open the exact same components through My account & attendance and can return to Management. Migration 013 provisions personal worker identities for existing management accounts without allocating new employee codes or changing their roles; new management identities are provisioned on first personal attendance access. Personal routes enforce own-record access regardless of management role. Store choices for personal profiles do not grant store-management permissions. Existing management roles, scopes and approval policies remain in effect.


Daily hours in personal attendance and emailed PDFs use the same calculation. Records are grouped by Auckland date and sorted chronologically; effective pending changes are included and pending removals excluded, with totals marked pending approval. Each day must have an even count and chronologically ordered clock-in/clock-out pairs. Pair durations use elapsed time, round individually to two decimal hours and add integer hundredths. Invalid sequences show “Adjust attendance records” instead of a partial total. Query controls allow ranges of up to 31 days; changing controls clears previous results to keep exports aligned with the displayed query. Employees may edit both time and type; additions, changes and removals remain approval requests.

The daily-hours table and PDF end with total hours across the queried range. Valid pending proposals are included and labeled “Changes awaiting manager confirmation”; the same label appears on a provisional range total. If any day has invalid pairs, no complete range total is displayed until records are adjusted. Totals add rounded daily hundredths without floating-point accumulation.

Personal attendance queries and email exports accept an omitted/null shopId for all stores while retaining own-record scope. All-store rows and PDFs identify the store. Daily hours pair records within each store before adding the day total, preventing unrelated stores from completing each other’s incomplete pairs. Manual additions still require an explicit store.

Personal attendance PDF attachments use landscape A4 with tables matching the personal query view: daily hours and total, followed by store/type/original/current/confirmed/status details. Multi-page tables repeat headers and include page numbers; Chinese uses the bundled CJK font.


## Manager management workspace

Management navigation has four functional areas: Store management (assigned store profiles and search), Employee management (assigned groomer profiles, search and invitation delivery tab), Attendance management (records and monthly working-hours tabs) and Approvals (latest add/update/remove proposals with explicit request type). Personal account/attendance and Website settings reuse the shared personal components. Attendance records show original/current/confirmed timestamps, requested type and photos. Existing role and scope checks remain enforced on every API operation: attendance uses store OR groomer assignment, profile editing uses the respective assignment, and only General manager activates new personnel. Pending records must be resolved through Approvals before direct manager corrections.

All web roles now use WorkspaceLayout with a single shared sidebar. Attendance is the first feature for everyone; Groomer sees only that feature, while management features are added by role. Website settings, My account and Sign out are grouped at the bottom. Management no longer requires switching between separate personal and manager navigation templates.


Attendance starts with Staff. Groomers have a fixed own-account field and continue using own-only APIs. Managers select only groomers linked through manager_workers, defaulting to all such groomers; GM/Owner can select all groomers. Dedicated /manager/staff-attendance and /manager/staff-attendance/staff endpoints enforce this narrower staff relationship independently of store-based attendance-management permissions. Daily totals are calculated per employee/date and then summed. Staff exports include employee names in tables and are emailed to the requesting account; permissions are rechecked on request retries and before mail delivery. Store-only assignments do not add staff to this selector.

The sidebar now has one Attendance entry for all roles. Manager record actions, history, daily hours and the monthly-summary tab live under that entry; Attendance management is no longer a second sidebar destination. Validation queue remains directly below Attendance.

Sidebar order: Groomer — Attendance; Manager — Attendance, Validation queue; GM/Owner — Attendance, Validation queue, Employee, Shops, Structure. Website settings, My account and Sign out stay in the shared footer. This navigation arrangement does not change existing API authorization rules.

Employee codes retain the original 1000–9999 range, allocated randomly from unused codes. Migration 015 restores that constraint for Manager/GM after the temporary leading-zero allowance in 014. Store codes remain a separate 00xx range; uniqueness is enforced across all account codes.

Website business role labels are General manager, Manager and Groomer. The former Employee label in navigation, profile lists and account creation is now Groomer; Employee ID remains the existing numeric identifier field. Internal WORKER enum/API names remain compatible with Android and existing data.

Manager/GM/Owner attendance additions, changes and removals take effect immediately, with an approved history/audit entry and no pending validation item. The same rule applies to their own records through personal endpoints. Their own account appears in Staff; null-code management accounts use an authenticated self selector. Own records are permitted independently of store/groomer assignments. A direct manager change supersedes a pending employee proposal while retaining its rejected history. Groomer changes continue to require approval.

Attendance Staff and Shop filters support checkbox multi-selection; empty selection means all permitted values. Groomer Staff remains fixed to self. GET requests accept comma-separated workerIds/shopIds, exports accept arrays, and legacy scalar workerId/shopId remain supported for Android. Every selected staff identity is validated against the current scope before queries/exports; a mixed authorized/unauthorized selection is rejected in full. Work hours remain grouped by employee, date and store pairing.

Daily working-hour rows identify a single staff member, shop and Auckland date. View updates the staff/shop multi-selectors and both dates to that row and immediately queries its attendance records. Summaries and PDFs show a shop column to keep multi-shop drill-down unambiguous; total hours still sum all displayed rows.

GM and Owner have an Attendance GPS page immediately after Structure. GET /manager/attendance/locations enforces these roles server-side, accepts multi-staff/shop filters and a date range up to 31 days, and pages 100 results. Dates refer to the original GPS-bearing attendance event. Records without complete valid numeric GPS coordinates are included, with blank GPS, distance and accuracy cells. Distances prefer the saved event distance, otherwise use saved store coordinates or current store coordinates for legacy records. This view does not enable or require new GPS collection.

Missing clock-in/out issues in Validation queue now offer Review. The action opens Attendance and immediately queries the issue’s Auckland date, staff and shop, using the same selection helper as the daily-hours View button. An authorized single-shop review can resolve staff through store permission even when they are absent from the manager’s groomer assignments; ordinary all-staff selection is unchanged.


## Automatic photo retention

Migration 016 adds photo deletion timestamps and an expiry index. On backend startup and every 15 minutes, the retention worker deletes up to 200 READY photo files uploaded at least three calendar months ago (Pacific/Auckland). It supports private local files and S3 objects and catches up after restarts. File deletion succeeds before metadata is marked EXPIRED; failed deletions remain READY for retry. Missing local files count as already deleted. Per-photo locks prevent duplicate deletion by concurrent workers.

Attendance rows, immutable photo associations and adjustment history are retained. Each deletion creates PHOTO_EXPIRED audit evidence. Photo access returns 410 after expiry, and the web UI labels the photo expired. No attendance records are deleted by this process. S3 credentials must allow DeleteObject for the configured photo bucket. S3 object version retention, if enabled separately on the bucket, is governed by that bucket’s lifecycle configuration.

## Android App download page

The public page `/appdownload` and the shared Download Android App sidebar utility provide APK version, build date, size, SHA-256 and installation instructions. GET `/api/v1/downloads/android` returns available installer metadata; GET `/api/v1/downloads/android/apk?sha256=...` serves a hash-pinned APK with a friendly filename and Android package MIME type. No login is required to install the app.

Publish an existing Android build from the repository root:

```sh
node server/scripts/publish-android.mjs /app/PawhubSigninApp/app/build/outputs/apk/debug/app-debug.apk
```

The sibling `output-metadata.json` supplies actual version/build metadata. Published files are stored under ignored `server/data/downloads` (override with ANDROID_APK_DIR); metadata updates are atomic and existing hash-pinned download links remain valid. The currently published 1.0 APK is the existing debug/test build from 2026-10-25; this page does not rebuild Android sources automatically.
