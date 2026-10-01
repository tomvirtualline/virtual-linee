require("dotenv").config();

const express = require("express");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-this";
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PROVIDER_MODE = process.env.NUMBER_PROVIDER_MODE || "demo";

const db = new Database(path.join(__dirname, "store.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,
  country_code TEXT NOT NULL,
  number TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'SMS',
  monthly_price INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  provider_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'pending',
  payment_reference TEXT,
  provisioned_number TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
`);

function seed() {
  const count = db.prepare("SELECT COUNT(*) AS c FROM products").get().c;
  if (!count) {
    const insert = db.prepare(`
      INSERT INTO products(country,country_code,number,type,monthly_price,available,provider_id)
      VALUES (?,?,?,?,?,?,?)
    `);
    const demo = [
      ["United States", "US", "+1 202 555 0148", "SMS", 4500, 1, "demo-us-1"],
      ["United States", "US", "+1 202 555 0176", "SMS + Voice", 6500, 1, "demo-us-2"],
      ["United Kingdom", "GB", "+44 20 7946 0958", "SMS", 5000, 1, "demo-gb-1"],
      ["United Kingdom", "GB", "+44 20 7946 0981", "SMS + Voice", 7500, 1, "demo-gb-2"],
      ["Canada", "CA", "+1 416 555 0112", "SMS", 4800, 1, "demo-ca-1"],
      ["Canada", "CA", "+1 416 555 0193", "SMS + Voice", 6800, 1, "demo-ca-2"]
    ];
    for (const p of demo) insert.run(...p);
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword && adminPassword !== "CHANGE_THIS_ADMIN_PASSWORD") {
    const existing = db.prepare("SELECT id FROM users WHERE email=?").get(adminEmail);
    if (!existing) {
      const hash = bcrypt.hashSync(adminPassword, 12);
      db.prepare("INSERT INTO users(email,password_hash,role) VALUES(?,?,?)")
        .run(adminEmail, hash, "admin");
    }
  }
}
seed();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));
app.use(express.static(path.join(__dirname, "public")));

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
}

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Login required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

function admin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

function providerSearch(countryCode, type) {
  // Demo inventory is local. Replace this adapter with the API of your
  // authorized number provider before production.
  return db.prepare(`
    SELECT * FROM products
    WHERE available=1 AND country_code=? AND type LIKE ?
    ORDER BY monthly_price ASC
  `).all(countryCode, `%${type || ""}%`);
}

async function providerProvision(product) {
  if (PROVIDER_MODE === "demo") {
    return { number: product.number, provider_id: product.provider_id };
  }
  throw new Error("Real provider adapter not configured. Add your authorized provider API implementation.");
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mode: PROVIDER_MODE, payment: PAYSTACK_SECRET_KEY ? "configured" : "demo" });
});

app.get("/api/products", (req, res) => {
  const country = String(req.query.country || "").trim();
  const type = String(req.query.type || "").trim();
  let sql = "SELECT id,country,country_code,number,type,monthly_price,available FROM products WHERE available=1";
  const args = [];
  if (country) { sql += " AND country_code=?"; args.push(country); }
  if (type) { sql += " AND type LIKE ?"; args.push(`%${type}%`); }
  sql += " ORDER BY monthly_price ASC";
  res.json(db.prepare(sql).all(...args));
});

app.post("/api/register", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!email || !email.includes("@") || password.length < 8) {
    return res.status(400).json({ error: "Use a valid email and a password of at least 8 characters." });
  }
  const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (exists) return res.status(409).json({ error: "An account with that email already exists." });
  const hash = await bcrypt.hash(password, 12);
  const info = db.prepare("INSERT INTO users(email,password_hash) VALUES(?,?)").run(email, hash);
  const user = { id: info.lastInsertRowid, email, role: "customer" };
  res.json({ token: sign(user), user });
});

app.post("/api/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  res.json({ token: sign(user), user: { id: user.id, email: user.email, role: user.role } });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/orders", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT o.id,o.amount,o.currency,o.status,o.payment_reference,o.provisioned_number,o.created_at,
           p.country,p.country_code,p.type
    FROM orders o JOIN products p ON p.id=o.product_id
    WHERE o.user_id=? ORDER BY o.id DESC
  `).all(req.user.id);
  res.json(rows);
});

app.post("/api/orders", auth, (req, res) => {
  const productId = Number(req.body.productId);
  const product = db.prepare("SELECT * FROM products WHERE id=? AND available=1").get(productId);
  if (!product) return res.status(404).json({ error: "Number is no longer available." });

  const info = db.prepare(`
    INSERT INTO orders(user_id,product_id,amount,currency,status)
    VALUES(?,?,?,?,?)
  `).run(req.user.id, product.id, product.monthly_price, "NGN", "pending");

  res.json({
    orderId: info.lastInsertRowid,
    amount: product.monthly_price,
    currency: "NGN",
    product
  });
});

app.post("/api/paystack/initialize", auth, async (req, res) => {
  const orderId = Number(req.body.orderId);
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(orderId, req.user.id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  if (!PAYSTACK_SECRET_KEY) {
    // Local demo: never represents real money movement.
    return res.json({
      demo: true,
      authorization_url: `${APP_URL}/dashboard.html?demo_paid=${order.id}`,
      reference: `DEMO-${order.id}-${Date.now()}`
    });
  }

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: req.user.email,
        amount: order.amount * 100,
        currency: "NGN",
        reference: `VL-${order.id}-${Date.now()}`,
        callback_url: `${APP_URL}/api/paystack/callback`
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const data = response.data.data;
    db.prepare("UPDATE orders SET payment_reference=? WHERE id=?").run(data.reference, order.id);
    res.json({ demo: false, authorization_url: data.authorization_url, reference: data.reference });
  } catch (e) {
    res.status(502).json({ error: "Payment initialization failed.", detail: e.response?.data?.message || "Payment provider error" });
  }
});

async function fulfill(orderId) {
  const order = db.prepare("SELECT o.*, p.* FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?").get(orderId);
  if (!order || order.status === "paid") return order;
  const provisioned = await providerProvision(order);
  db.prepare(`
    UPDATE orders SET status='paid',provisioned_number=?,paid_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(provisioned.number, orderId);
  db.prepare("UPDATE products SET available=0 WHERE id=?").run(order.product_id);
  return db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
}

app.get("/api/paystack/callback", async (req, res) => {
  const reference = String(req.query.reference || "");
  if (!reference) return res.redirect("/dashboard.html?payment=missing");
  if (!PAYSTACK_SECRET_KEY) return res.redirect("/dashboard.html?demo_paid=1");

  try {
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const data = verify.data.data;
    if (data.status !== "success") return res.redirect("/dashboard.html?payment=failed");
    const order = db.prepare("SELECT * FROM orders WHERE payment_reference=?").get(reference);
    if (!order) return res.redirect("/dashboard.html?payment=unknown");
    await fulfill(order.id);
    res.redirect("/dashboard.html?payment=success");
  } catch {
    res.redirect("/dashboard.html?payment=error");
  }
});

app.post("/api/paystack/webhook", async (req, res) => {
  // Production webhook signing should be validated against Paystack's
  // documented signature scheme before trusting this endpoint.
  try {
    const reference = req.body?.data?.reference;
    if (reference && req.body?.event === "charge.success") {
      const order = db.prepare("SELECT * FROM orders WHERE payment_reference=?").get(reference);
      if (order) await fulfill(order.id);
    }
  } catch {}
  res.sendStatus(200);
});

app.post("/api/demo/mark-paid", auth, async (req, res) => {
  if (PAYSTACK_SECRET_KEY) return res.status(403).json({ error: "Demo payment is disabled when live payments are configured." });
  const orderId = Number(req.body.orderId);
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(orderId, req.user.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  try {
    const done = await fulfill(order.id);
    res.json({ ok: true, order: done });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/stats", auth, admin, (req, res) => {
  res.json({
    users: db.prepare("SELECT COUNT(*) c FROM users WHERE role='customer'").get().c,
    orders: db.prepare("SELECT COUNT(*) c FROM orders").get().c,
    paid: db.prepare("SELECT COUNT(*) c FROM orders WHERE status='paid'").get().c,
    revenue: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status='paid'").get().s,
    inventory: db.prepare("SELECT COUNT(*) c FROM products WHERE available=1").get().c
  });
});

app.get("/api/admin/orders", auth, admin, (req, res) => {
  res.json(db.prepare(`
    SELECT o.id,o.amount,o.currency,o.status,o.payment_reference,o.provisioned_number,o.created_at,
           u.email,p.country,p.number,p.type
    FROM orders o JOIN users u ON u.id=o.user_id JOIN products p ON p.id=o.product_id
    ORDER BY o.id DESC LIMIT 200
  `).all());
});

app.post("/api/admin/products", auth, admin, (req, res) => {
  const { country, country_code, number, type, monthly_price, provider_id } = req.body;
  if (!country || !country_code || !number || !type || !Number(monthly_price)) {
    return res.status(400).json({ error: "Missing product fields." });
  }
  const info = db.prepare(`
    INSERT INTO products(country,country_code,number,type,monthly_price,available,provider_id)
    VALUES(?,?,?,?,?,?,?)
  `).run(country, country_code.toUpperCase(), number, type, Number(monthly_price), 1, provider_id || null);
  res.json({ id: info.lastInsertRowid });
});

app.post("/api/admin/products/:id/toggle", auth, admin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE products SET available=CASE available WHEN 1 THEN 0 ELSE 1 END WHERE id=?").run(id);
  res.json({ ok: true });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`VirtualLine running at ${APP_URL}`);
  console.log(`Provider mode: ${PROVIDER_MODE}`);
  console.log(`Payments: ${PAYSTACK_SECRET_KEY ? "Paystack configured" : "DEMO MODE (no real charges)"}`);
});
