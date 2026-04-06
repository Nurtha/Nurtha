const express = require('express');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const helmet = require('helmet');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');

const app = express();
const port = 3000;
const isProduction = process.env.NODE_ENV === 'production';
const adminApiKey = (process.env.ADMIN_API_KEY || '').trim();
const corsAllowlist = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

console.log('[startup] Initializing server...');

const allowedItemTypes = new Set(['lost', 'found']);
const allowedCategories = new Set(['electronics', 'pets', 'keys', 'other']);
const maxTextLength = {
  title: 120,
  location: 180,
  description: 1200,
  contact: 180,
  name: 120,
  certName: 120,
  claimMessage: 400,
  adminNote: 400
};

const maxPhotoChars = 7_000_000;
const maxPhotosPerItem = 4;

function sanitizeText(value, maxLength) {
  const text = (value || '').toString().replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return text.slice(0, maxLength);
}

function isValidIsoDate(dateValue) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateValue);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isValidStudentId(studentId) {
  return /^\d{2}-\d-\d-\d{4}$/.test(studentId);
}

function parseIdsParam(idsParam) {
  if (!idsParam) {
    return [];
  }

  return idsParam
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .slice(0, 100);
}

function decodeStoredPhotos(photoValue) {
  const value = (photoValue || '').toString().trim();
  if (!value) {
    return [];
  }

  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => (entry || '').toString().trim())
          .filter((entry) => /^data:image\/(jpeg|png);base64,/i.test(entry));
      }
    } catch (error) {
      return [];
    }
  }

  if (/^data:image\/(jpeg|png);base64,/i.test(value)) {
    return [value];
  }

  return [];
}

function normalizeIncomingPhotos(body) {
  const rawPhotos = Array.isArray(body.photos)
    ? body.photos
    : (body.photo ? [body.photo] : []);

  const photos = rawPhotos
    .map((entry) => (entry || '').toString().trim())
    .filter(Boolean)
    .slice(0, maxPhotosPerItem);

  for (const photo of photos) {
    if (photo.length > maxPhotoChars) {
      throw new Error('Photo is too large. Use a smaller JPEG or PNG.');
    }

    if (!/^data:image\/(jpeg|png);base64,/i.test(photo)) {
      throw new Error('Invalid image format. Please use JPEG or PNG.');
    }
  }

  return photos;
}

function formatItemRow(row) {
  const photos = decodeStoredPhotos(row.photo);
  return {
    ...row,
    photo: photos[0] || '',
    photos
  };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) {
    return cookies;
  }

  cookieHeader.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) {
      return;
    }

    const key = part.slice(0, index).trim();
    const value = decodeURIComponent(part.slice(index + 1).trim());
    if (key) {
      cookies[key] = value;
    }
  });

  return cookies;
}

function issueCsrfToken(res) {
  const token = crypto.randomBytes(32).toString('hex');
  const cookieParts = [
    `foundu_csrf=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Strict',
    isProduction ? 'Secure' : ''
  ].filter(Boolean);

  res.setHeader('Set-Cookie', cookieParts.join('; '));
  return token;
}

function isOriginAllowed(origin) {
  if (!origin) {
    return true;
  }

  if (!isProduction) {
    return true;
  }

  return corsAllowlist.includes(origin);
}

function requireCsrf(req, res, next) {
  const headerToken = (req.get('X-CSRF-Token') || '').trim();
  const cookieToken = parseCookies(req.get('Cookie') || '').foundu_csrf || '';

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }

  next();
}

function requireAdminKey(req, res, next) {
  if (!adminApiKey) {
    return res.status(503).json({ error: 'Admin API key is not configured on the server' });
  }

  const providedKey = (req.get('X-Admin-Key') || '').trim();
  if (providedKey !== adminApiKey) {
    return res.status(401).json({ error: 'Unauthorized admin request' });
  }

  next();
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);
app.use(hpp());
app.use(express.json({ limit: '8mb' }));
app.use(express.static(__dirname));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests. Please slow down.' }
});

app.use('/api', apiLimiter);

app.use((req, res, next) => {
  const requestOrigin = req.get('Origin');
  if (isOriginAllowed(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
    if (requestOrigin) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Admin-Key');

  if (req.method === 'OPTIONS') {
    if (!isOriginAllowed(requestOrigin)) {
      return res.status(403).json({ error: 'Origin is not allowed by CORS policy' });
    }

    return res.sendStatus(204);
  }

  if (!isOriginAllowed(requestOrigin)) {
    return res.status(403).json({ error: 'Origin is not allowed by CORS policy' });
  }

  next();
});

app.use('/api/admin', requireAdminKey);

const db = new sqlite3.Database('./foundu.db', (err) => {
  if (err) {
    console.error('[db] Connection failed:', err.message);
    return;
  }

  console.log('[db] Connected to the SQLite database.');

  db.run(
    `CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'pending',
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      cat TEXT NOT NULL,
      loc TEXT NOT NULL,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      contact TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    (tableErr) => {
      if (tableErr) {
        console.error('[db] Failed to initialize items table:', tableErr.message);
      } else {
        console.log('[db] items table is ready.');

        db.all('PRAGMA table_info(items)', [], (pragmaErr, columns) => {
          if (pragmaErr) {
            console.error('[db] Failed to read schema:', pragmaErr.message);
            return;
          }

          const hasStatus = columns.some((column) => column.name === 'status');
          const hasPhoto = columns.some((column) => column.name === 'photo');

          if (!hasStatus) {
            db.run("ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'", (alterErr) => {
              if (alterErr) {
                console.error('[db] Failed to add status column:', alterErr.message);
                return;
              }
              console.log('[db] Added status column to items table.');
            });
          }

          if (!hasPhoto) {
            db.run("ALTER TABLE items ADD COLUMN photo TEXT", (alterErr) => {
              if (alterErr) {
                console.error('[db] Failed to add photo column:', alterErr.message);
                return;
              }
              console.log('[db] Added photo column to items table.');
            });
          }

          db.run("UPDATE items SET status = 'pending' WHERE status IS NULL", (updateErr) => {
            if (updateErr) {
              console.error('[db] Failed to backfill status values:', updateErr.message);
            }
          });
        });
      }
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS claim_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claimant_name TEXT NOT NULL DEFAULT '',
      claimant_student_id TEXT NOT NULL DEFAULT '',
      cert_name TEXT,
      requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
      issued_at TEXT,
      FOREIGN KEY (item_id) REFERENCES items(id)
    )`,
    (claimTableErr) => {
      if (claimTableErr) {
        console.error('[db] Failed to initialize claim_requests table:', claimTableErr.message);
      } else {
        console.log('[db] claim_requests table is ready.');

        db.all('PRAGMA table_info(claim_requests)', [], (claimPragmaErr, claimColumns) => {
          if (claimPragmaErr) {
            console.error('[db] Failed to read claim_requests schema:', claimPragmaErr.message);
            return;
          }

          const hasClaimantName = claimColumns.some((column) => column.name === 'claimant_name');
          const hasClaimantStudentId = claimColumns.some((column) => column.name === 'claimant_student_id');
          const hasProofImage = claimColumns.some((column) => column.name === 'proof_image');
          const hasClaimMessage = claimColumns.some((column) => column.name === 'claim_message');
          const hasAdminNote = claimColumns.some((column) => column.name === 'admin_note');
          const hasReviewedAt = claimColumns.some((column) => column.name === 'reviewed_at');

          if (!hasClaimantName) {
            db.run("ALTER TABLE claim_requests ADD COLUMN claimant_name TEXT NOT NULL DEFAULT ''", (alterNameErr) => {
              if (alterNameErr) {
                console.error('[db] Failed to add claimant_name column:', alterNameErr.message);
              }
            });
          }

          if (!hasClaimantStudentId) {
            db.run("ALTER TABLE claim_requests ADD COLUMN claimant_student_id TEXT NOT NULL DEFAULT ''", (alterStudentErr) => {
              if (alterStudentErr) {
                console.error('[db] Failed to add claimant_student_id column:', alterStudentErr.message);
              }
            });
          }

          if (!hasProofImage) {
            db.run("ALTER TABLE claim_requests ADD COLUMN proof_image TEXT", (alterProofErr) => {
              if (alterProofErr) {
                console.error('[db] Failed to add proof_image column:', alterProofErr.message);
              }
            });
          }

          if (!hasClaimMessage) {
            db.run("ALTER TABLE claim_requests ADD COLUMN claim_message TEXT", (alterMessageErr) => {
              if (alterMessageErr) {
                console.error('[db] Failed to add claim_message column:', alterMessageErr.message);
              }
            });
          }

          if (!hasAdminNote) {
            db.run("ALTER TABLE claim_requests ADD COLUMN admin_note TEXT", (alterAdminNoteErr) => {
              if (alterAdminNoteErr) {
                console.error('[db] Failed to add admin_note column:', alterAdminNoteErr.message);
              }
            });
          }

          if (!hasReviewedAt) {
            db.run("ALTER TABLE claim_requests ADD COLUMN reviewed_at TEXT", (alterReviewedAtErr) => {
              if (alterReviewedAtErr) {
                console.error('[db] Failed to add reviewed_at column:', alterReviewedAtErr.message);
              }
            });
          }
        });
      }
    }
  );
});

app.get('/api/items', (req, res) => {
  const sql = `
    SELECT id, status, type, title, cat, loc, date, description AS desc, contact, photo
    FROM items
    WHERE status = 'approved'
    ORDER BY id DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('[api] Failed to fetch items:', err.message);
      return res.status(500).json({ error: 'Failed to fetch items' });
    }

    res.json({ data: rows.map(formatItemRow) });
  });
});

app.get('/api/items/status', (req, res) => {
  const ids = parseIdsParam((req.query.ids || '').toString());
  if (ids.length === 0) {
    return res.json({ data: [] });
  }

  const placeholders = ids.map(() => '?').join(',');
  const sql = `SELECT id, status, title FROM items WHERE id IN (${placeholders})`;
  db.all(sql, ids, (err, rows) => {
    if (err) {
      console.error('[api] Failed to fetch item statuses:', err.message);
      return res.status(500).json({ error: 'Failed to fetch item statuses' });
    }

    res.json({ data: rows });
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/csrf-token', (req, res) => {
  const cookies = parseCookies(req.get('Cookie') || '');
  const token = cookies.foundu_csrf || issueCsrfToken(res);
  res.json({ token });
});

app.get('/api/admin/items', (req, res) => {
  const sql = `
    SELECT id, status, type, title, cat, loc, date, description AS desc, contact, photo
    FROM items
    ORDER BY id DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('[api] Failed to fetch admin items:', err.message);
      return res.status(500).json({ error: 'Failed to fetch admin items' });
    }

    res.json({ data: rows.map(formatItemRow) });
  });
});

app.get('/api/admin/claims', (req, res) => {
  const sql = `
    SELECT
      cr.id,
      cr.item_id,
      cr.status,
      cr.claimant_name,
      cr.claimant_student_id,
      cr.proof_image,
      cr.claim_message,
      cr.cert_name,
      cr.admin_note,
      cr.requested_at,
      cr.reviewed_at,
      cr.issued_at,
      i.title,
      i.loc,
      i.date
    FROM claim_requests cr
    JOIN items i ON i.id = cr.item_id
    ORDER BY
      CASE WHEN cr.status = 'pending' THEN 0 ELSE 1 END,
      cr.id DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('[api] Failed to fetch claim requests:', err.message);
      return res.status(500).json({ error: 'Failed to fetch claim requests' });
    }

    res.json({ data: rows });
  });
});

app.get('/api/claims/status', (req, res) => {
  const ids = parseIdsParam((req.query.ids || '').toString());
  if (ids.length === 0) {
    return res.json({ data: [] });
  }

  const placeholders = ids.map(() => '?').join(',');
  const sql = `
    SELECT id, item_id, status, cert_name, admin_note, reviewed_at, issued_at
    FROM claim_requests
    WHERE id IN (${placeholders})
  `;

  db.all(sql, ids, (err, rows) => {
    if (err) {
      console.error('[api] Failed to fetch claim statuses:', err.message);
      return res.status(500).json({ error: 'Failed to fetch claim statuses' });
    }

    res.json({ data: rows });
  });
});

app.post('/api/items', writeLimiter, requireCsrf, (req, res) => {
  const type = sanitizeText(req.body.type, 20).toLowerCase();
  const title = sanitizeText(req.body.title, maxTextLength.title);
  const cat = sanitizeText(req.body.cat, 30).toLowerCase();
  const loc = sanitizeText(req.body.loc, maxTextLength.location);
  const date = sanitizeText(req.body.date, 20);
  const desc = sanitizeText(req.body.desc, maxTextLength.description);
  const contact = sanitizeText(req.body.contact, maxTextLength.contact);
  let photos = [];

  if (!type || !title || !cat || !loc || !date || !desc || !contact) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    photos = normalizeIncomingPhotos(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  if (!allowedItemTypes.has(type)) {
    return res.status(400).json({ error: 'Invalid item type' });
  }

  if (!allowedCategories.has(cat)) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  if (!isValidIsoDate(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }

  const sql = `
    INSERT INTO items (status, type, title, cat, loc, date, description, contact, photo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const serializedPhotos = photos.length > 0 ? JSON.stringify(photos) : '';

  db.run(sql, ['pending', type, title, cat, loc, date, desc, contact, serializedPhotos], function runInsert(err) {
    if (err) {
      console.error('[api] Failed to insert item:', err.message);
      return res.status(500).json({ error: 'Failed to insert item' });
    }

    res.status(201).json({
      data: {
        id: this.lastID,
        status: 'pending',
        type,
        title,
        cat,
        loc,
        date,
        desc,
        contact,
        photo: photos[0] || '',
        photos
      }
    });
  });
});

app.post('/api/claims', writeLimiter, requireCsrf, (req, res) => {
  const itemId = Number(req.body.itemId);
  const claimantName = sanitizeText(req.body.claimantName, maxTextLength.name);
  const claimantStudentId = sanitizeText(req.body.claimantStudentId, 24);
  const claimMessage = sanitizeText(req.body.claimMessage, maxTextLength.claimMessage);
  const proofImage = (req.body.proofImage || '').toString().trim();

  if (!isPositiveInteger(itemId)) {
    return res.status(400).json({ error: 'Invalid item id' });
  }

  if (!claimantName || !claimantStudentId) {
    return res.status(400).json({ error: 'Claimant name and student ID are required' });
  }

  if (!isValidStudentId(claimantStudentId)) {
    return res.status(400).json({ error: 'Invalid student ID format. Use 00-0-0-0000.' });
  }

  if (proofImage && proofImage.length > maxPhotoChars) {
    return res.status(400).json({ error: 'Proof image is too large. Use a smaller JPEG or PNG.' });
  }

  if (proofImage && !/^data:image\/(jpeg|png);base64,/i.test(proofImage)) {
    return res.status(400).json({ error: 'Invalid proof image format. Please use JPEG or PNG.' });
  }

  db.get('SELECT id FROM items WHERE id = ? AND status = ?', [itemId, 'approved'], (itemErr, itemRow) => {
    if (itemErr) {
      console.error('[api] Failed to validate item for claim:', itemErr.message);
      return res.status(500).json({ error: 'Failed to validate item' });
    }

    if (!itemRow) {
      return res.status(404).json({ error: 'Approved item not found' });
    }

    db.get(
      'SELECT id FROM claim_requests WHERE item_id = ? AND status = ? LIMIT 1',
      [itemId, 'pending'],
      (claimErr, claimRow) => {
        if (claimErr) {
          console.error('[api] Failed to check existing claim request:', claimErr.message);
          return res.status(500).json({ error: 'Failed to process claim request' });
        }

        if (claimRow) {
          return res.status(409).json({ error: 'Ownership request already pending for this item' });
        }

        db.run(
          'INSERT INTO claim_requests (item_id, status, claimant_name, claimant_student_id, proof_image, claim_message) VALUES (?, ?, ?, ?, ?, ?)',
          [itemId, 'pending', claimantName, claimantStudentId, proofImage, claimMessage],
          function onCreate(createErr) {
          if (createErr) {
            console.error('[api] Failed to create claim request:', createErr.message);
            return res.status(500).json({ error: 'Failed to create claim request' });
          }

          res.status(201).json({
            data: {
              id: this.lastID,
              item_id: itemId,
              status: 'pending',
              claimant_name: claimantName,
              claimant_student_id: claimantStudentId,
              proof_image: proofImage,
              claim_message: claimMessage
            }
          });
          }
        );
      }
    );
  });
});

app.patch('/api/admin/items/:id/approve', writeLimiter, requireCsrf, (req, res) => {
  const itemId = Number(req.params.id);
  if (!isPositiveInteger(itemId)) {
    return res.status(400).json({ error: 'Invalid item id' });
  }

  const sql = "UPDATE items SET status = 'approved' WHERE id = ?";
  db.run(sql, [itemId], function onApprove(err) {
    if (err) {
      console.error('[api] Failed to approve item:', err.message);
      return res.status(500).json({ error: 'Failed to approve item' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ message: 'Item approved' });
  });
});

app.patch('/api/admin/claims/:id/certificate', writeLimiter, requireCsrf, (req, res) => {
  const claimId = Number(req.params.id);
  const certNameInput = sanitizeText(req.body.certName, maxTextLength.certName);
  const adminNote = sanitizeText(req.body.adminNote, maxTextLength.adminNote);

  if (!isPositiveInteger(claimId)) {
    return res.status(400).json({ error: 'Invalid claim id' });
  }

  db.get(
    'SELECT id, claimant_name FROM claim_requests WHERE id = ?',
    [claimId],
    (claimErr, claimRow) => {
      if (claimErr) {
        console.error('[api] Failed to load claim request:', claimErr.message);
        return res.status(500).json({ error: 'Failed to issue certificate' });
      }

      if (!claimRow) {
        return res.status(404).json({ error: 'Claim request not found' });
      }

      const certName = certNameInput || claimRow.claimant_name;

      if (!certName) {
        return res.status(400).json({ error: 'Certificate name is required' });
      }

      const updateSql = `
        UPDATE claim_requests
        SET status = 'certificate_issued', cert_name = ?, admin_note = ?, issued_at = CURRENT_TIMESTAMP, reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;

      db.run(updateSql, [certName, adminNote, claimId], function onIssue(err) {
        if (err) {
          console.error('[api] Failed to issue certificate:', err.message);
          return res.status(500).json({ error: 'Failed to issue certificate' });
        }

        const detailsSql = `
          SELECT
            cr.id,
            cr.item_id,
            cr.status,
            cr.claimant_name,
            cr.claimant_student_id,
            cr.proof_image,
            cr.claim_message,
            cr.cert_name,
            cr.admin_note,
            cr.requested_at,
            cr.reviewed_at,
            cr.issued_at,
            i.title,
            i.loc,
            i.date
          FROM claim_requests cr
          JOIN items i ON i.id = cr.item_id
          WHERE cr.id = ?
        `;

        db.get(detailsSql, [claimId], (getErr, row) => {
          if (getErr) {
            console.error('[api] Failed to load certificate details:', getErr.message);
            return res.status(500).json({ error: 'Certificate issued but details could not be loaded' });
          }

          res.json({ data: row });
        });
      });
    }
  );
});

app.patch('/api/admin/claims/:id/reject', writeLimiter, requireCsrf, (req, res) => {
  const claimId = Number(req.params.id);
  const adminNote = sanitizeText(req.body.adminNote, maxTextLength.adminNote);

  if (!isPositiveInteger(claimId)) {
    return res.status(400).json({ error: 'Invalid claim id' });
  }

  const sql = `
    UPDATE claim_requests
    SET status = 'rejected', admin_note = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  db.run(sql, [adminNote, claimId], function onReject(err) {
    if (err) {
      console.error('[api] Failed to reject claim request:', err.message);
      return res.status(500).json({ error: 'Failed to reject claim request' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Claim request not found' });
    }

    res.json({ message: 'Claim request rejected' });
  });
});

app.delete('/api/admin/claims/history', writeLimiter, requireCsrf, requireAdminKey, (req, res) => {
  const sql = "DELETE FROM claim_requests WHERE status != 'pending'";

  db.run(sql, [], function onClearHistory(err) {
    if (err) {
      console.error('[api] Failed to clear ownership history:', err.message);
      return res.status(500).json({ error: 'Failed to clear ownership history' });
    }

    res.json({
      message: 'Ownership history cleared',
      cleared: this.changes || 0
    });
  });
});

app.delete('/api/admin/items/:id', writeLimiter, requireCsrf, (req, res) => {
  const itemId = Number(req.params.id);
  if (!isPositiveInteger(itemId)) {
    return res.status(400).json({ error: 'Invalid item id' });
  }

  db.run('DELETE FROM claim_requests WHERE item_id = ?', [itemId], (claimDeleteErr) => {
    if (claimDeleteErr) {
      console.error('[api] Failed to delete related claim requests:', claimDeleteErr.message);
      return res.status(500).json({ error: 'Failed to delete related claim requests' });
    }

    db.run('DELETE FROM items WHERE id = ?', [itemId], function onDelete(err) {
      if (err) {
        console.error('[api] Failed to delete item:', err.message);
        return res.status(500).json({ error: 'Failed to delete item' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Item not found' });
      }

      res.json({ message: 'Item deleted' });
    });
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`[server] Running at http://localhost:${port}`);
});
