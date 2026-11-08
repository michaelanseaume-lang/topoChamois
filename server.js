'use strict';
require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 16) { console.error('SESSION_SECRET manquant ou trop court dans .env'); process.exit(1); }
const PORT = process.env.PORT || 3000;
let DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'topo.db');
// Si DB_PATH désigne un dossier (ex : /mnt/disque/topo/), la base s'appellera topo.db à l'intérieur
if (DB_PATH.endsWith('/') || (fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).isDirectory())) DB_PATH = path.join(DB_PATH, 'topo.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;
try { db = new Database(DB_PATH); } catch (e) {
  console.error(`Impossible d'ouvrir la base : ${DB_PATH}\n→ ${e.message}\nVérifiez que ce dossier existe et appartient à l'utilisateur qui lance node : ls -ld ${path.dirname(DB_PATH)}`);
  process.exit(1);
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, pseudo TEXT NOT NULL UNIQUE COLLATE NOCASE, hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relais(id INTEGER PRIMARY KEY, num INTEGER NOT NULL UNIQUE,
  photo TEXT, photo_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS voies(
  id INTEGER PRIMARY KEY, relais_id INTEGER NOT NULL REFERENCES relais(id) ON DELETE CASCADE,
  color TEXT NOT NULL, grade TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', setter TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS statuses(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voie_id INTEGER NOT NULL REFERENCES voies(id) ON DELETE CASCADE,
  status TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, voie_id));
CREATE TABLE IF NOT EXISTS validations(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voie_id INTEGER NOT NULL REFERENCES voies(id) ON DELETE CASCADE, PRIMARY KEY(user_id, voie_id));
CREATE TABLE IF NOT EXISTS contests(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voie_id INTEGER NOT NULL REFERENCES voies(id) ON DELETE CASCADE,
  grade TEXT NOT NULL, PRIMARY KEY(user_id, voie_id));
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY, voie_id INTEGER NOT NULL REFERENCES voies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL, ended_at TEXT);
-- Une ascension garde un instantané de la voie (cotation, couleur) : l'historique survit au renouvellement du mur.
CREATE TABLE IF NOT EXISTS ascents(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  voie_id INTEGER REFERENCES voies(id) ON DELETE SET NULL,
  grade TEXT NOT NULL, color TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS videos(
  id INTEGER PRIMARY KEY, voie_id INTEGER NOT NULL REFERENCES voies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, file TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_voies_relais ON voies(relais_id);
CREATE INDEX IF NOT EXISTS idx_videos_voie ON videos(voie_id);
CREATE INDEX IF NOT EXISTS idx_ascents_user ON ascents(user_id);
`);

// Migration : bases créées avant l'ajout des photos de relais
if (!db.prepare("SELECT 1 FROM pragma_table_info('relais') WHERE name = 'photo'").get())
  db.exec('ALTER TABLE relais ADD COLUMN photo TEXT; ALTER TABLE relais ADD COLUMN photo_by INTEGER REFERENCES users(id) ON DELETE SET NULL');

// ---------- Fichiers envoyés (photos de relais, vidéos de voies) ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_PHOTO_MB = Number(process.env.MAX_PHOTO_MB) || 10, MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB) || 150;
const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const VID_TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
// Les fichiers ne sont pas supprimés par les « ON DELETE CASCADE » de SQLite : on les efface nous-mêmes.
const rmFiles = files => files.filter(Boolean).forEach(f => fs.unlink(path.join(UPLOAD_DIR, f), () => {}));
function mkUpload(field, types, maxMb, label) {
  const m = multer({
    storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (_q, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '.' + types[f.mimetype]) }),
    fileFilter: (_q, f, cb) => types[f.mimetype] ? cb(null, true) : cb(new Error(`Format non accepté (${label})`)),
    limits: { fileSize: maxMb * 1048576, files: 1 }
  }).single(field);
  return (req, res, next) => m(req, res, err => err
    ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Fichier trop volumineux (max ${maxMb} Mo)` : err.message })
    : next());
}
const uploadPhoto = mkUpload('photo', IMG_TYPES, MAX_PHOTO_MB, 'JPEG, PNG ou WebP');
const uploadVideo = mkUpload('video', VID_TYPES, MAX_VIDEO_MB, 'MP4, MOV ou WebM');

const GRADES = ['4', '5', '6', '7', '8'].flatMap(n => ['a', 'a+', 'b', 'b+', 'c', 'c+'].map(l => n + l));
const COLORS = ['rouge', 'orange', 'jaune', 'vert', 'bleu', 'violet', 'rose', 'noir', 'blanc', 'gris'];
const STATUSES = ['avue', 'flash', 'apres', 'travail', 'non'];
const DONE = ['avue', 'flash', 'apres'];
const DONE_SQL = DONE.map(s => `'${s}'`).join(',');
const gi = g => GRADES.indexOf(g);
const now = () => new Date().toISOString();

// ---------- Auth (cookie signé, sans dépendance) ----------
const COOKIE = 'tok', MAX_AGE = 30 * 24 * 3600;
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function makeToken(uid) { const p = `${uid}.${Math.floor(Date.now() / 1000) + MAX_AGE}`; return `${p}.${hmac(p)}`; }
function readToken(req) {
  const m = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE + '='));
  if (!m) return null;
  const [uid, exp, sig] = decodeURIComponent(m.slice(COOKIE.length + 1)).split('.');
  if (!sig) return null;
  const good = hmac(`${uid}.${exp}`);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return Number(uid);
}
function setCookie(req, res, uid) {
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${uid ? MAX_AGE : 0}${req.secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${uid ? encodeURIComponent(makeToken(uid)) : ''}; ${flags}`);
}
const userById = db.prepare('SELECT id, pseudo, role FROM users WHERE id = ?');
function loadUser(req, _res, next) { const id = readToken(req); req.user = id ? userById.get(id) || null : null; next(); }
const auth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Connexion requise' });
const opener = (req, res, next) => ['opener', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Réservé aux ouvreurs' });
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Réservé aux administrateurs' });

const tries = new Map(); // anti brute-force simple, par IP
function throttle(req, res, next) {
  const k = req.ip, t = Date.now(), r = tries.get(k) || { n: 0, t };
  if (t - r.t > 10 * 60 * 1000) { r.n = 0; r.t = t; }
  if (++r.n > 15) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans quelques minutes' });
  tries.set(k, r); next();
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(loadUser);
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', throttle, (req, res) => {
  const pseudo = String(req.body.pseudo || '').trim(), pw = String(req.body.password || '');
  if (!/^[\p{L}\p{N}_.-]{3,20}$/u.test(pseudo)) return res.status(400).json({ error: 'Pseudo : 3 à 20 caractères (lettres, chiffres, _ . -)' });
  if (pw.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });
  if (db.prepare('SELECT 1 FROM users WHERE pseudo = ?').get(pseudo)) return res.status(409).json({ error: 'Ce pseudo est déjà pris' });
  const first = db.prepare('SELECT COUNT(*) n FROM users').get().n === 0; // le premier inscrit est administrateur
  const id = db.prepare('INSERT INTO users(pseudo, hash, role, created_at) VALUES(?,?,?,?)')
    .run(pseudo, bcrypt.hashSync(pw, 10), first ? 'admin' : (req.body.role === 'opener' ? 'opener' : 'user'), now()).lastInsertRowid;
  setCookie(req, res, id);
  res.json({ user: userById.get(id) });
});
app.post('/api/login', throttle, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE pseudo = ?').get(String(req.body.pseudo || '').trim());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect' });
  setCookie(req, res, u.id);
  res.json({ user: { id: u.id, pseudo: u.pseudo, role: u.role } });
});
app.post('/api/logout', (req, res) => { setCookie(req, res, null); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ user: req.user }));
app.put('/api/me/role', auth, (req, res) => { // chacun choisit entre grimpeur et ouvreur
  if (req.user.role === 'admin') return res.status(400).json({ error: 'Les administrateurs changent de rôle depuis l’onglet Club' });
  if (!['user', 'opener'].includes(req.body.role)) return res.status(400).json({ error: 'Rôle invalide' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, req.user.id);
  res.json({ user: userById.get(req.user.id) });
});
app.delete('/api/me', auth, throttle, (req, res) => { // suppression du compte (cascade : statuts, sessions, ascensions, commentaires, votes)
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.password || ''), u.hash)) return res.status(403).json({ error: 'Mot de passe incorrect' });
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n === 1)
    return res.status(400).json({ error: 'Vous êtes le seul administrateur : nommez-en un autre (onglet Club) avant de supprimer votre compte' });
  const myVideos = db.prepare('SELECT file FROM videos WHERE user_id = ?').all(u.id).map(x => x.file);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  rmFiles(myVideos);
  setCookie(req, res, null);
  res.json({ ok: true });
});

// ---------- Topo ----------
const voieById = id => db.prepare('SELECT * FROM voies WHERE id = ?').get(id);
const activeSession = uid => db.prepare('SELECT * FROM sessions WHERE user_id = ? AND ended_at IS NULL').get(uid);

app.get('/api/topo', auth, (req, res) => {
  const uid = req.user.id;
  const total = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const map = (sql, ...a) => Object.fromEntries(db.prepare(sql).all(...a).map(r => [r.k, r.n]));
  const done = map(`SELECT voie_id k, COUNT(*) n FROM statuses WHERE status IN (${DONE_SQL}) GROUP BY voie_id`);
  const vals = map('SELECT voie_id k, COUNT(*) n FROM validations GROUP BY voie_id');
  const vids = map('SELECT voie_id k, COUNT(*) n FROM videos GROUP BY voie_id');
  const myVals = new Set(db.prepare('SELECT voie_id FROM validations WHERE user_id = ?').all(uid).map(r => r.voie_id));
  const contests = {};
  db.prepare('SELECT voie_id, grade, COUNT(*) n, SUM(user_id = ?) me FROM contests GROUP BY voie_id, grade ORDER BY n DESC').all(uid)
    .forEach(r => (contests[r.voie_id] ||= []).push({ grade: r.grade, n: r.n, me: !!r.me }));
  const voies = {};
  db.prepare('SELECT * FROM voies ORDER BY id').all().forEach(v => (voies[v.relais_id] ||= []).push({
    id: v.id, color: v.color, grade: v.grade, name: v.name, setter: v.setter,
    pct: total ? Math.round((done[v.id] || 0) / total * 100) : 0,
    validations: vals[v.id] || 0, videos: vids[v.id] || 0, vme: myVals.has(v.id), contests: contests[v.id] || []
  }));
  const relais = db.prepare('SELECT * FROM relais ORDER BY num').all().map(r => ({
    id: r.id, num: r.num, voies: voies[r.id] || [],
    photo: r.photo ? `/media/${r.photo}` : null, photo_mine: !!r.photo && r.photo_by === uid }));
  const my = Object.fromEntries(db.prepare('SELECT voie_id, status FROM statuses WHERE user_id = ?').all(uid).map(r => [r.voie_id, r.status]));
  const s = activeSession(uid);
  res.json({ relais, my, session: s ? { id: s.id } : null, total, limits: { photo: MAX_PHOTO_MB, video: MAX_VIDEO_MB } });
});

app.post('/api/relais', auth, opener, (req, res) => {
  const num = (db.prepare('SELECT MAX(num) m FROM relais').get().m || 0) + 1;
  const id = db.prepare('INSERT INTO relais(num) VALUES(?)').run(num).lastInsertRowid;
  res.json({ id, num });
});
app.delete('/api/relais/:id', auth, opener, (req, res) => { // supprime aussi la photo du relais et les vidéos de ses voies
  const r = db.prepare('SELECT photo FROM relais WHERE id = ?').get(req.params.id);
  const files = [r && r.photo, ...db.prepare('SELECT f.file FROM videos f JOIN voies v ON v.id = f.voie_id WHERE v.relais_id = ?').all(req.params.id).map(x => x.file)];
  db.prepare('DELETE FROM relais WHERE id = ?').run(req.params.id);
  rmFiles(files);
  res.json({ ok: true });
});

function cleanVoie(b) {
  const color = COLORS.includes(b.color) ? b.color : null, grade = GRADES.includes(b.grade) ? b.grade : null;
  if (!color || !grade) return null;
  return { color, grade, name: String(b.name || '').trim().slice(0, 40), setter: String(b.setter || '').trim().slice(0, 30) };
}
app.post('/api/relais/:id/voies', auth, opener, (req, res) => {
  const c = cleanVoie(req.body);
  if (!c) return res.status(400).json({ error: 'Couleur ou cotation invalide' });
  if (!db.prepare('SELECT 1 FROM relais WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Relais introuvable' });
  const id = db.prepare('INSERT INTO voies(relais_id, color, grade, name, setter, created_at) VALUES(?,?,?,?,?,?)')
    .run(req.params.id, c.color, c.grade, c.name, c.setter, now()).lastInsertRowid;
  res.json({ id });
});
app.put('/api/voies/:id', auth, opener, (req, res) => {
  const v = voieById(req.params.id), c = cleanVoie(req.body);
  if (!v) return res.status(404).json({ error: 'Voie introuvable' });
  if (!c) return res.status(400).json({ error: 'Couleur ou cotation invalide' });
  db.transaction(() => {
    db.prepare('UPDATE voies SET color=?, grade=?, name=?, setter=? WHERE id=?').run(c.color, c.grade, c.name, c.setter, v.id);
    if (c.grade !== v.grade) { // la cotation a changé : on repart de zéro côté validations / contestations
      db.prepare('DELETE FROM validations WHERE voie_id = ?').run(v.id);
      db.prepare('DELETE FROM contests WHERE voie_id = ?').run(v.id);
    }
  })();
  res.json({ ok: true });
});
app.delete('/api/voies/:id', auth, opener, (req, res) => { // supprime ses vidéos ET la photo de son relais
  const v = voieById(req.params.id);
  if (!v) return res.status(404).json({ error: 'Voie introuvable' });
  const photo = db.prepare('SELECT photo FROM relais WHERE id = ?').get(v.relais_id);
  const files = [photo && photo.photo, ...db.prepare('SELECT file FROM videos WHERE voie_id = ?').all(v.id).map(x => x.file)];
  db.transaction(() => {
    db.prepare('DELETE FROM voies WHERE id = ?').run(v.id);
    db.prepare('UPDATE relais SET photo = NULL, photo_by = NULL WHERE id = ?').run(v.relais_id);
  })();
  rmFiles(files);
  res.json({ ok: true });
});

// ---------- Interactions grimpeur ----------
function addAscent(sessionId, uid, v, status) {
  db.prepare('INSERT INTO ascents(user_id, session_id, voie_id, grade, color, status, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(uid, sessionId, v.id, v.grade, v.color, status, now());
}
app.put('/api/voies/:id/status', auth, (req, res) => {
  const v = voieById(req.params.id), uid = req.user.id, st = req.body.status;
  if (!v) return res.status(404).json({ error: 'Voie introuvable' });
  if (!st) { db.prepare('DELETE FROM statuses WHERE user_id = ? AND voie_id = ?').run(uid, v.id); return res.json({ ok: true }); }
  if (!STATUSES.includes(st)) return res.status(400).json({ error: 'Statut invalide' });
  db.prepare(`INSERT INTO statuses(user_id, voie_id, status, updated_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id, voie_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`).run(uid, v.id, st, now());
  const s = activeSession(uid);
  if (s && st !== 'non') {
    const last = db.prepare('SELECT id FROM ascents WHERE session_id = ? AND voie_id = ? ORDER BY id DESC LIMIT 1').get(s.id, v.id);
    if (last) db.prepare('UPDATE ascents SET status = ? WHERE id = ?').run(st, last.id); else addAscent(s.id, uid, v, st);
  }
  res.json({ ok: true });
});
app.post('/api/voies/:id/repeat', auth, (req, res) => { // « refaite pendant la session »
  const v = voieById(req.params.id), uid = req.user.id, s = activeSession(uid);
  const st = db.prepare('SELECT status FROM statuses WHERE user_id = ? AND voie_id = ?').get(uid, req.params.id);
  if (!v || !s || !st || st.status === 'non') return res.status(400).json({ error: 'Session et statut requis' });
  addAscent(s.id, uid, v, st.status);
  res.json({ ok: true });
});
app.post('/api/voies/:id/validate', auth, (req, res) => { // une seule voix par personne : validation OU contestation
  const v = voieById(req.params.id), uid = req.user.id;
  if (!v) return res.status(404).json({ error: 'Voie introuvable' });
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM validations WHERE user_id = ? AND voie_id = ?').get(uid, v.id))
      db.prepare('DELETE FROM validations WHERE user_id = ? AND voie_id = ?').run(uid, v.id);
    else {
      db.prepare('INSERT INTO validations(user_id, voie_id) VALUES(?,?)').run(uid, v.id);
      db.prepare('DELETE FROM contests WHERE user_id = ? AND voie_id = ?').run(uid, v.id);
    }
  })();
  res.json({ ok: true });
});
app.post('/api/voies/:id/contest', auth, (req, res) => {
  const v = voieById(req.params.id), uid = req.user.id, g = req.body.grade;
  if (!v) return res.status(404).json({ error: 'Voie introuvable' });
  if (!GRADES.includes(g) || g === v.grade) return res.status(400).json({ error: 'Cotation proposée invalide' });
  db.transaction(() => {
    const cur = db.prepare('SELECT grade FROM contests WHERE user_id = ? AND voie_id = ?').get(uid, v.id);
    db.prepare('DELETE FROM contests WHERE user_id = ? AND voie_id = ?').run(uid, v.id);
    if (!cur || cur.grade !== g) { // re-cliquer sur sa propre proposition retire sa voix
      db.prepare('INSERT INTO contests(user_id, voie_id, grade) VALUES(?,?,?)').run(uid, v.id, g);
      db.prepare('DELETE FROM validations WHERE user_id = ? AND voie_id = ?').run(uid, v.id);
    }
  })();
  res.json({ ok: true });
});
app.get('/api/voies/:id/comments', auth, (req, res) => {
  if (!voieById(req.params.id)) return res.status(404).json({ error: 'Voie introuvable' });
  res.json({ comments: db.prepare(`SELECT c.id, u.pseudo, c.text, c.created_at FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.voie_id = ? ORDER BY c.id`).all(req.params.id) });
});
app.post('/api/voies/:id/comments', auth, (req, res) => {
  const t = String(req.body.text || '').trim().slice(0, 500);
  if (!t) return res.status(400).json({ error: 'Commentaire vide' });
  if (!voieById(req.params.id)) return res.status(404).json({ error: 'Voie introuvable' });
  db.prepare('INSERT INTO comments(voie_id, user_id, text, created_at) VALUES(?,?,?,?)').run(req.params.id, req.user.id, t, now());
  res.json({ ok: true });
});

// ---------- Photos de relais & vidéos de voies (tous les inscrits peuvent envoyer) ----------
const isOpenerRole = u => ['opener', 'admin'].includes(u.role);
app.post('/api/relais/:id/photo', auth, uploadPhoto, (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const r = db.prepare('SELECT photo FROM relais WHERE id = ?').get(req.params.id);
  if (!r) { rmFiles([f.filename]); return res.status(404).json({ error: 'Relais introuvable' }); }
  db.prepare('UPDATE relais SET photo = ?, photo_by = ? WHERE id = ?').run(f.filename, req.user.id, req.params.id);
  rmFiles([r.photo]); // l'ancienne photo est remplacée
  res.json({ ok: true });
});
app.delete('/api/relais/:id/photo', auth, (req, res) => {
  const r = db.prepare('SELECT photo, photo_by FROM relais WHERE id = ?').get(req.params.id);
  if (!r || !r.photo) return res.json({ ok: true });
  if (!isOpenerRole(req.user) && r.photo_by !== req.user.id) return res.status(403).json({ error: 'Seuls l’auteur de la photo et les ouvreurs peuvent la supprimer' });
  db.prepare('UPDATE relais SET photo = NULL, photo_by = NULL WHERE id = ?').run(req.params.id);
  rmFiles([r.photo]);
  res.json({ ok: true });
});
app.get('/api/voies/:id/videos', auth, (req, res) => {
  if (!voieById(req.params.id)) return res.status(404).json({ error: 'Voie introuvable' });
  res.json({ videos: db.prepare(`SELECT f.id, f.file, f.user_id, u.pseudo, f.created_at FROM videos f JOIN users u ON u.id = f.user_id
    WHERE f.voie_id = ? ORDER BY f.id`).all(req.params.id).map(f => ({ id: f.id, url: `/media/${f.file}`, pseudo: f.pseudo, created_at: f.created_at, mine: f.user_id === req.user.id })) });
});
app.post('/api/voies/:id/videos', auth, uploadVideo, (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'Aucun fichier reçu' });
  if (!voieById(req.params.id)) { rmFiles([f.filename]); return res.status(404).json({ error: 'Voie introuvable' }); }
  db.prepare('INSERT INTO videos(voie_id, user_id, file, created_at) VALUES(?,?,?,?)').run(req.params.id, req.user.id, f.filename, now());
  res.json({ ok: true });
});
app.delete('/api/videos/:id', auth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.json({ ok: true });
  if (v.user_id !== req.user.id && !isOpenerRole(req.user)) return res.status(403).json({ error: 'Seuls l’auteur de la vidéo et les ouvreurs peuvent la supprimer' });
  db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
  rmFiles([v.file]);
  res.json({ ok: true });
});
// Les fichiers ne sont servis qu'aux inscrits connectés ; le nom est un identifiant aléatoire (jamais le nom d'origine)
app.get('/media/:file', auth, (req, res) => {
  if (!/^[a-f0-9]{32}\.(jpg|png|webp|mp4|mov|webm)$/.test(req.params.file)) return res.status(404).end();
  res.sendFile(req.params.file, { root: UPLOAD_DIR, headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' } },
    err => { if (err && !res.headersSent) res.status(404).end(); });
});

// ---------- Sessions & stats ----------
app.post('/api/sessions/start', auth, (req, res) => {
  if (!activeSession(req.user.id)) db.prepare('INSERT INTO sessions(user_id, started_at) VALUES(?,?)').run(req.user.id, now());
  res.json({ ok: true });
});
app.post('/api/sessions/end', auth, (req, res) => {
  const s = activeSession(req.user.id);
  if (s) {
    if (db.prepare('SELECT COUNT(*) n FROM ascents WHERE session_id = ?').get(s.id).n === 0) db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    else db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(now(), s.id);
  }
  res.json({ ok: true });
});

// Cotations « réalisées » (statuts actuels + historique des ascensions), par utilisateur
function doneGrades() {
  return db.prepare(`SELECT s.user_id uid, v.grade FROM statuses s JOIN voies v ON v.id = s.voie_id WHERE s.status IN (${DONE_SQL})
    UNION ALL SELECT user_id, grade FROM ascents WHERE status IN (${DONE_SQL})`).all();
}
const bestOf = rows => rows.reduce((b, r) => (gi(r.grade) > gi(b) ? r.grade : b), null);

app.get('/api/profile', auth, (req, res) => {
  const uid = req.user.id;
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  db.prepare('SELECT status, COUNT(*) n FROM statuses WHERE user_id = ? GROUP BY status').all(uid).forEach(r => counts[r.status] = r.n);
  const asc = db.prepare(`SELECT COUNT(*) n FROM ascents WHERE user_id = ? AND status IN (${DONE_SQL})`).get(uid).n;
  const top = db.prepare(`SELECT a.grade, a.color, r.num rel, COUNT(*) n FROM ascents a JOIN voies v ON v.id = a.voie_id JOIN relais r ON r.id = v.relais_id
    WHERE a.user_id = ? AND a.status IN (${DONE_SQL}) GROUP BY a.voie_id ORDER BY n DESC, a.id DESC LIMIT 5`).all(uid);
  const best = bestOf(doneGrades().filter(r => r.uid === uid));
  const sessions = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 40').all(uid);
  const byS = {};
  if (sessions.length) db.prepare(`SELECT session_id, grade, color, status FROM ascents WHERE session_id IN (${sessions.map(s => s.id).join(',')}) ORDER BY id`)
    .all().forEach(a => (byS[a.session_id] ||= []).push(a));
  const out = sessions.map(s => ({ id: s.id, started: s.started_at, ended: s.ended_at, asc: byS[s.id] || [] }));
  res.json({
    stats: { asc, done: DONE.reduce((n, s) => n + counts[s], 0), best, counts, top },
    session: out.find(s => !s.ended) || null, sessions: out.filter(s => s.ended)
  });
});

app.get('/api/club', auth, (_req, res) => {
  const rows = doneGrades();
  const ascN = Object.fromEntries(db.prepare(`SELECT user_id k, COUNT(*) n FROM ascents WHERE status IN (${DONE_SQL}) GROUP BY user_id`).all().map(r => [r.k, r.n]));
  const users = db.prepare('SELECT id, pseudo FROM users').all().map(u => ({
    id: u.id, pseudo: u.pseudo, best: bestOf(rows.filter(r => r.uid === u.id)), asc: ascN[u.id] || 0 }));
  const nV = db.prepare('SELECT COUNT(*) n FROM voies').get().n;
  const nDone = db.prepare(`SELECT COUNT(*) n FROM statuses WHERE status IN (${DONE_SQL})`).get().n;
  const doneBy = Object.fromEntries(db.prepare(`SELECT voie_id k, COUNT(*) n FROM statuses WHERE status IN (${DONE_SQL}) GROUP BY voie_id`).all().map(r => [r.k, r.n]));
  const hard = db.prepare('SELECT v.id, v.grade, v.color, r.num rel FROM voies v JOIN relais r ON r.id = v.relais_id').all()
    .sort((a, b) => gi(b.grade) - gi(a.grade)).slice(0, 5)
    .map(v => ({ ...v, pct: users.length ? Math.round((doneBy[v.id] || 0) / users.length * 100) : 0 }));
  res.json({ users, hard, voies: nV, avg: nV && users.length ? Math.round(nDone / (nV * users.length) * 100) : 0 });
});

// ---------- Administration ----------
app.get('/api/users', auth, admin, (_req, res) => res.json({ users: db.prepare('SELECT id, pseudo, role FROM users ORDER BY pseudo').all() }));
app.put('/api/users/:id/role', auth, admin, (req, res) => {
  const role = req.body.role;
  if (!['user', 'opener', 'admin'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  if (Number(req.params.id) === req.user.id && role !== 'admin') return res.status(400).json({ error: 'Vous ne pouvez pas retirer votre propre rôle administrateur' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ ok: true });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); });
app.listen(PORT, () => console.log(`Topo du mur sur http://localhost:${PORT}`));
