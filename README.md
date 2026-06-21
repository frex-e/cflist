# CFList

A small Codeforces problem index for browsing official regular Codeforces problems, filtering them, syncing new problems, and tracking solved status per signed-in account.

Requires Node.js 24 or newer.

## Development

```sh
npm install
cp .env.example .env
npm run dev
```

Optional: set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env` to enable GitHub sign-in. If either is missing, GitHub auth stays disabled.

The app listens on `http://localhost:3000` by default.

## Configuration

Environment variables are read from the process environment. For local development, copy [`.env.example`](./.env.example) to `.env` in the project root; the server loads it automatically on startup.

- `PORT`: server port, default `3000`
- `HOST`: bind host, default `127.0.0.1`
- `DB_PATH`: SQLite database path, default `./data/cflist.sqlite`
- `SYNC_INTERVAL_MINUTES`: background refresh interval, default `360`
- `BETTER_AUTH_SECRET` or `AUTH_SECRET`: auth secret; set a random 32+ byte value for production
- `BETTER_AUTH_URL` or `AUTH_BASE_URL`: public app base URL, default derived from host/port
- `AUTH_TRUSTED_ORIGINS`: comma-separated additional trusted origins for auth form posts
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: optional GitHub OAuth credentials; when both are set, sign-in and sign-up pages show a GitHub button
- `PUBLIC_ROOT`: static asset root, default `./src`

Authentication is email/password through Better Auth, with optional GitHub OAuth when configured. Register a GitHub OAuth App with callback URL `{AUTH_BASE_URL}/api/auth/callback/github` (for local dev: `http://localhost:3000/api/auth/callback/github`). GitHub users must have a visible primary email on their GitHub account. New GitHub sign-ups complete a Codeforces handle on `/complete-profile` before using the app. Auth state, account Codeforces handles, sessions, solved status, overrides, and saved default filters are stored in SQLite. Existing pre-auth databases can be deleted and recreated.

## Commands

```sh
npm run build
npm start
npm run sync
npm test
```

## Deployment

Build and run one Node process, with `data/` persisted.

```sh
npm install
npm run build
npm start
```

For Docker (production example):

```sh
docker build -t cflist .
docker run -p 3000:3000 \
  -e BETTER_AUTH_URL=https://your-domain.example.com \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e GITHUB_CLIENT_ID=your_client_id \
  -e GITHUB_CLIENT_SECRET=your_client_secret \
  -v cflist-data:/app/data \
  cflist
```

Register the GitHub OAuth callback as `https://your-domain.example.com/api/auth/callback/github`.

Health check: `GET /healthz` returns `{ "ok": true }` when the database is reachable.
