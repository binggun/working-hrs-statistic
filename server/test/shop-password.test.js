import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import {passwordMatches} from '../src/shop-password.js';

test('New and existing shops use only the fixed password', async () => {
  const password_hash = await argon2.hash('previous-shop-password');
  for (const stored of [null, password_hash]) {
    const account = {role: 'SHOP', password_hash: stored};
    assert.equal(await passwordMatches(account, '123456'), true);
    assert.equal(await passwordMatches(account, 'previous-shop-password'), false);
    assert.equal(await passwordMatches(account, ''), false);
    assert.equal(await passwordMatches(account, '123456 '), false);
  }
});
test('Employee and manager passwords still require their own stored password', async () => {
  const password_hash = await argon2.hash('personal-password');
  for (const role of ['WORKER', 'MANAGER', 'GENERAL_MANAGER', 'SUPER_MANAGER']) {
    assert.equal(await passwordMatches({role, password_hash}, '123456'), false);
    assert.equal(await passwordMatches({role, password_hash}, 'personal-password'), true);
    assert.equal(await passwordMatches({role, password_hash: null}, '123456'), false);
  }
});
