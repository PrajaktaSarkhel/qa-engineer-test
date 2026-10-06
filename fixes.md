# Bug Fixes Documentation - EU Pay QA Technical Assessment

This document provides complete, line-by-line documentation of all code modifications made to resolve the 7 intentional bugs (and bonus bug H) across the EU Pay Payment API.

---

## Summary of Fixes

| Bug ID | Component | Summary | Target File | Status |
|:---:|:---|:---|:---|:---:|
| **Bug A** | Payment API | Return payment amount as number instead of string | `src/routes/payment.routes.js` | ✅ Fixed |
| **Bug B** | Payment API | Enforce maximum payment transaction limit (€50,000) | `src/routes/payment.routes.js` | ✅ Fixed |
| **Bug C** | Auth API | Enforce valid email format requiring domain and TLD | `src/routes/auth.routes.js` | ✅ Fixed |
| **Bug D** | Webhook API | Enforce HMAC-SHA256 signature verification | `src/routes/webhook.routes.js` | ✅ Fixed |
| **Bug E** | Webhook API | Implement webhook idempotency handling via `event_id` | `src/routes/webhook.routes.js` | ✅ Fixed |
| **Bug F** | Table Orders | Prevent duplicate pending orders on the same table | `src/routes/table-order.routes.js` | ✅ Fixed |
| **Bug G** | E-Invoicing | Prevent duplicate submissions to tax authority | `src/routes/einvoice.routes.js` | ✅ Fixed |
| **Bug H** | Database | Fix invalid bcrypt hash for default test merchant | `src/db/database.js` | ✅ Fixed |

---

## Fix 1: Payment Amount Data Type (Bug A)

**Bug:** Payment amount was converted to string (`p.amount.toString()`) in `GET /api/payments` and `GET /api/payments/:id`.

**Files Changed:**
- `src/routes/payment.routes.js` (lines 14-16, 50-52)

**Code Changes:**
```diff
--- a/src/routes/payment.routes.js
+++ b/src/routes/payment.routes.js
@@ -13,4 +13,4 @@
-    // BUG A: Amount is being converted to string instead of remaining as number
+    // Fix Bug A: Amount should be returned as number, not string
     const formattedPayments = payments.map(p => ({
       id: p.id,
-      amount: p.amount.toString(), // ← BUG: Should be number, not string
+      amount: parseFloat(p.amount),
@@ -51,2 +51,2 @@
         id: payment.id,
-        amount: payment.amount.toString(), // Same bug as above
+        amount: parseFloat(payment.amount), // Fix Bug A: Return as number
```

**Why This Fix:**
Frontend applications and automated accounting pipelines expect numeric types for amounts. When represented as strings, mathematical operations result in incorrect string concatenation (e.g., `"25.5" + 10 = "25.510"`), causing UI errors, incorrect basket sums, and schema validation failures. Using `parseFloat(p.amount)` guarantees precise numeric representation according to API specifications.

**Testing:**
```bash
curl http://localhost:3000/api/payments -H "Authorization: Bearer <TOKEN>"
# Response:
# "amount": 25.5 (typeof number)
```
Automated Test: `src/routes/__tests__/payment.routes.test.js` -> Passed.

---

## Fix 2: Maximum Payment Amount Limit (Bug B)

**Bug:** `POST /api/payments` allowed unrealistic and unbounded transaction amounts (e.g. €999,999,999) without upper bound validation.

**Files Changed:**
- `src/routes/payment.routes.js` (lines 75-78)

**Code Changes:**
```diff
--- a/src/routes/payment.routes.js
+++ b/src/routes/payment.routes.js
@@ -74,4 +74,4 @@
-    // BUG B: No maximum amount check - allows unrealistic amounts
-    // Real systems should have limits (e.g., max €50,000 per transaction)
-    // Missing: if (amount > 50000) { return 400 }
+    // Fix Bug B: Maximum amount validation (e.g., max €50,000 per transaction)
+    if (amount > 50000) {
+      return res.status(400).json({ error: 'Amount exceeds maximum limit of €50,000' });
+    }
```

**Why This Fix:**
Financial compliance standards (AML/PSD2) and risk management policies require strict transaction ceilings to mitigate fraud, unauthorized balance drainage, and system abuse. Any payment exceeding €50,000 is rejected immediately with HTTP 400 Bad Request.

**Testing:**
```bash
curl -X POST http://localhost:3000/api/payments \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"amount":999999999,"currency":"EUR","customer_email":"test@test.com"}'
# Response:
# HTTP 400 Bad Request
# {"error": "Amount exceeds maximum limit of €50,000"}
```
Automated Test: `src/routes/__tests__/payment.routes.test.js` -> Passed.

---

## Fix 3: Strict Email Format Validation (Bug C)

**Bug:** Email validation used an overly permissive regex (`/^[^\s@]+@[^\s@]+$/`) that allowed emails lacking top-level domains (e.g. `user@domain`).

**Files Changed:**
- `src/routes/auth.routes.js` (lines 9-14)

**Code Changes:**
```diff
--- a/src/routes/auth.routes.js
+++ b/src/routes/auth.routes.js
@@ -9,6 +9,8 @@
-// BUG C: Email validation is too permissive
-function validateEmail(email) {
-  // BUG: This regex allows emails without TLD like "user@domain"
-  const emailRegex = /^[^\s@]+@[^\s@]+$/;
+// Fix Bug C: Require valid domain and top-level domain (TLD)
+export function validateEmail(email) {
+  if (typeof email !== 'string' || email.includes('..')) {
+    return false;
+  }
+  const emailRegex = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
   return emailRegex.test(email);
 }
```

**Why This Fix:**
Valid email delivery is essential for merchant onboarding, two-factor authentication, payment receipts, and compliance notifications. Requiring a dot separator, a TLD of at least 2 alphabetic characters, and disallowing consecutive dots prevents unroutable local hostnames and malformed addresses from entering the system.

**Testing:**
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@domain","password":"Password123!","business_name":"Test"}'
# Response:
# HTTP 400 Bad Request
# {"error": "Invalid email format"}
```
Automated Test: `src/routes/__tests__/auth.routes.test.js` -> Passed.

---

## Fix 4: Webhook HMAC Signature Verification (Bug D)

**Bug:** Payment status webhook endpoint had signature verification commented out, allowing unauthenticated attackers to spoof payment completions.

**Files Changed:**
- `src/routes/webhook.routes.js` (lines 21-33)

**Code Changes:**
```diff
--- a/src/routes/webhook.routes.js
+++ b/src/routes/webhook.routes.js
@@ -7,2 +7,2 @@
 // Webhook secret for HMAC verification
-const WEBHOOK_SECRET = 'test-webhook-secret-key';
+export const WEBHOOK_SECRET = 'test-webhook-secret-key';
@@ -21,13 +21,13 @@
-    // BUG D: No signature verification
-    // Real systems MUST verify webhook signatures to prevent spoofing
-    // Missing validation below:
-    
-    // const expectedSignature = crypto
-    //   .createHmac('sha256', WEBHOOK_SECRET)
-    //   .update(JSON.stringify(req.body))
-    //   .digest('hex');
-    // 
-    // if (signature !== expectedSignature) {
-    //   return res.status(401).json({ error: 'Invalid signature' });
-    // }
+    // Fix Bug D: Webhook signature verification (HMAC SHA-256)
+    if (!signature) {
+      return res.status(401).json({ error: 'Webhook signature required' });
+    }
+
+    const expectedSignature = crypto
+      .createHmac('sha256', WEBHOOK_SECRET)
+      .update(JSON.stringify(req.body))
+      .digest('hex');
+
+    if (signature !== expectedSignature) {
+      return res.status(401).json({ error: 'Invalid signature' });
+    }
```

**Why This Fix:**
Webhooks originate from external providers across public networks. Cryptographic verification using HMAC-SHA256 proves both authenticity (originated by the trusted payment provider) and integrity (payload was not modified in transit). Unauthorized requests are rejected with HTTP 401.

**Testing:**
```bash
# Request without signature:
curl -X POST http://localhost:3000/api/webhooks/payment-status \
  -H "Content-Type: application/json" \
  -d '{"payment_id":"1","status":"completed","event_id":"evt_1"}'
# Response: HTTP 401 Unauthorized, {"error": "Webhook signature required"}

# Request with forged signature:
curl -X POST http://localhost:3000/api/webhooks/payment-status \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: forged_sig" \
  -d '{"payment_id":"1","status":"completed","event_id":"evt_1"}'
# Response: HTTP 401 Unauthorized, {"error": "Invalid signature"}
```
Automated Test: `src/routes/__tests__/webhook.routes.test.js` -> Passed.

---

## Fix 5: Webhook Idempotency Check (Bug E)

**Bug:** Payment status webhooks were executed repeatedly upon duplicate delivery of the same `event_id`, lacking idempotency safeguards.

**Files Changed:**
- `src/routes/webhook.routes.js` (lines 38-44, 55-57)

**Code Changes:**
```diff
--- a/src/routes/webhook.routes.js
+++ b/src/routes/webhook.routes.js
@@ -38,7 +38,15 @@
-    // BUG E: No idempotency check
-    // Webhooks can be delivered multiple times - must be idempotent
-    // Missing check below:
-    
-    // if (db.processed_webhooks.includes(event_id)) {
-    //   return res.status(200).json({ message: 'Already processed' });
-    // }
+    // Fix Bug E: Webhook idempotency check
+    if (!db.processed_webhooks) {
+      db.processed_webhooks = [];
+    }
+    if (event_id && db.processed_webhooks.includes(event_id)) {
+      return res.status(200).json({
+        success: true,
+        message: 'Already processed',
+        event_id,
+        payment_id
+      });
+    }
@@ -55,3 +63,5 @@
-    // Mark webhook as processed (if idempotency was implemented)
-    // db.processed_webhooks.push(event_id);
+    // Mark webhook as processed
+    if (event_id) {
+      db.processed_webhooks.push(event_id);
+    }
```

**Why This Fix:**
Distributed payment networks operate on "at-least-once" delivery semantics. Idempotency guarantees that processing a webhook multiple times yields the same final state as processing it once, preventing duplicate fulfillments, multiple database updates, and race conditions.

**Testing:**
```bash
# First delivery:
# HTTP 200 OK -> {"message": "Webhook processed"}
# Second delivery with identical event_id:
# HTTP 200 OK -> {"message": "Already processed", "event_id": "evt_100"}
```
Automated Test: `src/routes/__tests__/webhook.routes.test.js` -> Passed.

---

## Fix 6: Duplicate Table Order Prevention (Bug F)

**Bug:** `POST /api/table-orders` allowed multiple simultaneous orders for the same restaurant table while an existing order was still in `'pending'` state.

**Files Changed:**
- `src/routes/table-order.routes.js` (lines 44-56)

**Code Changes:**
```diff
--- a/src/routes/table-order.routes.js
+++ b/src/routes/table-order.routes.js
@@ -44,13 +44,10 @@
-    // BUG F: No duplicate order prevention
-    // Should check if table already has a pending order
-    // Missing validation below:
-    
-    // const existingOrder = (db.table_orders || []).find(
-    //   o => o.merchant_id === merchant_id && 
-    //        o.table_number === table_number && 
-    //        o.status === 'pending'
-    // );
-    // if (existingOrder) {
-    //   return res.status(409).json({ error: 'Table already has a pending order' });
-    // }
+    // Fix Bug F: Prevent duplicate table order if table already has a pending order
+    const existingOrder = (db.table_orders || []).find(
+      o => o.merchant_id === merchant_id && 
+           o.table_number === table_number && 
+           o.status === 'pending'
+    );
+    if (existingOrder) {
+      return res.status(409).json({ error: 'Table already has a pending order' });
+    }
```

**Why This Fix:**
In dining establishments, tables should have a single active pending order at a time to prevent accidental double-ordering by customers or concurrent waiters, kitchen confusion, and food waste. When an existing pending order is present, the API responds with HTTP 409 Conflict.

**Testing:**
```bash
# Order 1 for Table 5 -> HTTP 201 Created (status: pending)
# Order 2 for Table 5 -> HTTP 409 Conflict {"error": "Table already has a pending order"}
# After Order 1 transitions to 'confirmed' -> Order 2 for Table 5 succeeds with HTTP 201
```
Automated Test: `src/routes/__tests__/table-order.routes.test.js` -> Passed.

---

## Fix 7: Duplicate E-Invoice Submission Prevention (Bug G)

**Bug:** `POST /api/einvoice/submit` allowed repeated submission of invoices already submitted or accepted by the tax authority.

**Files Changed:**
- `src/routes/einvoice.routes.js` (lines 50-59)

**Code Changes:**
```diff
--- a/src/routes/einvoice.routes.js
+++ b/src/routes/einvoice.routes.js
@@ -50,10 +50,7 @@
-    // BUG G: No duplicate submission check
-    // Should prevent submitting the same invoice twice
-    // Missing validation below:
-    
-    // if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
-    //   return res.status(409).json({ 
-    //     error: 'Invoice already submitted to tax authority' 
-    //   });
-    // }
+    // Fix Bug G: Prevent duplicate e-invoice submission
+    if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
+      return res.status(409).json({ 
+        error: 'Invoice already submitted to tax authority' 
+      });
+    }
```

**Why This Fix:**
Government tax platforms (such as the French PDP Seqino / Chorus Pro) enforce strict immutability on invoice submissions. Submitting an invoice twice causes gateway rejection, duplicate VAT liability records, and compliance audit penalties. Resubmissions of submitted or accepted invoices are blocked with HTTP 409 Conflict.

**Testing:**
```bash
# First submission:
curl -X POST http://localhost:3000/api/einvoice/submit \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"invoice_id":"INV-1","customer_siret":"12345678901234"}'
# Response: HTTP 200 OK (status: submitted)

# Second submission:
curl -X POST http://localhost:3000/api/einvoice/submit \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"invoice_id":"INV-1","customer_siret":"12345678901234"}'
# Response: HTTP 409 Conflict {"error": "Invoice already submitted to tax authority"}
```
Automated Test: `src/routes/__tests__/einvoice.routes.test.js` -> Passed.

---

## Bonus Fix 8: Seed Merchant Bcrypt Password Hash (Bug H)

**Bug:** The pre-seeded test merchant account (`merchant@test.com`) in `src/db/database.js` had a corrupted dummy hash (`$2a$10$8Z3KxGXvGqJQZ...`), causing login attempts using the documented password `Test123!` to fail with HTTP 401.

**Files Changed:**
- `src/db/database.js` (line 19)

**Code Changes:**
```diff
--- a/src/db/database.js
+++ b/src/db/database.js
@@ -19,1 +19,1 @@
-    password: "$2a$10$8Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9", // password: Test123!
+    password: "$2a$10$E1i3VZE3Vi.DeA4/l9OSz.NwIMIcx95lrhmwdE795n68.fXAAofR6", // password: Test123!
```

**Why This Fix:**
Enables developers and QA engineers to authenticate and test protected routes using the credentials documented in the README without needing to re-register an account first.
