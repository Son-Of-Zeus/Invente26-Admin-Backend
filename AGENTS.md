# Repository Guidelines

## Project Structure & Module Organization

The repo contains two Node.js applications:

- `backend/src/` contains the Express entrypoint, routes, scheduled jobs, database access, and utilities. Numbered SQL files in `backend/migrations/` run automatically at startup; `backend/config/` holds static configuration.
- `frontend/src/` contains the Vite/React app, organized into `pages/`, reusable `components/`, `hooks/`, `api/`, and `assets/`.
- `docker-compose.yml` runs PostgreSQL, the backend, and the frontend together. Root `test_*.js` files are lightweight smoke/diagnostic scripts.

## Build, Test, and Development Commands

- `docker compose up --build` — build and run the local stack on ports 3000, 4000, and 5432.
- `cd backend && npm ci && npm run dev` — install dependencies and start the API with nodemon.
- `cd backend && npm start` — start the API and run pending migrations first.
- `cd frontend && npm ci && npm run dev` — install dependencies and start Vite with HMR.
- `cd frontend && npm run build` — create the production frontend bundle.
- `cd frontend && npm run lint` — run ESLint.
- `node test_trim.js` — run the repository’s current input-trimming smoke check.

## Coding Style & Naming Conventions

Use two-space indentation and preserve the surrounding file’s quote/semicolon style. Backend modules use CommonJS; frontend modules use ES modules and JSX. Name React components in PascalCase, hooks with a `use` prefix, route files in lowercase kebab-case, and migrations as `NNN_short_description.sql`. Keep route-specific logic in `backend/src/routes/` and shared behavior in `hooks`, `api`, or `utils`.

## Testing Guidelines

There is no Jest/Mocha suite or coverage threshold. Before opening a change, run frontend lint/build, exercise affected API/UI flows, and run relevant smoke scripts. For schema changes, verify clean startup and migration ordering; never edit an applied migration—add the next numbered file.

## Commit & Pull Request Guidelines

History uses short, plain descriptive subjects without an enforced format (for example, `fixed workshop export`). Prefer a concise imperative subject such as `Fix workshop export`. Pull requests should explain behavior changes, list validation commands, call out migration/configuration impacts, link the issue, and include UI screenshots when relevant.

## Security & Configuration Tips

Keep `.env`, credentials, JWT/payment secrets, and service keys out of Git; use environment variables or ignored files. Review auth and role checks on protected routes, and never use the development secrets in `docker-compose.yml` for production.
