# Invente25 payment-verification implementation plan

The current scope is the payment-verification slice only. The detailed,
implementation-aligned README is [README_updated.md](README_updated.md).

## Phases

1. Azure Blob setup: issue short-lived single-blob SAS upload URLs, return the
   permanent public URL, and validate the uploaded object with a server-side
   HEAD/GetProperties check. Accept PDFs up to 5 MiB only.
2. Staff authentication: allow only emails in the `APPROVED_VOLUNTEER_EMAILS`
   environment variable to sign up, store bcrypt password hashes in
   `verification`, generate each account's `volunteer_id`, and issue the agreed
   RS256 JWT. Derive receipt access from its roles.
3. Verification API: read the supplied schema directly, list all payment
   statuses with search/filter/pagination, show participant/team/event data
   and the public PDF URL, then transactionally record `Accepted` or `Rejected`
   decisions with `FOR UPDATE` and `payment_verification_log`.
4. Volunteer GUI: add backend-authenticated login/signup, queue, debounced
   search, all-status filtering, detail/PDF display, and decision controls.
5. Integration: configure the external database endpoint, Azure container,
   public URL, Azure CORS, allowed frontend origins, the staff JWT private
   key, and `APPROVED_VOLUNTEER_EMAILS`. The participant frontend performs the
   PATCH to its own repository after this backend validates the upload.

## Explicitly deferred

Participant registration and payment, the participant repository's PATCH API,
Redis workers, ticket/QR/email processing, attendance, and all migrations are
outside this repository's current implementation.
