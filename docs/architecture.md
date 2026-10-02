# Architecture

`/defN` identifies a global function. Its public response includes only active, non-expired variants belonging to active author profiles. Missing variants are omitted, rather than rendered as empty accordion rows. Unknown, disabled and deleted functions return HTTP 404. Root and arbitrary paths remain HTTP 404. Public HTML and GET /api/entry/:slug require no authentication.

Profiles contain only a name, visibility flag and timestamps. They have no passwords, roles or sessions. Each variant references a function and profile; UNIQUE(profile_id,function_id) ensures one variant per author per function. Function numbers are allocated by atomically updating a singleton counter inside the same transaction as the insert and audit. Numbers are not reused after deletion.

The singleton admins record stores the bcrypt hash of the shared admin password. Opaque server-side sessions, HttpOnly/Secure/SameSite cookies, CSRF tokens, exact Origin checks and PostgreSQL-backed rate limits protect mutations. Password rotation revokes admin sessions. API action endpoints never allow anonymous writes. SQL is parameterized through Drizzle. Code is displayed as escaped text in native details/summary accordions. Copy and word-wrap controls work independently for each variant.

Migration 0002 preserves user names, code, IDs, timestamps, active flags and expiry dates. Entries with the same defN become variants of one global function. It preserves the earliest admin hash, drops user passwords and invalidates all sessions. Audit metadata remains; text and credentials are never logged. On new installations migrations 0001 and 0002 run before the singleton admin seed.

ADMIN_PATH controls the protected administration route; ADMIN_PASSWORD seeds the shared password only if no admin exists. ADMIN_USERNAME is obsolete. Docker Compose keeps PostgreSQL private and publishes the application on loopback for HTTPS reverse proxying. TRUST_PROXY requires a proxy which overwrites X-Forwarded-For. Public code must not be treated as confidential; its visibility is intentional in this version.
