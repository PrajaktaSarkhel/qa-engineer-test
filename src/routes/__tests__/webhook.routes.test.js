import { test, after, describe } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import request from 'supertest';
import app, { io } from '../../server.js';
import { WEBHOOK_SECRET } from '../webhook.routes.js';
import { db, getPaymentById } from '../../db/database.js';

function generateSignature(payload, secret = WEBHOOK_SECRET) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

after(() => {
  io.close();
});

describe('Webhook Routes & Security Tests', () => {
  describe('Bug D: Webhook Signature Verification', () => {
    test('should reject webhook request when signature header is missing (Bug D)', async () => {
      const payload = {
        payment_id: '1',
        status: 'completed',
        event_id: 'evt_no_sig_123'
      };

      const res = await request(app)
        .post('/api/webhooks/payment-status')
        .send(payload);

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Webhook signature required');
    });

    test('should reject webhook request with forged or invalid signature (Bug D)', async () => {
      const payload = {
        payment_id: '1',
        status: 'completed',
        event_id: 'evt_fake_sig_123'
      };

      const res = await request(app)
        .post('/api/webhooks/payment-status')
        .set('x-webhook-signature', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
        .send(payload);

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid signature');
    });

    test('should reject webhook if payload was tampered in-transit (integrity test)', async () => {
      const originalPayload = {
        payment_id: '1',
        status: 'pending',
        event_id: 'evt_tamper_test'
      };
      const signature = generateSignature(originalPayload);

      // Attacker intercepts and modifies status to completed without knowing secret
      const tamperedPayload = {
        payment_id: '1',
        status: 'completed',
        event_id: 'evt_tamper_test'
      };

      const res = await request(app)
        .post('/api/webhooks/payment-status')
        .set('x-webhook-signature', signature)
        .send(tamperedPayload);

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid signature');
    });

    test('should accept webhook with valid HMAC-SHA256 signature', async () => {
      const payload = {
        payment_id: '2',
        status: 'completed',
        event_id: `evt_valid_${Date.now()}`
      };
      const signature = generateSignature(payload);

      const res = await request(app)
        .post('/api/webhooks/payment-status')
        .set('x-webhook-signature', signature)
        .send(payload);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.new_status, 'completed');

      const payment = getPaymentById('2');
      assert.strictEqual(payment.status, 'completed');
      assert.ok(payment.webhook_received_at);
    });
  });

  describe('Bug E: Webhook Idempotency Handling', () => {
    test('should process first webhook and return "Already processed" on duplicate event_id (Bug E)', async () => {
      const eventId = `evt_idempotent_${Date.now()}`;
      const payload = {
        payment_id: '1',
        status: 'completed',
        event_id: eventId
      };
      const signature = generateSignature(payload);

      // First webhook delivery
      const firstRes = await request(app)
        .post('/api/webhooks/payment-status')
        .set('x-webhook-signature', signature)
        .send(payload);

      assert.strictEqual(firstRes.status, 200);
      assert.strictEqual(firstRes.body.message, 'Webhook processed');

      // Duplicate delivery (network retry with identical event_id)
      const secondRes = await request(app)
        .post('/api/webhooks/payment-status')
        .set('x-webhook-signature', signature)
        .send(payload);

      assert.strictEqual(secondRes.status, 200);
      assert.strictEqual(secondRes.body.message, 'Already processed');
      assert.strictEqual(secondRes.body.event_id, eventId);
    });
  });

  describe('Webhook Validation & Error Handling', () => {
    test('should return 400 when payment_id is missing', async () => {
      const payload = {
        status: 'completed',
        event_id: 'evt_no_payment'
      };
      const signature = generateSignature(payload);

      const res = await request(app)
        .post('/api/webhooks/payment-status')
        .set('x-webhook-signature', signature)
        .send(payload);

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('required'));
    });

    test('should return 404 when payment does not exist', async () => {
      const payload = {
        payment_id: 'non-existent-payment-999',
        status: 'completed',
        event_id: 'evt_unknown_payment'
      };
      const signature = generateSignature(payload);

      const res = await request(app)
        .post('/api/webhooks/payment-status')
        .set('x-webhook-signature', signature)
        .send(payload);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'Payment not found');
    });
  });

  describe('E-Invoice Tax Authority Webhook', () => {
    test('should update invoice status on tax authority webhook', async () => {
      // Seed invoice
      if (!db.invoices) db.invoices = [];
      const invoiceId = `inv_test_${Date.now()}`;
      db.invoices.push({
        id: invoiceId,
        merchant_id: '1',
        invoice_number: 'INV-WEBHOOK-TEST',
        amount: 80.0,
        currency: 'EUR',
        status: 'draft',
        einvoice_status: 'submitted'
      });

      const res = await request(app)
        .post('/api/webhooks/e-invoice')
        .send({
          invoice_id: invoiceId,
          status: 'accepted',
          submission_id: 'SUB-TAX-1234',
          tax_authority_id: 'FR-DGFIP-9988'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.status, 'accepted');

      const updated = db.invoices.find(i => i.id === invoiceId);
      assert.strictEqual(updated.einvoice_status, 'accepted');
      assert.strictEqual(updated.tax_authority_id, 'FR-DGFIP-9988');
    });

    test('should return 404 for non-existent invoice on e-invoice webhook', async () => {
      const res = await request(app)
        .post('/api/webhooks/e-invoice')
        .send({
          invoice_id: 'unknown-inv',
          status: 'accepted'
        });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'Invoice not found');
    });
  });
});
