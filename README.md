# CFList

A small personal Codeforces problem index for browsing official regular Codeforces problems, filtering them, syncing new problems, and tracking solved status for `inj`.

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
- `CF_HANDLE`: Codeforces handle, default `inj`
- `SYNC_INTERVAL_MINUTES`: background refresh interval, default `360`
- `ADMIN_TOKEN`: optional token for sync and manual override write routes
- `PUBLIC_ROOT`: static asset root, default `./src`

If `ADMIN_TOKEN` is set, write routes require the token as either:

- `x-admin-token` header
- `adminToken` form field
- `adminToken` query parameter

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
