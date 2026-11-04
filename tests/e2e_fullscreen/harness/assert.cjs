'use strict';

const assert = require('node:assert/strict');

function assertClose(actual, expected, epsilon = 1.0, message = '') {
  const diff = Math.abs(actual - expected);
  if (diff > epsilon) {
    const defaultMsg = `Expected ${actual} to be within ${epsilon} of ${expected} (diff: ${diff})`;
    throw new assert.AssertionError({
      message: message ? `${message}: ${defaultMsg}` : defaultMsg,
      actual,
      expected,
      operator: 'assertClose',
    });
  }
}

module.exports = {
  ...assert,
  strictEqual: assert.strictEqual,
  deepStrictEqual: assert.deepStrictEqual,
  notStrictEqual: assert.notStrictEqual,
  ok: assert.ok,
  match: assert.match,
  doesNotMatch: assert.doesNotMatch,
  throws: assert.throws,
  rejects: assert.rejects,
  fail: assert.fail,
  assertClose,
};
