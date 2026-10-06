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

describe('Table Orders API Tests', () => {
  describe('Bug F: Duplicate Table Order Prevention', () => {
    test('should successfully create first table order', async () => {
      const res = await request(app)
        .post('/api/table-orders')
        .send({
          merchant_id: '1',
          table_number: 10,
          customer_name: 'Alice',
          order_type: 'dine_in',
          items: [
            { name: 'Burger', price: 12.5, quantity: 2 },
            { name: 'Fries', price: 4.0, quantity: 1 }
          ]
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.table_number, 10);
      assert.strictEqual(res.body.data.status, 'pending');
      assert.strictEqual(res.body.data.total, 29.0);
    });

    test('should reject duplicate order on same table while pending (Bug F regression)', async () => {
      const res = await request(app)
        .post('/api/table-orders')
        .send({
          merchant_id: '1',
          table_number: 10,
          customer_name: 'Bob',
          order_type: 'dine_in',
          items: [{ name: 'Pizza', price: 15.0, quantity: 1 }]
        });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'Table already has a pending order');
    });

    test('should allow order on different table for same merchant', async () => {
      const res = await request(app)
        .post('/api/table-orders')
        .send({
          merchant_id: '1',
          table_number: 11,
          customer_name: 'Charlie',
          order_type: 'dine_in',
          items: [{ name: 'Pasta', price: 14.0, quantity: 1 }]
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.table_number, 11);
    });

    test('should allow new order on table once previous order is confirmed/served', async () => {
      // Find pending order for table 10 and update to 'confirmed'
      const order = db.table_orders.find(
        o => o.merchant_id === '1' && o.table_number === 10 && o.status === 'pending'
      );
      assert.ok(order);
      order.status = 'confirmed';

      // Now table 10 no longer has a pending order
      const res = await request(app)
        .post('/api/table-orders')
        .send({
          merchant_id: '1',
          table_number: 10,
          customer_name: 'Dave',
          order_type: 'dine_in',
          items: [{ name: 'Dessert', price: 6.5, quantity: 1 }]
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.table_number, 10);
      assert.strictEqual(res.body.data.status, 'pending');
    });
  });

  describe('Validation & Edge Cases', () => {
    test('should reject order with missing required fields', async () => {
      const res = await request(app)
        .post('/api/table-orders')
        .send({
          merchant_id: '1',
          table_number: 5
        });

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('required'));
    });

    test('should reject order with empty items array', async () => {
      const res = await request(app)
        .post('/api/table-orders')
        .send({
          merchant_id: '1',
          table_number: 5,
          items: []
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'Order must have at least one item');
    });
  });

  describe('GET & PATCH /api/table-orders', () => {
    test('GET /api/table-orders should return merchant orders', async () => {
      const res = await request(app)
        .get('/api/table-orders')
        .set('Authorization', `Bearer ${authToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));
    });

    test('PATCH /api/table-orders/:id/status should update status', async () => {
      const order = db.table_orders.find(o => o.merchant_id === '1');
      assert.ok(order);

      const res = await request(app)
        .patch(`/api/table-orders/${order.id}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'preparing' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.status, 'preparing');
    });

    test('PATCH /api/table-orders/:id/status should reject invalid status', async () => {
      const order = db.table_orders.find(o => o.merchant_id === '1');
      assert.ok(order);

      const res = await request(app)
        .patch(`/api/table-orders/${order.id}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'unknown_status_xyz' });

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('Valid status required'));
    });
  });
});
