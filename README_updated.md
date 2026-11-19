# Invente25 Admin Backend — payment verification

This repository contains the payment-receipt verification slice of the
Invente backend. It uses the participant repository's PostgreSQL schema and
does not own that schema.

## Scope

Implemented here:

- Azure Blob Storage upload tickets for participant PDF receipts.
- Direct browser upload with a short-lived, single-blob SAS URL.
- Server-side Azure `HEAD`/`GetProperties` validation.
- Permanent public Azure URL generation for the participant repository's
  `ticket_payments.s3_url` column.
- Backend-issued staff JWT authentication with an approved-email signup allowlist.
- Volunteer accounts stored in the `verification` table.
- Volunteer queue, debounced search, status filter, payment detail, PDF
  display, and decision UI.
- Exact payment-ID conflict grouping with side-by-side receipt comparison,
  one-winner resolution, resolved history, and automatic rival rejection.
- Transactional `Accepted`/`Rejected` decisions with a verification log.
- Redis Streams payment OCR worker using Azure Document Intelligence.
- Indexed exact payment-ID search and guarded manual payment-ID entry/correction.

Not implemented in this repository:

- Participant registration, Razorpay integration, or the participant PATCH
  API.
- Redis stream production, ticket creation, QR generation, or participant email.
- Attendance changes.
- Database migrations.

The legacy unauthenticated OCR receipt routes are no longer mounted. New
participant uploads must use the Azure flow below.

The participant frontend and Redis stream producer remain separate systems.

## Database contract

The supplied `V1__Initial_schema.sql` is authoritative. This service uses
only its existing tables and columns, especially:

- `ticket_payments` — `ticket_id`, `ticket_type`, `amount_paid`, `s3_url`,
  `payment_id`, `status`, and timestamps.
- `users` — participant details.
- `ticket_event` and `events` — events associated with a payment.
- `hackathon_regs` and `hackathon_members` — hackathon team data.
- `verification` — volunteer signup records.
- `payment_verification_log` — accepted/rejected decision history.

Payment statuses are exactly the values in the schema:

```text
PendingPayment
NotVerified
Accepted
Rejected
```

The service never runs the files under `backend/migrations/`. Configure the
provided shared `DATABASE_URL` to a database where the participant schema has
already been installed.

## End-to-end flow

```text
Participant frontend
  │ POST upload URL with ticket_id, application/pdf, and file_size
  ▼
This backend ── checks ticket_payments ──► returns Azure SAS + public_url
  │
  ├── browser PUTs the PDF directly to Azure Blob Storage
  │
  ├── POST validation with upload_token
  │     └── this backend performs Azure HEAD/GetProperties
  │
  └── frontend PATCHes the participant repository with public_url
        └── participant repository owns s3_url and PendingPayment → NotVerified

Volunteer frontend
  │ shared staff JWT
  ▼
This backend ── direct database reads ──► queue/detail/PDF
  │
  └── PATCH decision ── transaction + FOR UPDATE ──► ticket_payments
                                      └────────────► payment_verification_log

Payment backend Redis stream
  │ invente:payments:node_ocr_stream
  ▼
OCR worker ── prebuilt-read(pdfUrl) ──► Azure Document Intelligence
  │
  └── guarded queued → pay_* update ──► ticket_payments.payment_id
```

This backend does not update `s3_url` or the participant status during the
upload flow. The participant frontend performs the agreed PATCH request to
the other repository after the validation endpoint succeeds.

## API

All endpoints below are mounted beneath `/organizers/api`.

### Participant receipt upload

These two endpoints are sessionless. The upload URL endpoint requires an
allowed browser `Origin`; it is not a participant login mechanism.

#### `POST /public/registrations/receipt-upload-url`

Request:

```json
{
  "ticket_id": "payment-ticket-uuid",
  "content_type": "application/pdf",
  "file_size": 123456
}
```

The ticket must exist in `ticket_payments` and currently be `PendingPayment` or
`NotVerified`. The backend returns:

```json
{
  "ticket_id": "payment-ticket-uuid",
  "upload_id": "random-upload-uuid",
  "object_key": "receipts/random-upload-uuid.pdf",
  "upload_url": "https://...signed-azure-url",
  "public_url": "https://.../receipts/random-upload-uuid.pdf",
  "upload_token": "signed-validation-token",
  "expires_at": "timestamp",
  "content_type": "application/pdf",
  "max_size_bytes": 5242880
}
```

The participant frontend must upload using `PUT` to `upload_url` with:

```text
x-ms-blob-type: BlockBlob
Content-Type: application/pdf
```

#### `POST /public/registrations/receipt-upload/validate`

Request:

```json
{
  "upload_token": "signed-validation-token",
  "object_key": "receipts/random-upload-uuid.pdf"
}
```

The backend performs an Azure blob properties request and accepts the object
only when it exists, has `Content-Type: application/pdf`, starts with the PDF
signature `%PDF-`, and is larger than zero bytes and at most 5 MiB. Only after
a successful response should the frontend PATCH the other repository with
the returned `public_url`.

The upload endpoints do not write `ticket_payments.s3_url`; that column is
written by the participant repository's API.

### Staff authentication

The backend issues the staff access token. Signup is sessionless and is
allowed only for emails listed in the required `APPROVED_VOLUNTEER_EMAILS`
environment variable. Set it to a comma-separated list of email strings; add
or remove addresses in the environment and restart the backend for the change
to take effect. The user supplies their name, optional department, and real
password; the backend stores only the bcrypt password hash in `verification`,
generates the `volunteer_id`, and returns the access token.

```text
APPROVED_VOLUNTEER_EMAILS=volunteer1@ssn.edu.in,volunteer2@ssn.edu.in
```

```text
POST /auth/signup
POST /auth/login
```

Signup request:

```json
{
  "email": "volunteer@ssn.edu.in",
  "password": "a-real-user-entered-password",
  "name": "Volunteer Name",
  "dept": "CSE"
}
```

Both successful signup and login return a backend-issued access token. The
token subject is `staff:<verification.volunteer_id>`.

### Volunteer receipt review

All review endpoints require a backend-issued staff access JWT and a matching
account in `verification`.

```text
GET   /receipt-review/volunteers/me
GET   /receipt-review/submissions
PATCH /receipt-review/submissions/:ticketId/payment-id
PATCH /receipt-review/submissions/:ticketId/decision
GET   /receipt-review/conflicts
GET   /receipt-review/conflicts/:paymentId
PATCH /receipt-review/conflicts/:paymentId/decision
```

`GET /volunteers/me` returns the account represented by the JWT. Signup is
handled at `/auth/signup`, before a token exists; there is no second signup
flow inside the receipt-review page.

List query parameters:

```text
status=all|PendingPayment|NotVerified|Accepted|Rejected
search=<ticket id, complete payment ID, participant name/email, or hackathon team>
page=1
page_size=25
```

The default status is `all`, so `PendingPayment` is visible in the queue.

Decision request:

```json
{
  "status": "Accepted"
}
```

or:

```json
{
  "status": "Rejected"
}
```

Only `NotVerified` payments can be decided. The decision transaction locks
the payment row with `FOR UPDATE`, updates `ticket_payments`, and inserts a
row into `payment_verification_log` using the registered volunteer UUID. A
second concurrent decision receives a conflict after the first transaction
commits.

An `Accepted` decision additionally requires a valid `payment_id`. While a
payment is `NotVerified` and has a receipt URL, volunteers can enter or correct
a strict Razorpay ID through:

```text
PATCH /receipt-review/submissions/:ticketId/payment-id
```

Request:

```json
{
  "payment_id": "pay_1234567890ABCD"
}
```

The write locks the payment row and only updates the same `NotVerified` ticket
that was read before the transaction, so an edit cannot overwrite a concurrent
change. If the replacement ID is already assigned to another ticket, the
request is rejected and the conflicting ticket ID is returned.
Exact `pay_` searches use the existing payment-ID B-tree index; other search
terms retain the general case-insensitive search.

### Payment-ID conflicts

The conflict list is grouped and paginated in PostgreSQL; the frontend never
loads the complete payment table to find duplicates. A conflict is two or more
rows with the same exact, case-sensitive valid `pay_` ID.

```text
GET /receipt-review/conflicts?state=unresolved|resolved&search=&page=1&page_size=25
GET /receipt-review/conflicts/:paymentId
```

Opening a group loads only that payment ID's submissions and returns their
participant/event details, audit history, and PDF URLs. The volunteer resolves
the group with:

```text
PATCH /receipt-review/conflicts/:paymentId/decision
```

```json
{
  "winner_ticket_id": "payment-ticket-uuid"
}
```

The transaction accepts the selected `NotVerified` row and rejects every other
undecided candidate. If one candidate was already Accepted, it is the locked
winner and confirming the group rejects only its undecided rivals. Each changed
row receives its own verification-log entry. Missing receipt URLs and invalid
historical states are displayed but cannot be resolved.

Conflict resolution, manual payment-ID entry, OCR writes, and ordinary receipt
decisions share a transaction-level PostgreSQL advisory lock derived from the
exact payment ID. This keeps group validation and updates atomic without a new
table or schema migration. Individual decisions on unresolved duplicate groups
return `CONFLICT_REVIEW_REQUIRED` and must be completed in the comparison UI.

Rejected rivals use the existing `Rejected` status; the participant backend's
existing rejection poller remains responsible for sending emails.

## Payment OCR worker

Run the standalone worker with:

```text
npm run worker:ocr
```

It consumes `invente:payments:node_ocr_stream` through consumer group
`node-service-group`. Each entry must contain `ticket_id`, `pdfUrl`, and
`action_type=ocr`. Only `NotVerified` rows whose payment ID is exactly
`queued` are submitted to Azure's `prebuilt-read` model. Each entry is
acknowledged after its terminal outcome; failed OCR remains `queued` for
manual entry. Stale pending entries become claimable after 30 minutes. Every
running worker instance must receive a distinct `OCR_CONSUMER_NAME` from its
deployment configuration.

The external producer must commit `payment_id='queued'` before publishing,
publish one stream entry per ticket with the exact field names above, and keep
`pdfUrl` publicly readable until Azure finishes. Stream retention remains the
producer/Redis deployment's responsibility; this worker acknowledges terminal
failures but does not delete entries, retry OCR, or publish to a dead-letter
stream.

Every JWT role with a non-empty `roles` claim can view and decide receipts, as
requested. The frontend does not replace backend authorization.

## JWT

The review middleware validates the agreed staff access token:

```json
{
  "iss": "invente-auth",
  "aud": ["invente-admin-api", "invente-review-api"],
  "sub": "staff:8f3b2b1e-7d4f-4d8a-a6f1-123456789abc",
  "jti": "unique-token-id",
  "token_type": "access",
  "email": "volunteer@ssn.edu.in",
  "primary_role": "volunteer",
  "roles": ["volunteer", "receipt_read_write"],
  "permissions": ["receipts:read", "receipts:review", "registrations:onspot:create"],
  "department_ids": [],
  "event_ids": [],
  "iat": 1788336000,
  "nbf": 1788336000,
  "exp": 1788336900
}
```

The backend signs with RS256 using `JWT_PRIVATE_KEY`. It verifies its own
tokens with `JWT_PUBLIC_KEY` when supplied, or derives the public key from the
private key. It validates issuer, audience, algorithm, time claims,
`token_type`, the `staff:<uuid>` subject format, and a non-empty roles array.
Receipt access is derived from the presence of a staff role; the token's
permission list is not used to grant access.

## Configuration

Required backend environment variables:

```text
DATABASE_URL
JWT_PRIVATE_KEY                # RSA PEM; literal \n is accepted in an env value
```

The standalone OCR worker additionally requires:

```text
REDIS_HOST
REDIS_PORT
REDIS_PASSWORD
OCR_CONSUMER_NAME
DOCUMENT_INTELLIGENCE_ENDPOINT
DOCUMENT_INTELLIGENCE_API_KEY
```

For local development and Docker Compose, put these values in
backend/.env (copy backend/.env.example first). Compose loads that file
directly; do not rely on ${JWT_PRIVATE_KEY} interpolation from a separate
root .env. Generate a development key with:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 |
  awk 'NF { printf "%s\\n", $0 }'
```

Optional public-key configuration:

```text
JWT_PUBLIC_KEY                 # RSA PEM; derived from JWT_PRIVATE_KEY if omitted
```

Staff JWT settings:

```text
JWT_ISSUER                     # defaults to invente-auth
JWT_AUDIENCES                  # comma-separated; defaults to both agreed audiences
JWT_ACCESS_TTL_SECONDS         # defaults to 864000 (10 days); allowed range 60–864000
TZ                             # backend timezone; defaults to Asia/Kolkata
APPROVED_VOLUNTEER_EMAILS      # required comma-separated volunteer signup allowlist
```

Azure can be configured with either a connection string or account details:

```text
AZURE_STORAGE_CONNECTION_STRING
```

or:

```text
AZURE_STORAGE_ACCOUNT_NAME
AZURE_STORAGE_ACCOUNT_KEY
```

Storage and upload settings:

```text
AZURE_STORAGE_CONTAINER_NAME
AZURE_PUBLIC_BASE_URL           # URL prefix before the object key; defaults to account/container
AZURE_STORAGE_BLOB_ENDPOINT     # optional; defaults to account blob endpoint
AZURE_UPLOAD_TOKEN_SECRET
AZURE_SAS_EXPIRY_SECONDS        # defaults to 900; allowed range 60–604800
AZURE_RECEIPT_PREFIX            # defaults to receipts
UPLOAD_ALLOWED_ORIGINS          # comma-separated exact frontend origins
LEGACY_ATTENDANCE_JOBS_ENABLED  # leave false until attendance is resumed
```

The Azure container must be configured for anonymous public blob read access
if the permanent `public_url` is expected to render without a read SAS. Azure
Blob CORS must also allow the participant frontend to issue the direct PUT.

## Upload security boundary

The backend never sends Azure credentials to either frontend. Each upload URL
is scoped to one random object key, grants only create/write permissions, and
expires quickly. The backend checks an exact configured `Origin` before
issuing or validating an upload ticket.

A browser `Origin` check and a bearer SAS cannot cryptographically prove that
the request came from one particular frontend: a holder of a still-valid SAS
can reuse it. Keeping the SAS short-lived, random, single-blob, and write-only
is the practical control for a direct-browser-upload design. Public read URLs
also mean that anyone who obtains a URL can read that PDF; this is inherent in
the permanent public URL requirement.

## Development and verification

```bash
cd backend && npm ci && npm start
cd frontend && npm ci && npm run dev
```

The backend start command no longer runs migrations. Use the externally
provided database endpoint and schema.

Checks:

```bash
cd backend
npm test
npm run worker:ocr                  # requires live worker configuration

cd ../frontend
npm run build
npx eslint src/pages/ReceiptReview.jsx
```

The repository's full frontend lint currently contains pre-existing errors in
unrelated legacy pages; the new receipt review page is lint-clean and the
production build completes successfully.
