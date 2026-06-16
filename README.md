# CFList

A small Codeforces problem index for browsing official regular Codeforces problems, filtering them, syncing new problems, and tracking solved status per signed-in account.

Requires Node.js 24 or newer.

## Development

```sh
npm install
npm run dev
```

The app listens on `http://localhost:3000` by default.

## Configuration

Environment variables:

- `PORT`: server port, default `3000`
- `HOST`: bind host, default `127.0.0.1`
- `DB_PATH`: SQLite database path, default `./data/cflist.sqlite`
- `SYNC_INTERVAL_MINUTES`: background refresh interval, default `360`
- `BETTER_AUTH_SECRET` or `AUTH_SECRET`: auth secret; set a random 32+ byte value for production
- `BETTER_AUTH_URL` or `AUTH_BASE_URL`: public app base URL, default derived from host/port
- `AUTH_TRUSTED_ORIGINS`: comma-separated additional trusted origins for auth form posts
- `PUBLIC_ROOT`: static asset root, default `./src`

Authentication is local email/password auth through Better Auth. Auth state, account Codeforces handles, sessions, solved status, overrides, and saved default filters are stored in SQLite. Existing pre-auth databases can be deleted and recreated.

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

For Docker:

```sh
docker build -t cflist .
docker run -p 3000:3000 -v cflist-data:/app/data cflist
```
