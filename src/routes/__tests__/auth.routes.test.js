import { test, after, describe } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import app, { io } from '../../server.js';
import { validateEmail } from '../auth.routes.js';

after(() => {
  io.close();
});

describe('Authentication & Authorization Tests', () => {
  describe('Bug C: Email Validation', () => {
    test('should reject email without top-level domain (TLD) - Bug C regression', () => {
      assert.strictEqual(validateEmail('user@domain'), false);
      assert.strictEqual(validateEmail('test@localhost'), false);
      assert.strictEqual(validateEmail('invalid@domain.'), false);
    });

    test('should reject malformed emails', () => {
      assert.strictEqual(validateEmail('plainaddress'), false);
      assert.strictEqual(validateEmail('@missingusername.com'), false);
      assert.strictEqual(validateEmail('user name@domain.com'), false);
      assert.strictEqual(validateEmail('user@domain..com'), false);
    });

    test('should accept valid email formats', () => {
      assert.strictEqual(validateEmail('merchant@example.com'), true);
      assert.strictEqual(validateEmail('qa.engineer@european-pay.eu'), true);
      assert.strictEqual(validateEmail('test+alias@domain.co.uk'), true);
    });
  });

  describe('POST /api/auth/register', () => {
    test('should register a new merchant successfully', async () => {
      const uniqueEmail = `new-merchant-${Date.now()}@example.com`;
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: uniqueEmail,
          password: 'Password123!',
          business_name: 'Tech Ventures Ltd'
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.message, 'Registration successful');
      assert.ok(res.body.token);
      assert.strictEqual(res.body.user.email, uniqueEmail);
      assert.strictEqual(res.body.user.business_name, 'Tech Ventures Ltd');
      assert.strictEqual(res.body.user.password, undefined);
    });

    test('should reject registration with invalid email without TLD (Bug C API test)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'invalid@nodomain',
          password: 'Password123!',
          business_name: 'Invalid Email Co'
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'Invalid email format');
    });

    test('should reject registration with password under 8 characters', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'shortpass@example.com',
          password: 'short',
          business_name: 'Short Pass Co'
        });

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('8 characters'));
    });

    test('should reject registration with missing business name', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'nobiz@example.com',
          password: 'Password123!',
          business_name: ' '
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'Business name is required');
    });

    test('should reject duplicate email registration with 409 Conflict', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'merchant@test.com',
          password: 'Password123!',
          business_name: 'Duplicate Merchant'
        });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'Email already registered');
    });
  });

  describe('POST /api/auth/login', () => {
    test('should login successfully with valid credentials and return JWT token', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'merchant@test.com',
          password: 'Test123!'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.message, 'Login successful');
      assert.ok(res.body.token);
      assert.strictEqual(res.body.user.email, 'merchant@test.com');
    });

    test('should reject login with wrong password (401)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'merchant@test.com',
          password: 'WrongPassword999!'
        });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid credentials');
    });

    test('should reject login with non-existent email (401)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'unknown@example.com',
          password: 'Test123!'
        });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid credentials');
    });

    test('should reject login with missing fields (400)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'merchant@test.com'
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'Email and password required');
    });
  });
});
