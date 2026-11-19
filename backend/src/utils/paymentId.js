const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]{14}$/;
const PAYMENT_ID_SEARCH_PATTERN = /\bpay_[A-Za-z0-9]{14}\b/;

function isPaymentId(value) {
  return typeof value === 'string' && PAYMENT_ID_PATTERN.test(value);
}

function extractPaymentId(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(PAYMENT_ID_SEARCH_PATTERN);
  return match ? match[0] : null;
}

module.exports = {
  PAYMENT_ID_PATTERN,
  PAYMENT_ID_SEARCH_PATTERN,
  isPaymentId,
  extractPaymentId,
};
