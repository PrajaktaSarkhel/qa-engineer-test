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

describe('Payment API Tests', () => {
  describe('Bug A: Amount Data Type in Payment Retrieval', () => {
    test('GET /api/payments should return amount as number, not string (Bug A regression)', async () => {
      const res = await request(app)
        .get('/api/payments')
        .set('Authorization', `Bearer ${authToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.length > 0);

      // Verify Bug A fix: every amount must be a number
      res.body.data.forEach((payment) => {
        assert.strictEqual(
          typeof payment.amount,
          'number',
          `Expected payment ${payment.id} amount to be number, got ${typeof payment.amount}`
        );
        assert.ok(!isNaN(payment.amount));
      });
      assert.strictEqual(res.body.data[0].amount, 25.5);
    });

    test('GET /api/payments/:id should return single payment with numeric amount (Bug A regression)', async () => {
      const res = await request(app)
        .get('/api/payments/1')
        .set('Authorization', `Bearer ${authToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(typeof res.body.data.amount, 'number');
      assert.strictEqual(res.body.data.amount, 25.5);
    });

    test('GET /api/payments/:id should return 404 for non-existent payment', async () => {
      const res = await request(app)
        .get('/api/payments/999999')
        .set('Authorization', `Bearer ${authToken}`);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'Payment not found');
    });

    test('GET /api/payments/:id should return 403 when accessing another merchant payment', async () => {
      // Seed a payment belonging to another merchant (merchant_id = '99')
      db.payments.push({
        id: 'external-payment-99',
        merchant_id: '99',
        amount: 50.0,
        currency: 'EUR',
        status: 'pending',
        customer_email: 'other@example.com',
        created_at: new Date()
      });

      const res = await request(app)
        .get('/api/payments/external-payment-99')
        .set('Authorization', `Bearer ${authToken}`);

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error, 'Access denied');
    });
  });

  describe('Bug B: Maximum Amount Validation in Payment Creation', () => {
    test('POST /api/payments should successfully create payment with valid amount within limit', async () => {
      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 250.75,
          currency: 'EUR',
          customer_email: 'buyer@test.com'
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(typeof res.body.data.amount, 'number');
      assert.strictEqual(res.body.data.amount, 250.75);
      assert.strictEqual(res.body.data.currency, 'EUR');
      assert.strictEqual(res.body.data.status, 'pending');
    });

    test('POST /api/payments should reject amount over €50,000 (Bug B regression)', async () => {
      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 999999999,
          currency: 'EUR',
          customer_email: 'richbuyer@test.com'
        });

      assert.strictEqual(res.status, 400);
      assert.ok(
        res.body.error.toLowerCase().includes('maximum'),
        `Expected error to mention 'maximum', got: ${res.body.error}`
      );
    });

    test('POST /api/payments should reject amount slightly above boundary (€50,000.01)', async () => {
      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 50000.01,
          currency: 'EUR',
          customer_email: 'boundary@test.com'
        });

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.toLowerCase().includes('maximum'));
    });

    test('POST /api/payments should accept amount exactly at boundary (€50,000)', async () => {
      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 50000,
          currency: 'EUR',
          customer_email: 'maxallowed@test.com'
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.amount, 50000);
    });

    test('POST /api/payments should reject negative or zero amounts', async () => {
      const negativeRes = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: -50,
          currency: 'EUR',
          customer_email: 'negative@test.com'
        });
      assert.strictEqual(negativeRes.status, 400);

      const zeroRes = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 0,
          currency: 'EUR',
          customer_email: 'zero@test.com'
        });
      assert.strictEqual(zeroRes.status, 400);
    });

    test('POST /api/payments should reject unsupported currency', async () => {
      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 100,
          currency: 'JPY',
          customer_email: 'buyer@test.com'
        });

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('currency'));
    });

    test('POST /api/payments should require authentication (401)', async () => {
      const res = await request(app)
        .post('/api/payments')
        .send({
          amount: 100,
          currency: 'EUR',
          customer_email: 'noauth@test.com'
        });

      assert.strictEqual(res.status, 401);
    });
  });
});
