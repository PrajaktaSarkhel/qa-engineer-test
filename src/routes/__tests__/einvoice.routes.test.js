import { test, after, describe, before } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import app, { io } from '../../server.js';
import { db } from '../../db/database.js';

let authToken = '';

before(async () => {
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({
      email: 'merchant@test.com',
      password: 'Test123!'
    });
  authToken = loginRes.body.token;
});

after(() => {
  io.close();
});

describe('E-Invoicing API Tests', () => {
  describe('Bug G: Duplicate E-Invoice Submission Prevention', () => {
    test('should submit invoice successfully for the first time', async () => {
      const invoiceId = `inv_test_${Date.now()}`;
      const res = await request(app)
        .post('/api/einvoice/submit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          invoice_id: invoiceId,
          customer_siret: '12345678901234' // Exactly 14 digits
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.message, 'Invoice submitted to tax authority');
      assert.strictEqual(res.body.data.status, 'submitted');
      assert.ok(res.body.data.submission_id.startsWith('SUB-'));
    });

    test('should reject duplicate submission when invoice is already submitted (Bug G regression)', async () => {
      const invoiceId = `inv_duplicate_${Date.now()}`;

      // First submission
      const firstRes = await request(app)
        .post('/api/einvoice/submit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          invoice_id: invoiceId,
          customer_siret: '12345678901234'
        });
      assert.strictEqual(firstRes.status, 200);

      // Attempt duplicate submission
      const secondRes = await request(app)
        .post('/api/einvoice/submit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          invoice_id: invoiceId,
          customer_siret: '12345678901234'
        });

      assert.strictEqual(secondRes.status, 409);
      assert.strictEqual(secondRes.body.error, 'Invoice already submitted to tax authority');
    });

    test('should reject resubmission when invoice is already accepted by tax authority', async () => {
      const invoiceId = `inv_accepted_${Date.now()}`;
      if (!db.invoices) db.invoices = [];
      db.invoices.push({
        id: invoiceId,
        merchant_id: '1',
        invoice_number: 'INV-ACCEPTED-99',
        amount: 500,
        currency: 'EUR',
        customer_siret: '12345678901234',
        status: 'draft',
        einvoice_status: 'accepted'
      });

      const res = await request(app)
        .post('/api/einvoice/submit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          invoice_id: invoiceId,
          customer_siret: '12345678901234'
        });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'Invoice already submitted to tax authority');
    });
  });

  describe('Validation & Authorization Tests', () => {
    test('should reject submission with invalid SIRET length (not 14 digits)', async () => {
      const res = await request(app)
        .post('/api/einvoice/submit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          invoice_id: 'inv_bad_siret',
          customer_siret: '12345' // Too short
        });

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('14 digits'));
    });

    test('should reject submission with missing invoice_id', async () => {
      const res = await request(app)
        .post('/api/einvoice/submit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          customer_siret: '12345678901234'
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'invoice_id required');
    });

    test('should reject submission if invoice belongs to another merchant (403)', async () => {
      const otherInvoiceId = 'other-merchant-inv-88';
      if (!db.invoices) db.invoices = [];
      db.invoices.push({
        id: otherInvoiceId,
        merchant_id: '88', // Different merchant
        invoice_number: 'INV-88',
        amount: 200,
        currency: 'EUR',
        customer_siret: '12345678901234',
        status: 'draft'
      });

      const res = await request(app)
        .post('/api/einvoice/submit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          invoice_id: otherInvoiceId,
          customer_siret: '12345678901234'
        });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error, 'Access denied');
    });

    test('should reject submission without authentication token (401)', async () => {
      const res = await request(app)
        .post('/api/einvoice/submit')
        .send({
          invoice_id: 'inv_no_auth',
          customer_siret: '12345678901234'
        });

      assert.strictEqual(res.status, 401);
    });
  });

  describe('GET /api/einvoice/status/:invoice_id', () => {
    test('should retrieve e-invoice status for valid invoice', async () => {
      const invoiceId = `inv_status_check_${Date.now()}`;
      await request(app)
        .post('/api/einvoice/submit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          invoice_id: invoiceId,
          customer_siret: '12345678901234'
        });

      const res = await request(app)
        .get(`/api/einvoice/status/${invoiceId}`)
        .set('Authorization', `Bearer ${authToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.invoice_id, invoiceId);
      assert.strictEqual(res.body.data.einvoice_status, 'submitted');
      assert.ok(res.body.data.submission_id);
    });

    test('should return 404 for non-existent invoice status check', async () => {
      const res = await request(app)
        .get('/api/einvoice/status/unknown-invoice-999')
        .set('Authorization', `Bearer ${authToken}`);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'Invoice not found');
    });
  });
});
