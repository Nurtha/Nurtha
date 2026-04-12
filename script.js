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
const MATCH_SCORE_THRESHOLD = 40;
const MATCH_DATE_WINDOW_DAYS = 5;
let matchBackfillPromise = null;

function runDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row || null);
    });
  });
}

function allDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows || []);
    });
  });
}

function normalizeWords(value) {
  return (value || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
}

function computeKeywordSimilarity(itemA, itemB) {
  const titleWordsA = new Set(normalizeWords(itemA.title || ''));
  const titleWordsB = new Set(normalizeWords(itemB.title || ''));
  const wordsA = new Set(normalizeWords(`${itemA.title} ${itemA.desc || itemA.description || ''}`));
  const wordsB = new Set(normalizeWords(`${itemB.title} ${itemB.desc || itemB.description || ''}`));

  if (wordsA.size === 0 || wordsB.size === 0) {
    return { similarity: 0, keywords: [] };
  }

  const intersection = [];
  wordsA.forEach((word) => {
    if (wordsB.has(word)) {
      intersection.push(word);
      return;
    }

    for (const candidate of wordsB) {
      if (word.includes(candidate) || candidate.includes(word)) {
        intersection.push(word.length <= candidate.length ? word : candidate);
        break;
      }
    }
  });

  let titleIntersection = 0;
  titleWordsA.forEach((word) => {
    if (titleWordsB.has(word)) {
      titleIntersection += 1;
      return;
    }

    for (const candidate of titleWordsB) {
      if (word.includes(candidate) || candidate.includes(word)) {
        titleIntersection += 1;
        break;
      }
    }
  });

  const titleMinSetSize = Math.min(titleWordsA.size || 0, titleWordsB.size || 0);
  const titleSimilarity = titleMinSetSize === 0 ? 0 : titleIntersection / titleMinSetSize;

  const compactA = `${itemA.title || ''} ${itemA.desc || itemA.description || ''}`.toLowerCase();
  const compactB = `${itemB.title || ''} ${itemB.desc || itemB.description || ''}`.toLowerCase();
  const phraseBoost = compactA.includes(compactB) || compactB.includes(compactA) ? 0.1 : 0;

  const unionSize = new Set([...wordsA, ...wordsB]).size;
  const minSetSize = Math.min(wordsA.size, wordsB.size);
  const baseSimilarity = unionSize === 0 ? 0 : intersection.length / unionSize;
  const overlapSimilarity = minSetSize === 0 ? 0 : intersection.length / minSetSize;
  const similarity = Math.min(1, Math.max(baseSimilarity, overlapSimilarity, titleSimilarity) + phraseBoost);
  return {
    similarity,
    keywords: [...new Set(intersection)].slice(0, 20)
  };
}

function computeLocationSimilarity(locA, locB) {
  const a = (locA || '').toString().trim().toLowerCase();
  const b = (locB || '').toString().trim().toLowerCase();

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  if (a.includes(b) || b.includes(a)) {
    return 0.85;
  }

  const wordsA = new Set(normalizeWords(a));
  const wordsB = new Set(normalizeWords(b));
  if (wordsA.size === 0 || wordsB.size === 0) {
    return 0;
  }

  let overlap = 0;
  wordsA.forEach((word) => {
    if (wordsB.has(word)) {
      overlap += 1;
    }
  });

  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : overlap / union;
}

function computeDateProximityScore(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);

  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    return 0;
  }

  const diffDays = Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > MATCH_DATE_WINDOW_DAYS) {
    return 0;
  }

  return Math.max(0, (MATCH_DATE_WINDOW_DAYS - diffDays) / MATCH_DATE_WINDOW_DAYS);
}

function calculateMatchScore(itemA, itemB) {
  if (!itemA || !itemB) {
    return {
      score: 0,
      keywordScore: 0,
      locationScore: 0,
      dateScore: 0,
      matchedKeywords: []
    };
  }

  const catA = (itemA.cat || '').toString().trim().toLowerCase();
  const catB = (itemB.cat || '').toString().trim().toLowerCase();
  if (!catA || !catB || catA !== catB) {
    return {
      score: 0,
      keywordScore: 0,
      locationScore: 0,
      dateScore: 0,
      matchedKeywords: []
    };
  }

  const keyword = computeKeywordSimilarity(itemA, itemB);
  const locationSimilarity = computeLocationSimilarity(itemA.loc, itemB.loc);
  const dateProximity = computeDateProximityScore(itemA.date, itemB.date);

  const keywordScore = keyword.similarity * 40;
  const locationScore = locationSimilarity * 30;
  const dateScore = dateProximity * 30;
  const score = Math.round((keywordScore + locationScore + dateScore) * 100) / 100;

  return {
    score,
    keywordScore: Math.round(keywordScore * 100) / 100,
    locationScore: Math.round(locationScore * 100) / 100,
    dateScore: Math.round(dateScore * 100) / 100,
    matchedKeywords: keyword.keywords
  };
}

function filterAndSortMatches(sourceItem, candidateItems, minScore = MATCH_SCORE_THRESHOLD) {
  return (candidateItems || [])
    .map((candidate) => {
      const validLostFoundPair =
        (sourceItem.type === 'lost' && candidate.type === 'found')
        || (sourceItem.type === 'found' && candidate.type === 'lost');

      if (!validLostFoundPair) {
        return {
          ...candidate,
          score: 0,
          keywordScore: 0,
          locationScore: 0,
          dateScore: 0,
          matchedKeywords: []
        };
      }

      const scoreData = calculateMatchScore(sourceItem, candidate);
      console.log(
        `[match-debug] source#${sourceItem.id}(${sourceItem.type}) -> candidate#${candidate.id}(${candidate.type}) `
        + `score=${scoreData.score} keyword=${scoreData.keywordScore} location=${scoreData.locationScore} `
        + `date=${scoreData.dateScore} threshold=${minScore} category=${sourceItem.cat}/${candidate.cat}`
      );

      return {
        ...candidate,
        ...scoreData
      };
    })
    .filter((candidate) => candidate.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

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

function isValidClaimantId(claimantId, claimantRole = 'student') {
  if (claimantRole === 'faculty') {
    return /^FAC-\d{4}$/i.test(claimantId);
  }

  return /^\d{2}-\d-\d-\d{4}$/.test(claimantId);
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

  db.run(
    `CREATE TABLE IF NOT EXISTS item_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_key TEXT,
      source_item_id INTEGER NOT NULL,
      target_item_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      score REAL NOT NULL,
      keyword_score REAL NOT NULL DEFAULT 0,
      location_score REAL NOT NULL DEFAULT 0,
      date_score REAL NOT NULL DEFAULT 0,
      matched_keywords TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      action_note TEXT,
      requested_at TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_item_id) REFERENCES items(id),
      FOREIGN KEY (target_item_id) REFERENCES items(id)
    )`,
    (matchTableErr) => {
      if (matchTableErr) {
        console.error('[db] Failed to initialize item_matches table:', matchTableErr.message);
        return;
      }

      console.log('[db] item_matches table is ready.');

      db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_item_matches_pair_key ON item_matches(pair_key)', [], (indexErr) => {
        if (indexErr) {
          console.error('[db] Failed to create item_matches pair_key index:', indexErr.message);
        }
      });

      db.all('PRAGMA table_info(item_matches)', [], (pragmaErr, matchColumns) => {
        if (pragmaErr) {
          console.error('[db] Failed to read item_matches schema:', pragmaErr.message);
          return;
        }

        const hasRequestedAt = matchColumns.some((column) => column.name === 'requested_at');
        const hasReviewedAt = matchColumns.some((column) => column.name === 'reviewed_at');
        const hasActionNote = matchColumns.some((column) => column.name === 'action_note');
        const hasKeywordScore = matchColumns.some((column) => column.name === 'keyword_score');
        const hasLocationScore = matchColumns.some((column) => column.name === 'location_score');
        const hasDateScore = matchColumns.some((column) => column.name === 'date_score');
        const hasPairKey = matchColumns.some((column) => column.name === 'pair_key');

        if (!hasRequestedAt) {
          db.run('ALTER TABLE item_matches ADD COLUMN requested_at TEXT', (alterErr) => {
            if (alterErr) {
              console.error('[db] Failed to add requested_at column:', alterErr.message);
            }
          });
        }

        if (!hasReviewedAt) {
          db.run('ALTER TABLE item_matches ADD COLUMN reviewed_at TEXT', (alterErr) => {
            if (alterErr) {
              console.error('[db] Failed to add reviewed_at column:', alterErr.message);
            }
          });
        }

        if (!hasActionNote) {
          db.run('ALTER TABLE item_matches ADD COLUMN action_note TEXT', (alterErr) => {
            if (alterErr) {
              console.error('[db] Failed to add action_note column:', alterErr.message);
            }
          });
        }

        if (!hasKeywordScore) {
          db.run("ALTER TABLE item_matches ADD COLUMN keyword_score REAL NOT NULL DEFAULT 0", (alterErr) => {
            if (alterErr) {
              console.error('[db] Failed to add keyword_score column:', alterErr.message);
            }
          });
        }

        if (!hasLocationScore) {
          db.run("ALTER TABLE item_matches ADD COLUMN location_score REAL NOT NULL DEFAULT 0", (alterErr) => {
            if (alterErr) {
              console.error('[db] Failed to add location_score column:', alterErr.message);
            }
          });
        }

        if (!hasDateScore) {
          db.run("ALTER TABLE item_matches ADD COLUMN date_score REAL NOT NULL DEFAULT 0", (alterErr) => {
            if (alterErr) {
              console.error('[db] Failed to add date_score column:', alterErr.message);
            }
          });
        }

        if (!hasPairKey) {
          db.run('ALTER TABLE item_matches ADD COLUMN pair_key TEXT', (alterErr) => {
            if (alterErr) {
              console.error('[db] Failed to add pair_key column:', alterErr.message);
            }
          });
        }

        setTimeout(() => {
          ensureApprovedMatchesBackfilled().catch((error) => {
            console.error('[match-debug] startup backfill failed:', error.message);
          });
        }, 0);
      });
    }
  );
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
      i.type,
      i.cat,
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

app.get('/api/good-samaritans', (req, res) => {
  const sql = `
    SELECT
      COALESCE(NULLIF(TRIM(i.contact), ''), 'Anonymous Finder') AS finder_name,
      COUNT(DISTINCT cr.item_id) AS total_returns,
      MAX(cr.issued_at) AS last_return_date
    FROM claim_requests cr
    JOIN items i ON i.id = cr.item_id
    WHERE
      i.status = 'approved'
      AND LOWER(i.type) = 'found'
      AND cr.status = 'certificate_issued'
      AND cr.issued_at IS NOT NULL
    GROUP BY COALESCE(NULLIF(TRIM(i.contact), ''), 'Anonymous Finder')
    ORDER BY total_returns DESC, last_return_date DESC, finder_name ASC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('[api] Failed to fetch good samaritans:', err.message);
      return res.status(500).json({ error: 'Failed to fetch good samaritans' });
    }

    const data = rows.map((row) => ({
      finder_name: row.finder_name,
      total_returns: Number(row.total_returns || 0),
      last_return_date: row.last_return_date || null
    }));

    res.json({ data });
  });
});

app.get('/api/certificates/verify', (req, res) => {
  const certificateId = (req.query.id || '').toString().trim();
  const match = certificateId.match(/^FOUND-(\d{4})-(\d{4})$/i);

  if (!match) {
    return res.status(400).json({ error: 'Invalid certificate id' });
  }

  const claimId = Number(match[2]);
  if (!isPositiveInteger(claimId)) {
    return res.status(400).json({ error: 'Invalid certificate id' });
  }

  const sql = `
    SELECT
      cr.id,
      cr.status,
      cr.cert_name,
      cr.issued_at,
      i.title,
      i.cat,
      i.loc,
      i.date,
      i.type,
      i.status AS item_status
    FROM claim_requests cr
    JOIN items i ON i.id = cr.item_id
    WHERE cr.id = ?
  `;

  db.get(sql, [claimId], (err, row) => {
    if (err) {
      console.error('[api] Failed to verify certificate:', err.message);
      return res.status(500).json({ error: 'Failed to verify certificate' });
    }

    if (!row || (row.status || '').toLowerCase() !== 'certificate_issued' || (row.type || '').toLowerCase() !== 'found') {
      return res.status(404).json({ error: 'Certificate not found' });
    }

    res.json({
      data: {
        certificate_id: certificateId.toUpperCase(),
        finder_name: row.cert_name || '-',
        item_name: row.title,
        category: row.cat,
        location_found: row.loc,
        date_returned: row.issued_at || null,
        status: 'verified'
      }
    });
  });
});

async function persistDetectedMatches(sourceItem, matches) {
  if (!sourceItem || !isPositiveInteger(sourceItem.id)) {
    return;
  }

  for (const match of matches) {
    if (!isPositiveInteger(match.id)) {
      continue;
    }

    const validLostFoundPair =
      (sourceItem.type === 'lost' && match.type === 'found')
      || (sourceItem.type === 'found' && match.type === 'lost');
    if (!validLostFoundPair) {
      continue;
    }

    const lostItem = sourceItem.type === 'lost' ? sourceItem : match;
    const foundItem = sourceItem.type === 'found' ? sourceItem : match;

    const pairKey = `${lostItem.id}:${foundItem.id}`;
    const existing = await getDb('SELECT id FROM item_matches WHERE pair_key = ? LIMIT 1', [pairKey]);

    if (existing) {
      await runDb(
        `
          UPDATE item_matches
          SET score = ?, keyword_score = ?, location_score = ?, date_score = ?, matched_keywords = ?,
              source_item_id = ?, target_item_id = ?, source_type = ?, target_type = ?, status = CASE WHEN status = 'rejected' THEN status ELSE 'pending' END,
              action_note = CASE WHEN status = 'rejected' THEN action_note ELSE NULL END, reviewed_at = CASE WHEN status = 'rejected' THEN reviewed_at ELSE NULL END
          WHERE id = ?
        `,
        [
          match.score,
          match.keywordScore,
          match.locationScore,
          match.dateScore,
          JSON.stringify(match.matchedKeywords || []),
          lostItem.id,
          foundItem.id,
          'lost',
          'found',
          existing.id
        ]
      );
      console.log(
        `[match-debug] updated pair ${pairKey} score=${match.score} source#${lostItem.id}(lost) target#${foundItem.id}(found)`
      );
      continue;
    }

    await runDb(
      `
        INSERT INTO item_matches (
          pair_key,
          source_item_id,
          target_item_id,
          source_type,
          target_type,
          score,
          keyword_score,
          location_score,
          date_score,
          matched_keywords,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `,
      [
        pairKey,
        lostItem.id,
        foundItem.id,
        'lost',
        'found',
        match.score,
        match.keywordScore,
        match.locationScore,
        match.dateScore,
        JSON.stringify(match.matchedKeywords || [])
      ]
    );
    console.log(
      `[match-debug] inserted pair ${pairKey} score=${match.score} source#${lostItem.id}(lost) target#${foundItem.id}(found)`
    );
  }
}

async function detectAndPersistApprovedMatches() {
  const approvedLostItems = await allDb(
    `
      SELECT id, status, type, title, cat, loc, date, description AS desc, contact, photo
      FROM items
      WHERE status = 'approved' AND LOWER(type) = 'lost'
    `
  );
  const approvedFoundItems = await allDb(
    `
      SELECT id, status, type, title, cat, loc, date, description AS desc, contact, photo
      FROM items
      WHERE status = 'approved' AND LOWER(type) = 'found'
    `
  );

  console.log(
    `[match-debug] backfill scan approved-lost=${approvedLostItems.length} approved-found=${approvedFoundItems.length}`
  );

  const foundCandidates = approvedFoundItems.map(formatItemRow);
  let persistedPairs = 0;
  for (const lostRow of approvedLostItems) {
    const lostItem = formatItemRow(lostRow);
    const matches = filterAndSortMatches(lostItem, foundCandidates);
    if (matches.length > 0) {
      persistedPairs += matches.length;
      await persistDetectedMatches(lostItem, matches);
    }
  }

  if (persistedPairs > 0) {
    console.log(`[match-debug] persisted ${persistedPairs} approved lost/found match candidate(s).`);
  } else {
    console.log('[match-debug] no approved lost/found pairs reached threshold during recompute.');
  }
}

async function ensureApprovedMatchesBackfilled() {
  if (!matchBackfillPromise) {
    matchBackfillPromise = detectAndPersistApprovedMatches()
      .catch((error) => {
        console.error('[match-debug] approved-item backfill failed:', error.message);
      })
      .finally(() => {
        matchBackfillPromise = null;
      });
  }

  await matchBackfillPromise;
}

async function getMatchesForItemId(itemId) {
  const rows = await allDb(
    `
      SELECT
        m.id AS match_id,
        m.score,
        m.keyword_score,
        m.location_score,
        m.date_score,
        m.status,
        m.action_note,
        m.requested_at,
        m.reviewed_at,
        m.created_at,
        m.matched_keywords,
        CASE WHEN m.source_item_id = ? THEN i2.id ELSE i1.id END AS id,
        CASE WHEN m.source_item_id = ? THEN i2.status ELSE i1.status END AS item_status,
        CASE WHEN m.source_item_id = ? THEN i2.type ELSE i1.type END AS type,
        CASE WHEN m.source_item_id = ? THEN i2.title ELSE i1.title END AS title,
        CASE WHEN m.source_item_id = ? THEN i2.cat ELSE i1.cat END AS cat,
        CASE WHEN m.source_item_id = ? THEN i2.loc ELSE i1.loc END AS loc,
        CASE WHEN m.source_item_id = ? THEN i2.date ELSE i1.date END AS date,
        CASE WHEN m.source_item_id = ? THEN i2.description ELSE i1.description END AS desc,
        CASE WHEN m.source_item_id = ? THEN i2.contact ELSE i1.contact END AS contact,
        CASE WHEN m.source_item_id = ? THEN i2.photo ELSE i1.photo END AS photo
      FROM item_matches m
      JOIN items i1 ON i1.id = m.source_item_id
      JOIN items i2 ON i2.id = m.target_item_id
      WHERE m.source_item_id = ? OR m.target_item_id = ?
      ORDER BY m.score DESC, m.id DESC
    `,
    [itemId, itemId, itemId, itemId, itemId, itemId, itemId, itemId, itemId, itemId, itemId, itemId]
  );

  return rows.map((row) => ({
    ...formatItemRow(row),
    matchId: row.match_id,
    itemStatus: row.item_status,
    score: Number(row.score || 0),
    keywordScore: Number(row.keyword_score || 0),
    locationScore: Number(row.location_score || 0),
    dateScore: Number(row.date_score || 0),
    status: row.status,
    actionNote: row.action_note || '',
    requestedAt: row.requested_at || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at || null,
    matchedKeywords: (() => {
      try {
        const parsed = JSON.parse(row.matched_keywords || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return [];
      }
    })()
  }));
}

app.get('/api/items/:id/matches', async (req, res) => {
  const itemId = Number(req.params.id);
  if (!isPositiveInteger(itemId)) {
    return res.status(400).json({ error: 'Invalid item id' });
  }

  try {
    const matches = await getMatchesForItemId(itemId);
    res.json({ data: matches.filter((entry) => Number(entry.score || 0) >= MATCH_SCORE_THRESHOLD) });
  } catch (error) {
    console.error('[api] Failed to fetch item matches:', error.message);
    res.status(500).json({ error: 'Failed to fetch item matches' });
  }
});

app.post('/api/matches/:id/request', writeLimiter, requireCsrf, async (req, res) => {
  const matchId = Number(req.params.id);
  if (!isPositiveInteger(matchId)) {
    return res.status(400).json({ error: 'Invalid match id' });
  }

  try {
    const result = await runDb(
      "UPDATE item_matches SET requested_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'",
      [matchId]
    );

    if (!result.changes) {
      return res.status(404).json({ error: 'Pending match not found' });
    }

    res.json({ message: 'Match request recorded' });
  } catch (error) {
    console.error('[api] Failed to record match request:', error.message);
    res.status(500).json({ error: 'Failed to record match request' });
  }
});

app.get('/api/admin/matches', async (req, res) => {
  try {
    await ensureApprovedMatchesBackfilled();

    const rows = await allDb(
      `
        SELECT
          m.id,
          m.score,
          m.keyword_score,
          m.location_score,
          m.date_score,
          m.status,
          m.action_note,
          m.requested_at,
          m.reviewed_at,
          m.created_at,
          m.matched_keywords,
          s.id AS source_item_id,
          s.type AS source_type,
          s.title AS source_title,
          s.cat AS source_cat,
          s.loc AS source_loc,
          s.date AS source_date,
          s.description AS source_desc,
          s.status AS source_status,
          t.id AS target_item_id,
          t.type AS target_type,
          t.title AS target_title,
          t.cat AS target_cat,
          t.loc AS target_loc,
          t.date AS target_date,
          t.description AS target_desc,
          t.status AS target_status
        FROM item_matches m
        JOIN items s ON s.id = m.source_item_id
        JOIN items t ON t.id = m.target_item_id
        ORDER BY
          CASE WHEN m.status = 'pending' THEN 0 ELSE 1 END,
          m.score DESC,
          m.id DESC
      `
    );

    const data = rows.map((row) => ({
      ...row,
      matched_keywords: (() => {
        try {
          const parsed = JSON.parse(row.matched_keywords || '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
          return [];
        }
      })()
    }));

    res.json({ data });
  } catch (error) {
    console.error('[api] Failed to fetch admin matches:', error.message);
    res.status(500).json({ error: 'Failed to fetch admin matches' });
  }
});

app.patch('/api/admin/matches/:id/approve', writeLimiter, requireCsrf, async (req, res) => {
  const matchId = Number(req.params.id);
  const actionNote = sanitizeText(req.body.actionNote, maxTextLength.adminNote);

  if (!isPositiveInteger(matchId)) {
    return res.status(400).json({ error: 'Invalid match id' });
  }

  try {
    const result = await runDb(
      "UPDATE item_matches SET status = 'approved', action_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [actionNote, matchId]
    );

    if (!result.changes) {
      return res.status(404).json({ error: 'Match not found' });
    }

    res.json({ message: 'Match approved' });
  } catch (error) {
    console.error('[api] Failed to approve match:', error.message);
    res.status(500).json({ error: 'Failed to approve match' });
  }
});

app.patch('/api/admin/matches/:id/reject', writeLimiter, requireCsrf, async (req, res) => {
  const matchId = Number(req.params.id);
  const actionNote = sanitizeText(req.body.actionNote, maxTextLength.adminNote);

  if (!isPositiveInteger(matchId)) {
    return res.status(400).json({ error: 'Invalid match id' });
  }

  try {
    const result = await runDb(
      "UPDATE item_matches SET status = 'rejected', action_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [actionNote, matchId]
    );

    if (!result.changes) {
      return res.status(404).json({ error: 'Match not found' });
    }

    res.json({ message: 'Match rejected' });
  } catch (error) {
    console.error('[api] Failed to reject match:', error.message);
    res.status(500).json({ error: 'Failed to reject match' });
  }
});

app.post('/api/items', writeLimiter, requireCsrf, (req, res) => {
  console.log(
    `[api] POST /api/items origin=${req.get('origin') || '-'} ip=${req.ip || '-'} type=${req.body?.type || '-'} title=${(req.body?.title || '').toString().slice(0, 60)}`
  );

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

  db.run(sql, ['pending', type, title, cat, loc, date, desc, contact, serializedPhotos], async function runInsert(err) {
    if (err) {
      console.error('[api] Failed to insert item:', err.message);
      return res.status(500).json({ error: 'Failed to insert item' });
    }

    const insertedItem = {
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
    };

    try {
      const oppositeType = type === 'lost' ? 'found' : 'lost';
      const candidates = await allDb(
        `
          SELECT id, status, type, title, cat, loc, date, description AS desc, contact, photo
          FROM items
          WHERE type = ? AND id != ?
        `,
        [oppositeType, insertedItem.id]
      );

      const scoredMatches = filterAndSortMatches(insertedItem, candidates.map(formatItemRow));
      await persistDetectedMatches(insertedItem, scoredMatches);

      const matches = scoredMatches.map((entry) => ({
        id: entry.id,
        type: entry.type,
        status: entry.status,
        title: entry.title,
        cat: entry.cat,
        loc: entry.loc,
        date: entry.date,
        desc: entry.desc,
        contact: entry.contact,
        photo: entry.photo || '',
        photos: entry.photos || [],
        score: entry.score,
        keywordScore: entry.keywordScore,
        locationScore: entry.locationScore,
        dateScore: entry.dateScore,
        matchedKeywords: entry.matchedKeywords || []
      }));

      res.status(201).json({
        data: {
          ...insertedItem,
          matches
        }
      });
    } catch (matchErr) {
      console.error('[api] Matching flow failed after item insert:', matchErr.message);
      res.status(201).json({
        data: {
          ...insertedItem,
          matches: []
        },
        warning: 'Item created but matching could not be completed.'
      });
    }
  });
});

app.get('/api/items', async (req, res) => {
  const sql = `
    SELECT
      i.id,
      i.status,
      i.type,
      i.title,
      i.cat,
      i.loc,
      i.date,
      i.description AS desc,
      i.contact,
      i.photo,
      EXISTS (
        SELECT 1
        FROM item_matches m
        JOIN items related_item
          ON related_item.id = CASE WHEN m.source_item_id = i.id THEN m.target_item_id ELSE m.source_item_id END
        WHERE
          (m.source_item_id = i.id OR m.target_item_id = i.id)
          AND related_item.status = 'approved'
      ) AS has_match,
      (
        SELECT CASE WHEN m.source_item_id = i.id THEN m.target_item_id ELSE m.source_item_id END
        FROM item_matches m
        JOIN items related_item
          ON related_item.id = CASE WHEN m.source_item_id = i.id THEN m.target_item_id ELSE m.source_item_id END
        WHERE
          (m.source_item_id = i.id OR m.target_item_id = i.id)
          AND related_item.status = 'approved'
        ORDER BY m.score DESC, m.id DESC
        LIMIT 1
      ) AS related_match_item_id,
      (
        SELECT m.status
        FROM item_matches m
        JOIN items related_item
          ON related_item.id = CASE WHEN m.source_item_id = i.id THEN m.target_item_id ELSE m.source_item_id END
        WHERE
          (m.source_item_id = i.id OR m.target_item_id = i.id)
          AND related_item.status = 'approved'
        ORDER BY m.score DESC, m.id DESC
        LIMIT 1
      ) AS related_match_status
    FROM items i
    WHERE i.status = 'approved'
    ORDER BY i.id DESC
  `;

  try {
    await ensureApprovedMatchesBackfilled();
    const rows = await allDb(sql);
    const data = rows.map((row) => {
      const item = formatItemRow(row);
      const hasMatch = Boolean(Number(row.has_match || 0));
      const relatedMatchItemId = Number(row.related_match_item_id || 0) || null;
      const relatedMatchStatus = (row.related_match_status || '').toString() || null;

      return {
        ...item,
        has_match: hasMatch,
        related_match_item_id: relatedMatchItemId,
        related_match_status: relatedMatchStatus,
        hasMatch,
        relatedMatchItemId,
        relatedMatchStatus
      };
    });

    res.json({ data });
  } catch (error) {
    console.error('[api] Failed to fetch items:', error.message);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

app.post('/api/claims', writeLimiter, requireCsrf, (req, res) => {
  const itemId = Number(req.body.itemId);
  const claimantName = sanitizeText(req.body.claimantName, maxTextLength.name);
  const claimantRoleInput = sanitizeText(req.body.claimantRole, 20).toLowerCase();
  const claimantRole = claimantRoleInput === 'faculty' ? 'faculty' : 'student';
  const claimantStudentId = sanitizeText(req.body.claimantStudentId, 24);
  const claimMessage = sanitizeText(req.body.claimMessage, maxTextLength.claimMessage);
  const proofImage = (req.body.proofImage || '').toString().trim();

  if (!isPositiveInteger(itemId)) {
    return res.status(400).json({ error: 'Invalid item id' });
  }

  if (!claimantName || !claimantStudentId) {
    return res.status(400).json({ error: 'Claimant name and ID are required' });
  }

  if (!isValidClaimantId(claimantStudentId, claimantRole)) {
    const formatMessage = claimantRole === 'faculty'
      ? 'Invalid faculty ID format. Use FAC-0000.'
      : 'Invalid student ID format. Use 00-0-0-0000.';
    return res.status(400).json({ error: formatMessage });
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

app.patch('/api/admin/claims/:id/verify', writeLimiter, requireCsrf, (req, res) => {
  const claimId = Number(req.params.id);
  const adminNote = sanitizeText(req.body.adminNote, maxTextLength.adminNote);

  if (!isPositiveInteger(claimId)) {
    return res.status(400).json({ error: 'Invalid claim id' });
  }

  const findSql = `
    SELECT
      cr.id,
      cr.status,
      i.type,
      i.status AS item_status
    FROM claim_requests cr
    JOIN items i ON i.id = cr.item_id
    WHERE cr.id = ?
  `;

  db.get(findSql, [claimId], (findErr, row) => {
    if (findErr) {
      console.error('[api] Failed to load claim request for verification:', findErr.message);
      return res.status(500).json({ error: 'Failed to verify claim request' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Claim request not found' });
    }

    const claimStatus = (row.status || '').toString().toLowerCase();
    if (claimStatus !== 'pending') {
      return res.status(400).json({ error: 'Only pending ownership requests can be verified' });
    }

    if ((row.item_status || '').toString().toLowerCase() !== 'approved') {
      return res.status(400).json({ error: 'Claim verification requires an approved post' });
    }

    const verifySql = `
      UPDATE claim_requests
      SET status = 'verified', admin_note = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;

    db.run(verifySql, [adminNote, claimId], function onVerify(updateErr) {
      if (updateErr) {
        console.error('[api] Failed to verify claim request:', updateErr.message);
        return res.status(500).json({ error: 'Failed to verify claim request' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Claim request not found' });
      }

      res.json({ message: 'Claim request verified' });
    });
  });
});

app.patch('/api/admin/claims/:id/approve', writeLimiter, requireCsrf, (req, res) => {
  const claimId = Number(req.params.id);
  const adminNote = sanitizeText(req.body.adminNote, maxTextLength.adminNote);

  if (!isPositiveInteger(claimId)) {
    return res.status(400).json({ error: 'Invalid claim id' });
  }

  const verifySql = `
    UPDATE claim_requests
    SET status = 'verified', admin_note = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
  `;

  db.run(verifySql, [adminNote, claimId], function onApprove(err) {
    if (err) {
      console.error('[api] Failed to approve claim request:', err.message);
      return res.status(500).json({ error: 'Failed to approve claim request' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Claim request not found' });
    }

    res.json({ message: 'Claim request verified' });
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
    `
      SELECT
        cr.id,
        cr.item_id,
        cr.status,
        cr.claimant_name,
        cr.claimant_student_id,
        cr.cert_name,
        cr.issued_at,
        i.type,
        i.status AS item_status,
        i.title,
        i.cat,
        i.loc,
        i.date
      FROM claim_requests cr
      JOIN items i ON i.id = cr.item_id
      WHERE cr.id = ?
    `,
    [claimId],
    (claimErr, claimRow) => {
      if (claimErr) {
        console.error('[api] Failed to load claim request:', claimErr.message);
        return res.status(500).json({ error: 'Failed to issue certificate' });
      }

      if (!claimRow) {
        return res.status(404).json({ error: 'Claim request not found' });
      }

      if ((claimRow.type || '').toString().toLowerCase() !== 'found') {
        return res.status(400).json({ error: 'Certificates can only be issued for found items' });
      }

      if ((claimRow.item_status || '').toString().toLowerCase() !== 'approved') {
        return res.status(400).json({ error: 'Certificates require an approved found item' });
      }

      if ((claimRow.status || '').toString().toLowerCase() !== 'verified') {
        return res.status(400).json({ error: 'Certificates can only be issued for verified ownership requests' });
      }

      const certName = certNameInput || claimRow.claimant_name;

      if (!certName) {
        return res.status(400).json({ error: 'Certificate name is required' });
      }

      const verificationCode = `FOUND-${new Date().getFullYear()}-${String(claimRow.id).padStart(4, '0')}`;

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

          res.json({
            data: {
              certificate_id: verificationCode,
              verification_url: `/verify-certificate.html?id=${encodeURIComponent(verificationCode)}`,
              finder_name: certName,
              system_name: 'FoundU – Intelligent Lost and Found System',
              institution: 'President Ramon Magsaysay State University',
              title: 'CERTIFICATE OF APPRECIATION',
              item_name: row.title,
              category: row.cat,
              location_found: row.loc,
              date_returned: row.issued_at || new Date().toISOString(),
              footer_name: 'FoundU Administrator',
              date_issued: row.issued_at || new Date().toISOString()
            }
          });
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

    db.run('DELETE FROM item_matches WHERE source_item_id = ? OR target_item_id = ?', [itemId, itemId], (matchDeleteErr) => {
      if (matchDeleteErr) {
        console.error('[api] Failed to delete related match records:', matchDeleteErr.message);
        return res.status(500).json({ error: 'Failed to delete related match records' });
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
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`[server] Running at http://localhost:${port}`);
});
