# Bug Reports - EU Pay QA Technical Assessment

This document provides detailed bug reports for all intentional and uncovered bugs identified in the EU Pay Payment API codebase during manual API testing, code inspection, and automated test execution.

---

## Table of Contents
1. [Bug A: Payment Amount Returned as String Instead of Number](#bug-a-payment-amount-returned-as-string-instead-of-number)
2. [Bug B: Missing Maximum Transaction Amount Validation](#bug-b-missing-maximum-transaction-amount-validation)
3. [Bug C: Overly Permissive Email Validation Regex Permitting Missing TLD](#bug-c-overly-permissive-email-validation-regex-permitting-missing-tld)
4. [Bug D: Missing Webhook HMAC Signature Verification (Spoofing Vulnerability)](#bug-d-missing-webhook-hmac-signature-verification-spoofing-vulnerability)
5. [Bug E: Missing Webhook Idempotency Handling (Replay / Duplicate Delivery Vulnerability)](#bug-e-missing-webhook-idempotency-handling-replay--duplicate-delivery-vulnerability)
6. [Bug F: Missing Duplicate Table Order Prevention for Active Table Orders](#bug-f-missing-duplicate-table-order-prevention-for-active-table-orders)
7. [Bug G: Missing Duplicate E-Invoice Tax Authority Submission Check](#bug-g-missing-duplicate-e-invoice-tax-authority-submission-check)
8. [Bonus Bug H: Invalid Pre-Seeded Password Hash for Test Merchant in Database](#bonus-bug-h-invalid-pre-seeded-password-hash-for-test-merchant-in-database)

---

## Bug A: Payment Amount Returned as String Instead of Number

**Location:** `src/routes/payment.routes.js` (lines 16, 52)  
**Severity:** Medium  
**Component:** Payment API

### How to Reproduce:
1. Start server: `npm start`
2. Obtain a valid JWT token via login:
   ```bash
   curl -X POST http://localhost:3000/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"merchant@test.com","password":"Test123!"}'
   ```
3. Fetch payments list using the token:
   ```bash
   curl -X GET http://localhost:3000/api/payments \
     -H "Authorization: Bearer <TOKEN>"
   ```
4. Observe the `amount` field in each returned payment object:
   ```json
   {
     "success": true,
     "data": [
       {
         "id": "1",
         "amount": "25.5",
         "currency": "EUR",
         "status": "completed"
       }
     ]
   }
   ```
5. Fetch a single payment `GET /api/payments/1` and observe `amount: "25.5"`.

### Expected Behavior:
Currency amounts must be represented as numerical values (`25.5`), matching the API contract and frontend client expectations.

### Actual Behavior:
The `amount` property is explicitly cast to string (`p.amount.toString()`), returning `"25.5"`.

### Impact:
Downstream consumer applications (web apps, mobile apps, reporting engines) performing arithmetic, aggregation, or schema validation face calculation bugs (`25.5 + 10 = "25.510"` string concatenation or `NaN` errors), breaking checkout totals and financial reporting dashboards.

### Root Cause:
In `src/routes/payment.routes.js`, line 16 and line 52:
```javascript
amount: p.amount.toString(),
```
and
```javascript
amount: payment.amount.toString(),
```
The developer explicitly converted the numeric database value to a string.

### Suggested Fix:
Return `amount` as a floating-point number using `parseFloat(p.amount)` or `Number(p.amount)`:
```javascript
amount: parseFloat(p.amount),
```

---

## Bug B: Missing Maximum Transaction Amount Validation

**Location:** `src/routes/payment.routes.js` (line 75)  
**Severity:** High  
**Component:** Payment API

### How to Reproduce:
1. Start server: `npm start`
2. Authenticate and obtain JWT token:
   ```bash
   curl -X POST http://localhost:3000/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"merchant@test.com","password":"Test123!"}'
   ```
3. Submit a payment with an exorbitant amount exceeding reasonable limits (e.g. €999,999,999):
   ```bash
   curl -X POST http://localhost:3000/api/payments \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
       "amount": 999999999,
       "currency": "EUR",
       "customer_email": "buyer@test.com"
     }'
   ```
4. Observe the response:
   ```json
   {
     "success": true,
     "message": "Payment created",
     "data": {
       "id": "3",
       "amount": 999999999,
       "currency": "EUR",
       "status": "pending"
     }
   }
   ```

### Expected Behavior:
Payment creation should enforce regulatory and risk-based maximum transaction thresholds (e.g., maximum €50,000 per transaction). Values exceeding €50,000 should be rejected with HTTP status `400 Bad Request` and a descriptive error message such as `"Amount exceeds maximum limit of €50,000"`.

### Actual Behavior:
The API only checks `amount <= 0` and lacks any upper bound check, allowing multi-million or billion-euro payment authorizations without risk controls.

### Impact:
Extreme risk of fraud, money laundering, unauthorized balance depletion, chargeback liability, and regulatory non-compliance with European Anti-Money Laundering (AML) / PSD2 transaction limitations.

### Root Cause:
In `src/routes/payment.routes.js`, lines 71-77:
```javascript
if (!amount || isNaN(amount) || amount <= 0) {
  return res.status(400).json({ error: 'Valid amount is required' });
}
// BUG B: No maximum amount check - allows unrealistic amounts
```
There is no upper ceiling check on `amount`.

### Suggested Fix:
Add an upper boundary check against maximum transaction allowance (`€50,000`):
```javascript
const MAX_AMOUNT = 50000;
if (amount > MAX_AMOUNT) {
  return res.status(400).json({ error: 'Amount exceeds maximum limit of €50,000' });
}
```

---

## Bug C: Overly Permissive Email Validation Regex Permitting Missing TLD

**Location:** `src/routes/auth.routes.js` (lines 10-14)  
**Severity:** Medium  
**Component:** Auth API

### How to Reproduce:
1. Start server: `npm start`
2. Submit a registration request with an email lacking a top-level domain (`user@domain` or `merchant@localhost`):
   ```bash
   curl -X POST http://localhost:3000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{
       "email": "user@domain",
       "password": "Password123!",
       "business_name": "Test Org"
     }'
   ```
3. Observe the response:
   ```json
   {
     "message": "Registration successful",
     "user": {
       "id": "2",
       "email": "user@domain",
       "business_name": "Test Org"
     },
     "token": "eyJhbGciOi..."
   }
   ```

### Expected Behavior:
The API should validate that the email has an RFC-compliant structure, including a valid domain and top-level domain (e.g., `.com`, `.eu`, `.org`). Incomplete emails like `user@domain` should be rejected with HTTP status `400 Bad Request` and `{"error": "Invalid email format"}`.

### Actual Behavior:
The regex `/^[^\s@]+@[^\s@]+$/` only verifies that an `@` character is present with non-whitespace characters on both sides, allowing invalid addresses such as `user@domain`, `admin@local`, and `foo@bar`.

### Impact:
Invalid and unroutable email addresses pollute merchant accounts, preventing critical transactional emails (password resets, payment receipts, compliance notices) and creating security and account recovery failure points.

### Root Cause:
In `src/routes/auth.routes.js`, lines 10-14:
```javascript
function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+$/;
  return emailRegex.test(email);
}
```
The regex does not demand a domain dot separator or a TLD.

### Suggested Fix:
Update the validation function to enforce a valid domain, dot separator, TLD of at least 2 characters, and prevent consecutive dots:
```javascript
export function validateEmail(email) {
  if (typeof email !== 'string' || email.includes('..')) {
    return false;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}
```

---

## Bug D: Missing Webhook HMAC Signature Verification (Spoofing Vulnerability)

**Location:** `src/routes/webhook.routes.js` (lines 21-33)  
**Severity:** Critical  
**Component:** Webhook API

### How to Reproduce:
1. Start server: `npm start`
2. Send a forged payment completion webhook without any signature header or with a fabricated signature:
   ```bash
   curl -X POST http://localhost:3000/api/webhooks/payment-status \
     -H "Content-Type: application/json" \
     -d '{
       "payment_id": "2",
       "status": "completed",
       "event_id": "evt_hacked_123"
     }'
   ```
3. Observe the response:
   ```json
   {
     "success": true,
     "message": "Webhook processed",
     "payment_id": "2",
     "new_status": "completed"
   }
   ```
4. Query the payment status `GET /api/payments/2` — payment status was successfully manipulated to `"completed"`.

### Expected Behavior:
Payment gateway webhooks must be cryptographically verified using HMAC-SHA256 with a pre-shared secret key. Requests lacking `x-webhook-signature` or carrying an invalid signature must be rejected with HTTP status `401 Unauthorized` and `{"error": "Invalid signature"}` (or `{"error": "Webhook signature required"}`).

### Actual Behavior:
The signature verification logic was entirely commented out. The endpoint accepts any unauthenticated POST request and updates financial status in the database.

### Impact:
Critical financial vulnerability. Any malicious actor can spoof payment confirmation events, enabling fraudulent order fulfillment and theft of goods or services without actual settlement.

### Root Cause:
In `src/routes/webhook.routes.js`, lines 21-33:
```javascript
// BUG D: No signature verification
// Real systems MUST verify webhook signatures to prevent spoofing
// Missing validation below:
// const expectedSignature = crypto...
```
The signature verification block was commented out.

### Suggested Fix:
Verify the incoming `x-webhook-signature` header against HMAC-SHA256 of `req.body`:
```javascript
if (!signature) {
  return res.status(401).json({ error: 'Webhook signature required' });
}

const expectedSignature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(JSON.stringify(req.body))
  .digest('hex');

if (signature !== expectedSignature) {
  return res.status(401).json({ error: 'Invalid signature' });
}
```

---

## Bug E: Missing Webhook Idempotency Handling (Replay / Duplicate Delivery Vulnerability)

**Location:** `src/routes/webhook.routes.js` (lines 38-44, 55-57)  
**Severity:** High  
**Component:** Webhook API

### How to Reproduce:
1. Start server: `npm start`
2. Submit a valid webhook event `evt_order_pay_100` updating payment status:
   ```bash
   curl -X POST http://localhost:3000/api/webhooks/payment-status \
     -H "Content-Type: application/json" \
     -H "x-webhook-signature: <VALID_HMAC>" \
     -d '{
       "payment_id": "1",
       "status": "completed",
       "event_id": "evt_order_pay_100"
     }'
   ```
3. Re-send the exact same webhook payload immediately (simulating network retry or replay):
   ```bash
   curl -X POST http://localhost:3000/api/webhooks/payment-status \
     -H "Content-Type: application/json" \
     -H "x-webhook-signature: <VALID_HMAC>" \
     -d '{
       "payment_id": "1",
       "status": "completed",
       "event_id": "evt_order_pay_100"
     }'
   ```
4. Observe that both requests return `{"message": "Webhook processed"}` and mutate the payment record timestamp repeatedly.

### Expected Behavior:
Webhooks in payment systems must be idempotent. If an `event_id` has already been processed, subsequent deliveries must be recognized as duplicate, returning HTTP 200 with `{"message": "Already processed"}` without re-triggering business logic or state mutations.

### Actual Behavior:
The idempotency check and `db.processed_webhooks.push(event_id)` were commented out. Every duplicate request re-executes status mutation and updates `webhook_received_at`.

### Impact:
Duplicate deliveries (standard in payment provider networks like Stripe, Powens, or Adyen) trigger duplicate downstream actions (duplicate order receipts, duplicate balance credits, race conditions in state machines, and webhook replay exploits).

### Root Cause:
In `src/routes/webhook.routes.js`, lines 38-44 and 55-57:
The check `if (db.processed_webhooks.includes(event_id))` and `db.processed_webhooks.push(event_id)` were commented out.

### Suggested Fix:
Check if `event_id` is present in `db.processed_webhooks` and record it after processing:
```javascript
if (!db.processed_webhooks) {
  db.processed_webhooks = [];
}
if (event_id && db.processed_webhooks.includes(event_id)) {
  return res.status(200).json({
    success: true,
    message: 'Already processed',
    event_id,
    payment_id
  });
}
// ... update payment status ...
if (event_id) {
  db.processed_webhooks.push(event_id);
}
```

---

## Bug F: Missing Duplicate Table Order Prevention for Active Table Orders

**Location:** `src/routes/table-order.routes.js` (lines 44-56)  
**Severity:** Medium  
**Component:** Table Orders API

### How to Reproduce:
1. Start server: `npm start`
2. Submit a table order for Table 5:
   ```bash
   curl -X POST http://localhost:3000/api/table-orders \
     -H "Content-Type: application/json" \
     -d '{
       "merchant_id": "1",
       "table_number": 5,
       "customer_name": "Customer 1",
       "items": [{"name": "Steak", "price": 25.0, "quantity": 1}]
     }'
   ```
3. Submit a second order for Table 5 while the first order is still in `'pending'` status:
   ```bash
   curl -X POST http://localhost:3000/api/table-orders \
     -H "Content-Type: application/json" \
     -d '{
       "merchant_id": "1",
       "table_number": 5,
       "customer_name": "Customer 2",
       "items": [{"name": "Wine", "price": 10.0, "quantity": 1}]
     }'
   ```
4. Observe that both orders are created simultaneously with status `'pending'`.

### Expected Behavior:
A physical restaurant table should not accept a new order while an existing order for that table is still `'pending'`. It should return HTTP `409 Conflict` with `{"error": "Table already has a pending order"}`.

### Actual Behavior:
The existing order check was commented out. Multiple pending orders can be generated concurrently on the same table.

### Impact:
Kitchen and staff confusion, duplicate item preparation, lost revenue, and conflicting order fulfillment for patrons at the same table.

### Root Cause:
In `src/routes/table-order.routes.js`, lines 44-56:
```javascript
// BUG F: No duplicate order prevention
// Should check if table already has a pending order
// Missing validation below:
// const existingOrder = ...
```
The duplicate check logic was commented out.

### Suggested Fix:
Verify if an existing order with `status === 'pending'` exists for that `merchant_id` and `table_number`:
```javascript
const existingOrder = (db.table_orders || []).find(
  o => o.merchant_id === merchant_id && 
       o.table_number === table_number && 
       o.status === 'pending'
);
if (existingOrder) {
  return res.status(409).json({ error: 'Table already has a pending order' });
}
```

---

## Bug G: Missing Duplicate E-Invoice Tax Authority Submission Check

**Location:** `src/routes/einvoice.routes.js` (lines 50-59)  
**Severity:** Medium  
**Component:** E-Invoicing API

### How to Reproduce:
1. Start server: `npm start`
2. Submit an e-invoice for the first time:
   ```bash
   curl -X POST http://localhost:3000/api/einvoice/submit \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
       "invoice_id": "INV-2026-001",
       "customer_siret": "12345678901234"
     }'
   ```
   Returns HTTP `200 OK` with `submission_id`.
3. Submit the same invoice (`INV-2026-001`) a second time:
   ```bash
   curl -X POST http://localhost:3000/api/einvoice/submit \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
       "invoice_id": "INV-2026-001",
       "customer_siret": "12345678901234"
     }'
   ```
4. Observe that the API accepts the second submission, generates a new `submission_id`, and overwrites `submitted_at`.

### Expected Behavior:
European tax authority regulations (e.g., French DGFiP / Seqino PDP) strictly mandate that invoices submitted or accepted cannot be resubmitted. Submissions for already submitted or accepted invoices must be rejected with HTTP status `409 Conflict` and `{"error": "Invoice already submitted to tax authority"}`.

### Actual Behavior:
The duplicate check was commented out. The API re-submits the invoice and updates the record with a new submission ID.

### Impact:
Severe regulatory non-compliance, potential tax authority penalties, corrupted submission tracking IDs, and double-taxation or rejection by government gateways.

### Root Cause:
In `src/routes/einvoice.routes.js`, lines 50-59:
```javascript
// BUG G: No duplicate submission check
// Should prevent submitting the same invoice twice
// Missing validation below:
// if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') ...
```
The check was commented out.

### Suggested Fix:
Enforce state validation prior to submission:
```javascript
if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
  return res.status(409).json({ 
    error: 'Invoice already submitted to tax authority' 
  });
}
```

---

## Bonus Bug H: Invalid Pre-Seeded Password Hash for Test Merchant in Database

**Location:** `src/db/database.js` (line 19)  
**Severity:** High  
**Component:** Database / Auth API

### How to Reproduce:
1. Start server: `npm start`
2. Follow the Quick Start instructions in `README.md` to log in with the pre-seeded merchant:
   ```bash
   curl -X POST http://localhost:3000/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"merchant@test.com","password":"Test123!"}'
   ```
3. Observe the response:
   ```json
   {
     "error": "Invalid credentials"
   }
   ```
   HTTP Status: `401 Unauthorized`.

### Expected Behavior:
The seeded test account `merchant@test.com` should authenticate successfully with the documented credentials `{"email":"merchant@test.com","password":"Test123!"}`, returning HTTP `200 OK` and a valid JWT token.

### Actual Behavior:
The password hash in `src/db/database.js` was set to a synthetic placeholder string:
`"$2a$10$8Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9"`
`bcrypt.compare("Test123!", hash)` evaluates to `false`, completely blocking API consumers from logging in with the default test merchant.

### Impact:
Blocks manual and automated integration testing of all authenticated endpoints (`/api/payments`, `/api/table-orders`, `/api/einvoice`) using default documentation credentials.

### Root Cause:
In `src/db/database.js`, line 19:
The password field contained an invalid repeated dummy string rather than a valid bcrypt-hashed representation of `"Test123!"`.

### Suggested Fix:
Replace the placeholder with the genuine bcrypt hash of `"Test123!"` (generated with cost factor 10):
```javascript
password: "$2a$10$E1i3VZE3Vi.DeA4/l9OSz.NwIMIcx95lrhmwdE795n68.fXAAofR6", // password: Test123!
```
