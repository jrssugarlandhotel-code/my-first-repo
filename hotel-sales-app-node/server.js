/* Hotel Sales app -- server.
   Replaces api.php + config.php from the XAMPP/Apache setup with a single
   Node.js/Express process. Speaks the exact same protocol the frontend
   already used, so public/index.html needed only one line changed
   (SHEETS_WEBAPP_URL now points at '/api' instead of 'api.php'):

     GET  /api?action=all
       -> { ok:true, ledger:[...], calendar:[...], rooms:[...], users:[...] }

     POST /api   body: { type: 'ledger'|'calendar'|'rooms'|'users', rows: [...] }
       -> replaces the stored array for that type -> { ok:true }

     POST /api   body: { type: 'image', name, mime, data (base64) }
       -> saves the photo INTO Postgres (not the local disk) and returns a
          URL the browser can load -> { ok:true, url: '/uploads/<id>' }

     GET  /uploads/:id
       -> streams a previously uploaded photo back out of Postgres

   Storing photos in the database (instead of an uploads/ folder) is the
   one real architecture change from the PHP version: free hosts like
   Render/Railway/Fly wipe local disk on every redeploy or restart, but a
   managed Postgres database (e.g. Neon, Supabase) persists forever. This
   keeps everything in one place and makes the app deployable to any
   "git push, get a URL" style free host with zero extra setup. */

require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    'Missing DATABASE_URL environment variable. Set it to your Postgres ' +
    'connection string (see .env.example).'
  );
}

// Most free managed Postgres providers (Neon, Supabase, Render) require SSL
// and use a certificate that Node won't validate against a public CA bundle
// by default. rejectUnauthorized:false keeps this simple for a small app;
// tighten this if you later manage your own CA.
const pool = new Pool({
  connectionString,
  ssl: connectionString && /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false },
});

const ALLOWED_TYPES = ['ledger', 'calendar', 'rooms', 'users', 'history'];

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      data_type   VARCHAR(20)  NOT NULL PRIMARY KEY,
      payload     TEXT         NOT NULL,
      updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    INSERT INTO app_data (data_type, payload) VALUES
      ('ledger', '[]'), ('calendar', '[]'), ('rooms', '[]'), ('users', '[]'), ('history', '[]')
    ON CONFLICT (data_type) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploads (
      id          SERIAL       PRIMARY KEY,
      filename    TEXT,
      mime        TEXT         NOT NULL,
      data        BYTEA        NOT NULL,
      created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// The frontend posts as text/plain (to dodge a CORS preflight, a leftover
// from the Apps Script days) so we accept both content types and normalize.
app.use(express.json({ limit: '15mb' }));
app.use(express.text({ type: 'text/plain', limit: '15mb' }));
app.use((req, res, next) => {
  if (typeof req.body === 'string' && req.body.length) {
    try { req.body = JSON.parse(req.body); } catch (e) { /* leave as-is */ }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

async function getPayload(type) {
  const { rows } = await pool.query(
    'SELECT payload FROM app_data WHERE data_type = $1',
    [type]
  );
  if (!rows.length) return [];
  try {
    const decoded = JSON.parse(rows[0].payload);
    return Array.isArray(decoded) ? decoded : [];
  } catch (e) {
    return [];
  }
}

async function savePayload(type, rowsArr) {
  await pool.query(
    `INSERT INTO app_data (data_type, payload) VALUES ($1, $2)
     ON CONFLICT (data_type) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP`,
    [type, JSON.stringify(rowsArr)]
  );
  return true;
}

app.get('/api', async (req, res) => {
  if (req.query.action === 'all') {
    try {
      const result = { ok: true };
      for (const t of ALLOWED_TYPES) result[t] = await getPayload(t);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Database error: ' + e.message });
    }
  }
  res.status(400).json({ ok: false, error: 'Unknown action' });
});

app.post('/api', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  const type = body.type || '';

  if (type === 'image') {
    const data = body.data || '';
    if (!data) return res.status(400).json({ ok: false, error: 'Missing image data' });

    let binary;
    try {
      binary = Buffer.from(data, 'base64');
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'Bad base64 data' });
    }

    const mime = body.mime || 'image/jpeg';
    const filename = body.name || ('photo-' + Date.now() + '.jpg');

    try {
      const { rows } = await pool.query(
        'INSERT INTO uploads (filename, mime, data) VALUES ($1, $2, $3) RETURNING id',
        [filename, mime, binary]
      );
      return res.json({ ok: true, url: '/uploads/' + rows[0].id });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Could not save the photo: ' + e.message });
    }
  }

  if (!ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ ok: false, error: 'Unknown type' });
  }

  let rowsArr = body.rows;
  if (!Array.isArray(rowsArr)) rowsArr = [];

  try {
    const ok = await savePayload(type, rowsArr);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Database error: ' + e.message });
  }
});

app.get('/uploads/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).send('Not found');
  try {
    const { rows } = await pool.query(
      'SELECT mime, data FROM uploads WHERE id = $1',
      [id]
    );
    if (!rows.length) return res.status(404).send('Not found');
    res.set('Content-Type', rows[0].mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(rows[0].data);
  } catch (e) {
    res.status(500).send('Server error');
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Hotel Sales app listening on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Failed to initialize the database:', e.message);
    process.exit(1);
  });
