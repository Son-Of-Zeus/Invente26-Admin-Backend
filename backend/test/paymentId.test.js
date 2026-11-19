const test = require('node:test');
const assert = require('node:assert/strict');

const { extractPaymentId, isPaymentId } = require('../src/utils/paymentId');

test('validates only exact case-sensitive Razorpay payment IDs', () => {
  assert.equal(isPaymentId('pay_1234567890ABCD'), true);
  assert.equal(isPaymentId('PAY_1234567890ABCD'), false);
  assert.equal(isPaymentId('pay_1234567890ABC'), false);
  assert.equal(isPaymentId(' pay_1234567890ABCD'), false);
  assert.equal(isPaymentId('pay_1234567890AB CD'), false);
});

test('extracts the first exact payment ID without normalization', () => {
  const content = 'First pay_1234567890ABCD then pay_ZYXWVUTSRQPONM';
  assert.equal(extractPaymentId(content), 'pay_1234567890ABCD');
  assert.equal(extractPaymentId('pay_1234567 890ABCD'), null);
  assert.equal(extractPaymentId('prefixpay_1234567890ABCDsuffix'), null);
  assert.equal(extractPaymentId(null), null);
});
