import nodemailer from "nodemailer";
const { SMTP_HOST, SMTP_PORT = 587, SMTP_USER, SMTP_PASS, MAIL_FROM, ADMIN_EMAIL, STORE_NAME = "MAISON NOIR", CURRENCY = "usd" } = process.env;
const tx = SMTP_HOST ? nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT), secure: Number(SMTP_PORT) === 465, auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined }) : null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => new Intl.NumberFormat("en", { style: "currency", currency: CURRENCY.toUpperCase() }).format(n);

const COPY = {
  paid:      ["Thank you, your order is confirmed", "We received your payment and are preparing your order."],
  cod:       ["Order received", "Please keep your phone close: we will call you to confirm delivery. You pay when it arrives."],
  shipped:   ["Your order is on its way", "Good news: your order has been shipped."],
  delivered: ["Delivered", "Your order has been delivered. We hope you love it."],
  cancelled: ["Order cancelled", "Your order has been cancelled. If you have questions, just reply to this email."],
};

function html(order, kind) {
  const [title, intro] = COPY[kind];
  const rows = order.lines.map((l) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(l.name)}<br><small style="color:#777">Size ${esc(l.size)}</small></td><td style="text-align:right;border-bottom:1px solid #eee">${money(l.price)}</td></tr>`).join("");
  const addr = order.customer ? `${esc(order.customer.name)}<br>${esc(order.customer.address)}, ${esc(order.customer.city)}` : (order.ship ? `${esc(order.ship.name)}<br>${esc(Object.values(order.ship.address || {}).filter(Boolean).join(", "))}` : "");
  const track = order.tracking ? `<p><b>Tracking:</b> ${esc(order.tracking)}</p>` : "";
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:auto;color:#111">
  <h2 style="letter-spacing:.3em;font-weight:600">${esc(STORE_NAME)}</h2><h3 style="font-weight:400">${title}</h3><p>${intro}</p>${track}
  <p style="color:#777;font-size:12px">ORDER ${esc(order.id.slice(0, 8).toUpperCase())}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
  <tr><td style="padding-top:8px">Shipping</td><td style="text-align:right">${order.shipping ? money(order.shipping) : "Free"}</td></tr>
  <tr><td><b>Total</b></td><td style="text-align:right"><b>${money(order.total)}</b></td></tr></table>
  ${addr ? `<p style="font-size:13px"><b>Delivery to</b><br>${addr}</p>` : ""}</div>`;
}

export async function sendOrderEmail(order, kind) {
  const to = order.customerEmail || order.customer?.email;
  const subject = `${STORE_NAME}: ${COPY[kind][0]} (#${order.id.slice(0, 8).toUpperCase()})`;
  const jobs = [];
  if (to) jobs.push({ to, subject, html: html(order, kind) });
  if ((kind === "paid" || kind === "cod") && ADMIN_EMAIL) jobs.push({ to: ADMIN_EMAIL, subject: `NEW ORDER: ${money(order.total)} (${order.method})`, html: html(order, kind) });
  for (const j of jobs) {
    if (!tx) { console.log(`[email disabled] would send "${j.subject}" to ${j.to}`); continue; }
    try { await tx.sendMail({ from: MAIL_FROM || SMTP_USER, ...j }); }
    catch (e) { console.error("Email failed:", e.message); }
  }
}
