import { inject } from '@vercel/analytics';
inject();
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Stripe from "stripe";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendOrderEmail } from "./email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3000, BASE_URL = "http://localhost:3000",
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  CURRENCY = "usd", FREE_SHIPPING_OVER = 120, SHIPPING_FLAT = 9,
  ADMIN_PASSWORD, SESSION_SECRET = crypto.randomBytes(32).toString("hex"),
} = process.env;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const app = express();

// SERVER-SIDE catalog: prices are NEVER trusted from the browser.
const CATALOG = {
  p1: { name: "Oversized wool coat", price: 289 },
  p2: { name: "Essential cotton tee", price: 39 },
  p3: { name: "Straight-leg trousers", price: 99 },
  p4: { name: "Knit turtleneck", price: 89 },
  p5: { name: "Leather tote bag", price: 179 },
  p6: { name: "Relaxed denim jacket", price: 129 },
  p7: { name: "Pleated midi skirt", price: 79 },
  p8: { name: "Heavyweight hoodie", price: 95 },
};

// Simple JSON-file order store (swap for Postgres/MySQL/MongoDB in production).
const DB = path.join(__dirname, "data", "orders.json");
const readOrders = () => { try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch { return {}; } };
const writeOrders = (o) => fs.writeFileSync(DB, JSON.stringify(o, null, 2));
const saveOrder = (o) => { const all = readOrders(); all[o.id] = o; writeOrders(all); };

// ---- STEP 4: WEBHOOK (must be registered BEFORE express.json) ----
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send("Invalid signature");
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object;
    const orders = readOrders();
    const order = orders[s.metadata?.orderId];
    if (order && order.status !== "paid" && s.payment_status === "paid") { // idempotent
      order.status = "paid";
      order.stripeSession = s.id;
      order.paidAt = new Date().toISOString();
      order.customerEmail = s.customer_details?.email;
      const sd = s.shipping_details || s.collected_information?.shipping_details;
      if (sd) order.ship = { name: sd.name, address: sd.address };
      writeOrders(orders);
      console.log("PAID order", order.id);
      sendOrderEmail(order, "paid").catch(console.error);
    }
  }
  if (event.type === "checkout.session.expired") {
    const s = event.data.object; const orders = readOrders();
    if (orders[s.metadata?.orderId]?.status === "pending") { orders[s.metadata.orderId].status = "expired"; writeOrders(orders); }
  }
  res.json({ received: true });
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 30 }));
app.use(express.static(path.join(__dirname, "public")));

// Validate cart and compute totals on the server.
function buildOrder(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new Error("Invalid cart");
  const lines = items.map((i) => {
    const p = CATALOG[i.id];
    const size = String(i.sz || "").slice(0, 4);
    if (!p || !["XS", "S", "M", "L", "XL"].includes(size)) throw new Error("Invalid item");
    return { id: i.id, name: p.name, price: p.price, size, qty: 1 };
  });
  const subtotal = lines.reduce((t, l) => t + l.price * l.qty, 0);
  const shipping = subtotal >= Number(FREE_SHIPPING_OVER) ? 0 : Number(SHIPPING_FLAT);
  return { id: crypto.randomUUID(), lines, subtotal, shipping, total: subtotal + shipping, currency: CURRENCY, createdAt: new Date().toISOString() };
}

// ---- STEP 2: create the Checkout Session on the server ----
app.post("/api/checkout", async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Card payments not configured yet" });
    const order = { ...buildOrder(req.body.items), status: "pending", method: "card" };
    saveOrder(order);
    const line_items = order.lines.map((l) => ({
      quantity: l.qty,
      price_data: { currency: CURRENCY, unit_amount: Math.round(l.price * 100), product_data: { name: `${l.name} (${l.size})` } },
    }));
    if (order.shipping) line_items.push({ quantity: 1, price_data: { currency: CURRENCY, unit_amount: order.shipping * 100, product_data: { name: "Shipping" } } });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      shipping_address_collection: { allowed_countries: ["MA", "FR", "ES", "US", "GB", "DE", "AE", "SA"] },
      metadata: { orderId: order.id },
      success_url: `${BASE_URL}/?paid=${order.id}`,
      cancel_url: `${BASE_URL}/?cancelled=1`,
    }, { idempotencyKey: order.id });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e.message);
    res.status(400).json({ error: "Could not start checkout" });
  }
});

// ---- Cash on delivery ----
app.post("/api/cod", (req, res) => {
  try {
    const { name, phone, address, city, email } = req.body.customer || {};
    if (![name, phone, address, city].every((v) => typeof v === "string" && v.trim().length > 1)) throw new Error("Missing details");
    const order = { ...buildOrder(req.body.items), status: "cod_pending", method: "cod",
      customer: { email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || "") ? email.slice(0, 120) : "", name: name.slice(0, 80), phone: phone.slice(0, 30), address: address.slice(0, 200), city: city.slice(0, 60) } };
    saveOrder(order);
    sendOrderEmail(order, "cod").catch(console.error);
    res.json({ ok: true, orderId: order.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ================= ADMIN PANEL API =================
const sign = (v) => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("hex");
const makeToken = () => { const exp = String(Date.now() + 8 * 3600e3); return exp + "." + sign(exp); };
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const getCookie = (req, n) => {
  const m = (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(n + "="));
  return m ? decodeURIComponent(m.slice(n.length + 1)) : "";
};
const requireAdmin = (req, res, next) => (validToken(getCookie(req, "adm")) ? next() : res.status(401).json({ error: "Not signed in" }));
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const secure = BASE_URL.startsWith("https") ? "; Secure" : "";

app.post("/api/admin/login", rateLimit({ windowMs: 15 * 60_000, limit: 10 }), (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "Set ADMIN_PASSWORD in .env" });
  if (!crypto.timingSafeEqual(sha(req.body.password), sha(ADMIN_PASSWORD))) return res.status(401).json({ error: "Wrong password" });
  res.setHeader("Set-Cookie", `adm=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`);
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { res.setHeader("Set-Cookie", "adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); res.json({ ok: true }); });
app.get("/api/admin/orders", requireAdmin, (req, res) =>
  res.json(Object.values(readOrders()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))));

const STATUSES = ["pending", "paid", "cod_pending", "cod_confirmed", "shipped", "delivered", "cancelled", "refunded"];
app.post("/api/admin/orders/:id/status", requireAdmin, (req, res) => {
  const orders = readOrders(), o = orders[req.params.id];
  const { status, tracking } = req.body;
  if (!o || !STATUSES.includes(status)) return res.status(400).json({ error: "Bad request" });
  o.status = status;
  if (typeof tracking === "string") o.tracking = tracking.slice(0, 80);
  (o.history ||= []).push({ status, at: new Date().toISOString() });
  writeOrders(orders);
  if (["shipped", "delivered", "cancelled"].includes(status)) sendOrderEmail(o, status).catch(console.error);
  res.json({ ok: true, order: o });
});
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.listen(PORT, () => console.log(`Shop running on ${BASE_URL}`));
