# MAISON NOIR shop: Node.js + Stripe

## Run locally
    npm install
    cp .env.example .env      # add your Stripe TEST keys
    npm start                 # http://localhost:3000

## Test webhooks locally
    stripe listen --forward-to localhost:3000/webhook   # prints whsec_... -> put in .env
    Test card: 4242 4242 4242 4242, any future date, any CVC

## Go live (domain + network)
1. Deploy this folder to Render, Railway, Fly.io or a VPS (Node 18+).
2. Set the env vars from .env.example in the host dashboard (live keys, BASE_URL=https://yourdomain.com).
3. Buy a domain, add the DNS record your host gives you (CNAME/A). HTTPS is automatic on these hosts.
4. In Stripe Dashboard > Developers > Webhooks add https://yourdomain.com/webhook
   events: checkout.session.completed, checkout.session.expired
5. Replace data/orders.json with a real database before real traffic.

## Security checklist (already done in code unless marked TODO)
- [x] Card data never touches your server (Stripe-hosted page, PCI SAQ-A)
- [x] Prices and totals computed server-side from the catalog
- [x] Webhook signature verified, handler idempotent
- [x] helmet headers, rate limiting, input validation, body size limit
- [x] Secrets only in environment variables
- [ ] TODO: HTTPS only (host provides it), set BASE_URL to https
- [ ] TODO: order emails, admin login to view orders, real database, backups
- [ ] TODO: privacy policy, terms, refund policy pages

## Admin panel
Open https://yourdomain.com/admin and sign in with ADMIN_PASSWORD (set in .env).
- See every order (card and cash on delivery), search, filter by status
- Change status, add a tracking number, click "Save & notify customer"
- Emails go out automatically on: paid, COD received, shipped, delivered, cancelled
- Sessions last 8 hours; login is rate limited (10 tries / 15 min)
- Use a long password and keep HTTPS on. Never share SESSION_SECRET.

## Emails
Fill the SMTP_* variables. With no SMTP configured, emails are only printed in the server console,
so you can test everything without sending anything.

## Shop page
/#shop has category, price, colour, "new only" filters and sorting. Edit the product list in
public/index.html (array P) and the matching catalog in server.js (prices are enforced server-side).

## Storefront v2 (public/index.html)
Home, shop with filters and search, product page (gallery zoom, colours, stock per size, size guide,
delivery estimate), wishlist, bag with quantities and free-shipping bar, checkout form, EN/FR/AR (RTL),
info pages, WhatsApp button. Same API as before (/api/checkout, /api/cod), so the server is unchanged.
Placeholders to replace: sample reviews, stock numbers (stock() in index.html, enforce on the server),
WhatsApp number (212600000000), contact details, legal text, newsletter (not connected yet).
