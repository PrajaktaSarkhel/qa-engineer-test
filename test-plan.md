# Test Plan: Webhook Payment Processing Flow

**Document Version:** 1.0.0  
**Target Component:** Payment Provider Webhook Pipeline (`POST /api/webhooks/payment-status`)  
**Author:** QA Engineering Team (Technical Assessment)  
**System Under Test (SUT):** EU Pay Node.js Payment API  

---

## 1. Test Scope

### 1.1 In Scope
- **End-to-End Webhook Ingestion & Processing:** Receipt of HTTP POST notifications from payment service providers (e.g., Powens, Stripe, Bridge).
- **Authentication & Cryptographic Verification:** HMAC-SHA256 signature verification over the request body using `x-webhook-signature`.
- **Idempotency & Deduplication:** Prevention of duplicate processing when identical `event_id` payloads are delivered multiple times.
- **State Machine Transitions:** Status transitions on payment entities (`pending` -> `completed`, `pending` -> `failed`, `chargeback`, `refunded`).
- **Data Integrity & Schema Validation:** Validation of required parameters (`payment_id`, `status`, `event_id`) and sanitization of user-controlled inputs.
- **Security & Vulnerability Testing:** Replay attack deterrence, timing attack analysis, SQL/NoSQL injection in parameters, and Cross-Site Scripting (XSS) injection in string fields.
- **Real-Time Integration:** Propagation of updated payment state to merchant and table sockets via Socket.IO.

### 1.2 Out of Scope
- **User Interface (UI) Testing:** Merchant portal front-end screens and cashier displays.
- **High-Volume Load & Stress Testing:** Sustained multi-thousand RPS benchmarking (reserved for staging/pre-production environments).
- **Network-Level DDoS Mitigation:** Cloudflare / AWS Shield DDoS mitigation testing.
- **Upstream Banking Simulator Backend:** Internal mechanics of banking partners (AIS/PIS protocols).

---

## 2. Test Environment

| Component | Specification | Notes |
|:---|:---|:---|
| **API Host** | `http://localhost:3000` | Node.js 20+ runtime with Express 4 |
| **API Protocol** | REST (HTTP/1.1, JSON) + WebSocket (Socket.IO v4) | Local development / test runner mode |
| **Database** | In-memory store (`src/db/database.js`) | Reset per automated test suite run |
| **HMAC Secret** | `test-webhook-secret-key` | Used for HMAC-SHA256 digest computation |
| **Test Clients** | Node.js Test Runner (`node:test`), Supertest, cURL, Postman | Automated and manual validation |
| **Socket Tool** | Socket.IO Client Tester / custom Node WebSocket client | Local WebSocket subscriber verification |

---

## 3. Test Scenarios Matrix

| Scenario ID | Test Scenario | Inputs / Preconditions | Expected Output / Behavior | Priority |
|:---|:---|:---|:---|:---:|
| **SC-01** | Valid webhook with correct signature | Valid payment exists in DB (`payment_id: "1"`), status is `pending`, valid HMAC-SHA256 signature in header | HTTP `200 OK`, `{"success": true, "new_status": "completed"}`, DB status updated to `completed`, `webhook_received_at` timestamp set | Critical |
| **SC-02** | Webhook with missing signature header | Valid body, `x-webhook-signature` header omitted | HTTP `401 Unauthorized`, `{"error": "Webhook signature required"}`. No state modification. | Critical |
| **SC-03** | Webhook with forged / invalid signature | Valid body, `x-webhook-signature` contains arbitrary or invalid hex digest | HTTP `401 Unauthorized`, `{"error": "Invalid signature"}`. No state modification. | Critical |
| **SC-04** | Webhook payload tampered in transit | Original payload signed, but payload body modified (e.g., status changed from `failed` to `completed`) | HMAC mismatch -> HTTP `401 Unauthorized`. Tampering detected. | Critical |
| **SC-05** | Duplicate webhook delivery (Idempotency) | Exact same payload and `event_id` delivered a second time after initial success | HTTP `200 OK`, `{"message": "Already processed", "event_id": "..."}`. DB timestamp and state unchanged. | High |
| **SC-06** | Webhook for non-existent payment | Valid signature, but `payment_id: "non_existent_9999"` | HTTP `404 Not Found`, `{"error": "Payment not found"}`. Event not added to processed webhooks. | High |
| **SC-07** | Out-of-order webhook delivery (arrives before creation) | Webhook arrives before payment is recorded in database | HTTP `404 Not Found` (in real architecture, publish to Dead Letter Queue for delayed retry). | Medium |
| **SC-08** | Sequential webhooks for same payment | Event 1: `status: "authorized"`, Event 2: `status: "completed"` | First webhook sets status to `authorized`; second webhook updates status to `completed`. Both return HTTP 200. | High |
| **SC-09** | Missing mandatory payload fields | Body missing `payment_id` or `status` (with valid signature computed on partial body) | HTTP `400 Bad Request`, `{"error": "payment_id and status required"}`. | High |
| **SC-10** | Malformed JSON in request body | Body containing invalid JSON syntax (e.g. `{payment_id: 1,`) | Express body-parser rejects with HTTP `400 Bad Request`. | Medium |
| **SC-11** | Concurrent webhooks (Race condition simulation) | Two simultaneous requests with same `event_id` dispatched via parallel asynchronous promises | One request completes normally (200), the second returns "Already processed" (200) without race collision. | High |
| **SC-12** | SQL / NoSQL injection in `payment_id` | `payment_id: "' OR '1'='1"` or `{"$gt": ""}` | Sanitized string comparison. Returns HTTP `404 Not Found`. No DB crash or leakage. | High |
| **SC-13** | Timing attack on signature verification | Insecure string comparison vs constant-time comparison | Measured response time delta between mismatched byte 1 vs byte 32 is statistically indistinguishable. | Medium |
| **SC-14** | Webhook replay attack with old `event_id` | Attacker replays captured legitimate webhook days later | Recognized as already processed (idempotency table) -> HTTP 200 "Already processed". | High |
| **SC-15** | Empty string or whitespace in required fields | `payment_id: ""` or `status: "   "` | HTTP `400 Bad Request`. | Medium |

---

## 4. Security Tests

### 4.1 Signature Verification (HMAC-SHA256)
- **Objective:** Ensure all inbound webhook traffic is authenticated using a shared secret.
- **Methodology:**
  1. Generate valid payload: `{"payment_id": "1", "status": "completed", "event_id": "evt_test_1"}`.
  2. Compute SHA-256 HMAC digest: `crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')`.
  3. Validate that altering even a single bit of the payload or secret results in immediate rejection (HTTP 401).
- **Hardening Recommendation:**
  In production, raw request buffers must be used for HMAC calculation rather than re-serializing parsed JSON (`JSON.stringify(req.body)`), because JSON key reordering or whitespace variance across JSON serializers could cause false rejection.

### 4.2 Replay Attack Prevention
- **Objective:** Prevent an attacker who intercepts a webhook request from re-submitting it to trigger multiple events.
- **Verification:**
  1. Record `event_id` in persistent cache (e.g. Redis with 72h TTL).
  2. Require an `x-webhook-timestamp` header and reject webhooks with timestamps older than 5 minutes (`abs(now - timestamp) > 300s`).
  3. Incorporate the timestamp into the signed payload: `HMAC(timestamp + "." + rawBody)`.

### 4.3 Injection Resistance (SQL / NoSQL / Command Injection)
- **Test:** Submit payloads with malicious strings:
  ```json
  {
    "payment_id": "'; DROP TABLE payments; --",
    "status": "completed",
    "event_id": "evt_sql_1"
  }
  ```
- **Expected:** Parameter is treated purely as a literal string. Lookup fails with 404; no syntax errors or execution leaks occur.

### 4.4 Cross-Site Scripting (XSS) Prevention
- **Test:** Pass `<script>alert('XSS')</script>` in the `status` field.
- **Expected:** Value is validated against an enum of allowed statuses (`['pending', 'completed', 'failed', 'refunded']`). Malformed or script-bearing statuses are rejected with HTTP 400.

---

## 5. Concurrency & Edge Cases

### 5.1 Extreme and Unusual Inputs
1. **Very Large `payment_id`:** Submit a 10,000-character UUID/string. Ensure memory consumption does not spike and server handles gracefully (404).
2. **Unicode and Special Characters:** Submit status with emojis or multibyte UTF-8 characters (`status: "completed 💳"`). System validates against allowed ASCII status enums.
3. **Null / Missing `event_id`:** Verify system handles requests without `event_id` (either generates fallback or rejects with 400).
4. **Future Timestamps:** When timestamp verification is active, reject timestamps in the future by more than clock drift allowance (e.g., > 60s).

### 5.2 Concurrency & Network Retries
- **Scenario:** The webhook sender encounters network latency and immediately retransmits the event while the first request is in-flight.
- **Mitigation:**
  - Distributed lock on `payment_id` or unique database index constraint on `event_id`.
  - Transaction isolation (PostgreSQL `READ COMMITTED` or `SERIALIZABLE`) to prevent dirty reads.

---

## 6. Integration & Real-Time Flow

```
+-------------------+      POST /api/webhooks/payment-status     +--------------------+
|  Payment Gateway  | -----------------------------------------> |  EU Pay Webhook API|
|  (e.g. Powens)    |                                            +---------+----------+
+-------------------+                                                      |
                                                                           | 1. Verify HMAC Signature
                                                                           | 2. Check Idempotency (event_id)
                                                                           | 3. Update Payment Status in DB
                                                                           v
+-------------------+      Socket.IO: order_status_changed       +--------------------+
| Merchant Portal / | <----------------------------------------- |  Socket.IO Server  |
| Table Terminal    |                                            +--------------------+
+-------------------+
```

### 6.1 Database Persistence Verification
- Verify that status update mutates `payment.status` and registers `payment.webhook_received_at`.
- Verify that subsequent calls to `GET /api/payments/:id` return the updated status immediately.

### 6.2 Real-Time Event Dispatch (Socket.IO)
- When a payment for an active table order completes, an event (`order_status_changed` / `payment_received`) must be broadcast to the relevant room (`merchant_${merchant_id}` or `table_${table_number}`).
- Socket subscribers receive the message with latency < 50ms.

### 6.3 Retry & Dead Letter Queue (DLQ) Integration
- If downstream database operations fail temporarily (e.g. transient lock), the API should return HTTP 500 so the payment gateway triggers its exponential backoff retry schedule.
- Poison pill events (persistent failures) must be routed to a Dead Letter Queue (AWS SQS DLQ) after 5 retries for manual ops intervention.

---

## 7. Production Risk Assessment & Mitigation

| Identified Risk | Severity | Detection Mechanism | Mitigation Strategy |
|:---|:---:|:---|:---|
| **Webhook Secret Leak** | Critical | Cloud secret scanners (GitGuardian, AWS Secrets Manager audit), unexpected source IP addresses | Rotate webhook secrets using zero-downtime dual-secret verification (support `current_secret` and `previous_secret` during transition). |
| **Out-of-Order Webhook Delivery** | High | Log state machine transition warnings (e.g. receiving `refunded` before `completed`) | Implement a strict state transition matrix; ignore or buffer events that violate valid state transitions. |
| **Database Connection Pool Exhaustion** | High | Datadog / CloudWatch metric alarms on active connection pool saturation | Decouple webhook ingestion from processing using asynchronous worker queues (BullMQ / AWS SQS). Return immediate 200/202 ack after queuing. |
| **Replay Attacks** | High | Monitoring duplicate `event_id` count spikes over short time windows | Store processed event IDs in Redis with TTL; enforce timestamp validity windows (`timestamp within 5m`). |
| **Provider API Downtime / Gateway Failure** | Medium | Error rate metrics exceeding 1% on `/api/webhooks/*` | Implement circuit breakers, fallback webhook polling mechanisms, and automated alerting via PagerDuty. |

---

## 8. Test Execution Strategy & Sign-Off

1. **Automated CI Execution:** Run test suite via `npm test` on every commit.
2. **Mock Gateway Testing:** Execute automated suite using simulated payloads matching Powens and Stripe production payloads.
3. **Pass Criteria:** 100% test pass rate for all critical and high severity scenarios; zero unhandled promise rejections or uncaught exceptions.
