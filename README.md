# VirtualLine — full-stack virtual-number store

This package gives you a working storefront and backend starter. It runs locally in demo mode without real payments or a telecom account.

## What is included

- Responsive storefront
- Customer registration/login
- Customer dashboard
- Product/number inventory
- Order database using SQLite
- Admin dashboard
- Product/inventory management
- Paystack initialization + callback/webhook skeleton
- Provider adapter point for a real virtual-number/CPaaS provider
- Security middleware, password hashing, JWT authentication, rate limiting
- Acceptable-use reminder

## Run it

1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Change `JWT_SECRET`.
4. For a local demo, leave `PAYSTACK_SECRET_KEY` blank and keep `NUMBER_PROVIDER_MODE=demo`.
5. Install dependencies:

   npm install

6. Start:

   npm start

7. Open:

   http://localhost:3000

## Admin

Set these in `.env` before starting:

ADMIN_EMAIL=your-admin-email
ADMIN_PASSWORD=a-strong-password

The admin account is created automatically the first time the server starts with those values.

Then open `/admin.html`.

## Going live

Two integrations still have to be connected:

### 1. Payment

Add your Paystack secret key to `.env`. Never put the secret key in browser JavaScript or commit it to Git.

Before production, verify Paystack webhook signatures exactly according to their current documentation and configure the webhook URL for your deployed domain.

### 2. Real number provider

`providerProvision()` in `server.js` is intentionally a provider-neutral adapter. Replace it with the API calls for a number provider that has terms permitting your intended business model.

The app must only display/provision numbers that you are authorized to manage or resell.

## Production checklist

- HTTPS
- Strong JWT secret
- Strong unique admin password
- Real payment provider account
- Verified payment webhooks
- Authorized number provider
- Provider webhooks for inbound SMS/voice if needed
- Customer support contact
- Terms of Service
- Privacy Policy
- Refund/Cancellation Policy
- Acceptable Use / Abuse Policy
- Identity/anti-fraud controls appropriate to your service
- Backups and monitoring
- Domain + email sending service

## Important

Do not advertise or use the service for bypassing platform verification, fraud, spam, impersonation, harassment, or other abuse. Follow the laws and the terms of the providers and platforms you integrate with.

This is a complete buildable starter, not a claim that payment/provider accounts have already been opened or connected.
