'use strict';
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

/* ---------- Configuración y validación de entorno ---------- */
const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ADMIN_USER = (process.env.ADMIN_USER || '').trim();
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const STORE_NAME = (process.env.STORE_NAME || 'Mi Tienda de Ropa').slice(0, 60);
const WHATSAPP = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');

if (SESSION_SECRET.length < 32) {
  console.error('ERROR: SESSION_SECRET debe tener al menos 32 caracteres (ver .env.example).');
  process.exit(1);
}

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- Base de datos (consultas siempre parametrizadas) ---------- */
const db = new Database(path.join(DATA_DIR, 'tienda.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  sizes TEXT NOT NULL DEFAULT '',
  image TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  product_id INTEGER,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

/* Crea el administrador inicial a partir del .env (solo si no existe ninguno) */
(function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count > 0) return;
  if (!ADMIN_USER || ADMIN_PASS.length < 12 || !/[A-Za-z]/.test(ADMIN_PASS) || !/\d/.test(ADMIN_PASS)) {
    console.error('ERROR: define ADMIN_USER y un ADMIN_PASS de 12+ caracteres con letras y números en .env');
    process.exit(1);
  }
  db.prepare('INSERT INTO admins (username, hash) VALUES (?, ?)')
    .run(ADMIN_USER, bcrypt.hashSync(ADMIN_PASS, 12));
  console.log('Administrador inicial creado. Ya puedes quitar ADMIN_PASS del archivo .env.');
})();

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

/* ---------- App y cabeceras de seguridad ---------- */
const app = express();
app.disable('x-powered-by');
if (PROD) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: PROD ? [] : null
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: PROD ? { maxAge: 31536000, includeSubDomains: true } : false
}));

app.use(express.json({ limit: '20kb' }));

app.use(session({
  name: 'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: PROD,
    maxAge: 2 * 60 * 60 * 1000 // 2 horas de inactividad
  }
  // Nota: MemoryStore sirve para empezar; en producción con mucho tráfico usa un store persistente.
}));

/* ---------- Límites de peticiones ---------- */
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos.' }
});
const formLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Has enviado demasiados formularios. Intenta más tarde.' }
});

app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', apiLimiter);

/* ---------- Protección CSRF (token por sesión en cabecera) ---------- */
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = Buffer.from(String(req.get('x-csrf-token') || ''));
  const real = Buffer.from(String((req.session && req.session.csrf) || ''));
  if (!real.length || sent.length !== real.length || !crypto.timingSafeEqual(sent, real)) {
    return res.status(403).json({ error: 'Solicitud no válida. Recarga la página.' });
  }
  next();
});

/* ---------- Utilidades de validación ---------- */
function text(v, min, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (s.length < min || s.length > max) return null;
  return s;
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+()\-\s]{7,20}$/;
function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'No autorizado.' });
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }

/* ---------- Subida de imágenes ---------- */
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype])
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 12 },
  fileFilter: (req, file, cb) => {
    if (EXT[file.mimetype]) return cb(null, true);
    const e = new Error('Tipo de archivo no permitido'); e.code = 'BAD_FILE'; cb(e);
  }
});
function validImage(file) {
  try {
    const fd = fs.openSync(file.path, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    if (file.mimetype === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (file.mimetype === 'image/png') return b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    if (file.mimetype === 'image/webp') return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  } catch (e) { /* ignorar */ }
  return false;
}
function removeUpload(urlOrFile) {
  if (!urlOrFile) return;
  const name = path.basename(typeof urlOrFile === 'string' ? urlOrFile : urlOrFile.path);
  fs.unlink(path.join(UPLOAD_DIR, name), () => {});
}

/* =====================================================
   API PÚBLICA (clientes)
   ===================================================== */
app.get('/api/csrf', (req, res) => {
  if (!req.session.csrf) req.session.csrf = newToken();
  res.json({ csrf: req.session.csrf });
});

app.get('/api/config', (req, res) => {
  res.json({ storeName: STORE_NAME, whatsapp: WHATSAPP });
});

app.get('/api/products', (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, category, description, price, stock, sizes, image FROM products WHERE active = 1 ORDER BY created_at DESC'
  ).all();
  res.json(rows);
});

app.get('/api/reviews', (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, rating, comment, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC LIMIT 50'
  ).all();
  res.json(rows);
});

app.post('/api/messages', formLimiter, (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot: bots lo rellenan
  const type = b.type === 'compra' ? 'compra' : 'duda';
  const name = text(b.name, 2, 80);
  const email = b.email ? text(b.email, 5, 120) : '';
  const phone = b.phone ? text(b.phone, 7, 20) : '';
  const message = text(b.message, 5, 1000);
  if (!name || !message) return res.status(400).json({ error: 'Completa tu nombre y mensaje.' });
  if (email === null || (email && !EMAIL_RE.test(email))) return res.status(400).json({ error: 'Correo no válido.' });
  if (phone === null || (phone && !PHONE_RE.test(phone))) return res.status(400).json({ error: 'Teléfono no válido.' });
  if (!email && !phone) return res.status(400).json({ error: 'Indica un correo o un teléfono para responderte.' });
  let productId = null;
  if (b.product_id) {
    productId = toId(b.product_id);
    if (!productId || !db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) productId = null;
  }
  db.prepare(
    'INSERT INTO messages (type, name, email, phone, product_id, message, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(type, name, email, phone, productId, message, Date.now());
  res.json({ ok: true });
});

app.post('/api/reviews', formLimiter, (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true });
  const name = text(b.name, 2, 60);
  const comment = text(b.comment, 5, 600);
  const rating = Number(b.rating);
  if (!name || !comment || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Revisa tu nombre, calificación y comentario.' });
  }
  db.prepare('INSERT INTO reviews (name, rating, comment, approved, created_at) VALUES (?,?,?,0,?)')
    .run(name, rating, comment, Date.now());
  res.json({ ok: true, pending: true });
});

/* =====================================================
   API DE ADMINISTRADOR
   ===================================================== */
app.post('/api/admin/login', loginLimiter, async (req, res, next) => {
  try {
    const username = text((req.body || {}).username, 1, 50);
    const password = typeof (req.body || {}).password === 'string' ? req.body.password : '';
    const fail = () => res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    if (!username || !password || password.length > 200) return fail();

    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (admin && admin.locked_until > Date.now()) {
      return res.status(429).json({ error: 'Cuenta bloqueada temporalmente. Intenta más tarde.' });
    }
    // Siempre se compara un hash (aunque el usuario no exista) para no revelar usuarios válidos
    const ok = await bcrypt.compare(password, admin ? admin.hash : DUMMY_HASH);
    if (!admin || !ok) {
      if (admin) {
        const failed = admin.failed + 1;
        const lock = failed >= 5 ? Date.now() + 15 * 60 * 1000 : 0;
        db.prepare('UPDATE admins SET failed = ?, locked_until = ? WHERE id = ?')
          .run(failed >= 5 ? 0 : failed, lock, admin.id);
      }
      return fail();
    }
    db.prepare('UPDATE admins SET failed = 0, locked_until = 0 WHERE id = ?').run(admin.id);
    req.session.regenerate((err) => { // nueva sesión al entrar (evita fijación de sesión)
      if (err) return next(err);
      req.session.admin = admin.id;
      req.session.csrf = newToken();
      res.json({ ok: true, csrf: req.session.csrf });
    });
  } catch (e) { next(e); }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.json({ ok: true });
  });
});

app.get('/api/admin/me', (req, res) => {
  if (req.session && req.session.admin) return res.json({ admin: true, csrf: req.session.csrf });
  res.json({ admin: false });
});

app.post('/api/admin/password', requireAdmin, async (req, res, next) => {
  try {
    const cur = typeof req.body.current === 'string' ? req.body.current : '';
    const nw = typeof req.body.next === 'string' ? req.body.next : '';
    if (nw.length < 12 || nw.length > 200 || !/[A-Za-z]/.test(nw) || !/\d/.test(nw)) {
      return res.status(400).json({ error: 'La nueva contraseña necesita 12+ caracteres con letras y números.' });
    }
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.admin);
    if (!admin || !(await bcrypt.compare(cur, admin.hash))) {
      return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
    }
    db.prepare('UPDATE admins SET hash = ? WHERE id = ?').run(await bcrypt.hash(nw, 12), admin.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function parseProduct(b) {
  const name = text(b.name, 2, 100);
  const category = text(b.category, 2, 50);
  const description = b.description ? text(b.description, 0, 600) : '';
  const sizes = b.sizes ? text(b.sizes, 0, 60) : '';
  const price = Number(b.price);
  const stock = Number(b.stock);
  if (!name || !category || description === null || sizes === null) return { error: 'Revisa nombre, categoría, descripción y tallas.' };
  if (!Number.isFinite(price) || price < 0 || price > 1000000) return { error: 'Precio no válido.' };
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) return { error: 'Existencia no válida.' };
  const active = b.active === '1' || b.active === 'true' || b.active === true ? 1 : 0;
  return { name, category, description, sizes, price: Math.round(price * 100) / 100, stock, active };
}

app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY created_at DESC').all());
});

app.post('/api/admin/products', requireAdmin, upload.single('image'), (req, res) => {
  const p = parseProduct(req.body || {});
  if (p.error) { removeUpload(req.file); return res.status(400).json({ error: p.error }); }
  let image = null;
  if (req.file) {
    if (!validImage(req.file)) { removeUpload(req.file); return res.status(400).json({ error: 'La imagen no es válida.' }); }
    image = '/uploads/' + req.file.filename;
  }
  const info = db.prepare(
    'INSERT INTO products (name, category, description, price, stock, sizes, image, active, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(p.name, p.category, p.description, p.price, p.stock, p.sizes, image, p.active, Date.now());
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/admin/products/:id', requireAdmin, upload.single('image'), (req, res) => {
  const id = toId(req.params.id);
  const old = id && db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!old) { removeUpload(req.file); return res.status(404).json({ error: 'Producto no encontrado.' }); }
  const p = parseProduct(req.body || {});
  if (p.error) { removeUpload(req.file); return res.status(400).json({ error: p.error }); }
  let image = old.image;
  if (req.file) {
    if (!validImage(req.file)) { removeUpload(req.file); return res.status(400).json({ error: 'La imagen no es válida.' }); }
    image = '/uploads/' + req.file.filename;
    removeUpload(old.image);
  }
  db.prepare(
    'UPDATE products SET name=?, category=?, description=?, price=?, stock=?, sizes=?, image=?, active=? WHERE id=?'
  ).run(p.name, p.category, p.description, p.price, p.stock, p.sizes, image, p.active, id);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const id = toId(req.params.id);
  const old = id && db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: 'Producto no encontrado.' });
  db.prepare('UPDATE messages SET product_id = NULL WHERE product_id = ?').run(id);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  removeUpload(old.image);
  res.json({ ok: true });
});

app.get('/api/admin/messages', requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT m.*, p.name AS product_name FROM messages m
     LEFT JOIN products p ON p.id = m.product_id ORDER BY m.created_at DESC LIMIT 500`
  ).all());
});
app.patch('/api/admin/messages/:id/read', requireAdmin, (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID no válido.' });
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(id);
  res.json({ ok: true });
});
app.delete('/api/admin/messages/:id', requireAdmin, (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID no válido.' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/admin/reviews', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 500').all());
});
app.patch('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID no válido.' });
  db.prepare('UPDATE reviews SET approved = ? WHERE id = ?').run(req.body.approved ? 1 : 0, id);
  res.json({ ok: true });
});
app.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID no válido.' });
  db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* =====================================================
   PÁGINAS Y ARCHIVOS
   El código del panel (panel.js) solo se entrega a un admin con sesión.
   ===================================================== */
app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(ROOT, 'admin', 'admin.html'));
});
app.get('/admin/login.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(ROOT, 'admin', 'login.js'));
});
app.get('/admin/panel.js', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(ROOT, 'admin', 'panel.js'));
});

app.use('/uploads', express.static(UPLOAD_DIR, { dotfiles: 'ignore', index: false }));
app.use(express.static(path.join(ROOT, 'public'), { dotfiles: 'ignore' }));

app.use((req, res) => res.status(404).send('No encontrado'));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Archivo no válido (máximo 2 MB).' });
  if (err && err.code === 'BAD_FILE') return res.status(400).json({ error: 'Solo se permiten imágenes JPG, PNG o WEBP.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos no válidos.' });
  console.error(err && err.message);
  res.status(500).json({ error: 'Error interno del servidor.' }); // sin detalles internos
});

app.listen(PORT, () => {
  console.log(`Tienda en http://localhost:${PORT}   |   Panel admin en http://localhost:${PORT}/admin`);
});
