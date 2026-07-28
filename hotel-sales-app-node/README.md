# Hotel Sales app -- Node.js + PostgreSQL (no XAMPP, no Apache, no PHP)

This is the same app, rebuilt so it runs as a normal always-online website
instead of something you start locally with XAMPP. One process (Node.js)
serves the page and the API; one free managed database (Postgres) stores
everything, including uploaded photos.

Total cost: **$0**. Neither Neon nor Render require a credit card for this.

## What's in this folder

```
hotel-sales-app-node/
  server.js         <- the whole backend (replaces api.php + config.php)
  package.json
  render.yaml        <- lets Render auto-configure itself from this repo
  .env.example       <- copy to .env for local testing only
  public/
    index.html       <- your original frontend, barely touched
```

There's no `uploads/` folder anymore -- photos are stored inside Postgres
itself, so they survive restarts/redeploys on hosts that don't give you a
persistent disk (which is most free tiers).

---

## 1. Create a free Postgres database (Neon)

1. Go to **https://neon.tech** and sign up (GitHub/Google login is fastest,
   no credit card needed).
2. Create a new project. Neon gives you a database immediately.
3. On the project dashboard, copy the **connection string** — it looks like:
   ```
   postgres://neondb_owner:AbC123@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
   Keep this handy for step 3 below. You do **not** need to run `schema.sql`
   anywhere — `server.js` creates its own tables automatically the first
   time it starts.

*(Supabase's free tier works the same way if you prefer it — same idea,
just copy its connection string instead.)*

## 2. Put this folder on GitHub

Render deploys from a Git repo, so:

1. Create a new repository on GitHub (public or private, either is fine).
2. Upload this whole `hotel-sales-app-node` folder into it (drag-and-drop
   on GitHub's web UI works, or `git init && git add . && git commit -m "init" && git push` if you're comfortable with git).

## 3. Deploy to Render

1. Go to **https://render.com** and sign up (no credit card required for
   the free tier).
2. Click **New +** → **Blueprint**, and point it at your GitHub repo.
   Render will read `render.yaml` and pre-fill everything (free plan,
   build command, start command).
3. It will ask you to fill in **DATABASE_URL** — paste the Neon connection
   string from step 1.
4. Click **Apply** / **Create**. First deploy takes a couple of minutes.

   *(No Blueprint option, or prefer doing it by hand? Click **New +** →
   **Web Service** instead, connect the repo, and manually set:
   Build command: `npm install`, Start command: `node server.js`,
   Environment variable: `DATABASE_URL` = your Neon connection string.)*

5. When it's done, Render gives you a public URL like:
   ```
   https://hotel-sales-app.onrender.com
   ```
   That's it — open it. Anyone, anywhere, can now use the app at that
   address; it's no longer limited to your office LAN.

First run seeds a default login:
- Username: `admin`
- Password: `sugarland2026`

Change that password from the account menu once you're in.

### About the free tier

Render's free web service **spins down after ~15 minutes of no traffic**
and takes 20–50 seconds to wake back up on the next visit. That's the
trade-off for $0/month. If your team needs it always instantly responsive,
Render's cheapest paid tier ($7/mo) removes the spin-down — everything
else in this setup stays exactly the same either way.

---

## Testing it locally first (optional)

If you want to try it on your own machine before deploying:

```bash
cd hotel-sales-app-node
npm install
cp .env.example .env
# edit .env and paste your Neon DATABASE_URL into it
node server.js
```

Then open **http://localhost:3000**.

---

## How it maps to the old PHP/XAMPP setup

| Before (XAMPP)                          | Now                                    |
|------------------------------------------|-----------------------------------------|
| Apache serving index.html                | Express serving `public/index.html`     |
| `api.php` + `config.php`                 | `server.js`                             |
| Local PostgreSQL install                 | Neon (free, managed, always-on)         |
| Photo saved to `uploads/` folder         | Photo saved as `bytea` in Postgres      |
| `http://localhost/hotel-sales-app/`      | `https://your-app.onrender.com`         |
| Only reachable on your office LAN        | Reachable from anywhere with a browser  |

The sync logic already in `index.html` (auto-save, retry on failure,
polling for teammates' edits) didn't change at all — it was already
written as a generic "POST rows, GET them back" protocol against a
relative URL. Only that URL and the storage layer behind it changed.

## Notes

- Like the original setup, there's no login on the API itself — access
  control lives in the app's own sign-in screen. Fine for a small team;
  if this ever needs to be locked down further, that's a follow-up
  (e.g. an API key header, or real user auth in `server.js`).
- Photos are capped at ~15MB by the request body limit in `server.js`
  (`express.json({ limit: '15mb' })`) — raise that number if needed.
- Free-tier Postgres providers do have storage/row limits (Neon's free
  tier is generous for this kind of app — hundreds of MB — but if photo
  volume grows a lot over time, that's worth keeping an eye on).
