/**
 * Test nhẹ cho 2 chỗ dễ vỡ: trích link redeem + nhận diện sản phẩm theo tên.
 * Chạy:  node test/core.test.js
 */
const assert = require('assert');
const { extractRedeemLink, matchButton, PRODUCTS, COL_ORDER } = require('../lib/core');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓', name); };

// --- extractRedeemLink ---
const authStock =
  'https://auth.services.adobe.com/en_US/deeplink.html?...&redirect_uri=' +
  encodeURIComponent('https://redeem.adobe.com/stock/?rc=A3JM-QJKJ-GT6X-TZR4-WJR5-5JRR&sdid=W6K8JFCQ&mv=affiliate');

t('trích link stock có /stock/ và rc', () => {
  const link = extractRedeemLink(authStock);
  assert.ok(link && link.includes('/stock/'), 'phải có /stock/');
  assert.ok(link.includes('rc=A3JM-QJKJ-GT6X-TZR4-WJR5-5JRR'), 'phải có rc đúng');
});

t('trích link acrobat (encode 2 lớp)', () => {
  const inner = 'https://redeem.adobe.com/acrobat/?rc=4ZVJ-UBUN-GBKB-EAAX-J5FW-63CM&sdid=B16P3WRG&mv=affiliate';
  const doubled = 'x?redirect_uri=' + encodeURIComponent(encodeURIComponent(inner));
  const link = extractRedeemLink(doubled);
  assert.ok(link && link.includes('/acrobat/'), 'phải có /acrobat/');
});

t('không có redeem link -> null', () => {
  assert.strictEqual(extractRedeemLink('https://example.com/no-code-here'), null);
});

// --- matchButton: nhận diện theo tên, bất kể ProductID ---
const buttons = [
  { id: 'b0', text: 'Adobe Stock\n1-month subscription' },
  { id: 'b1', text: 'Adobe Creative Cloud Pro' },
  { id: 'b2', text: 'Adobe Substance 3D' },
  { id: 'b3', text: 'Adobe Acrobat Standard' },
  { id: 'b4', text: 'Adobe Photography plan 1TB' },
];

t('khớp đúng từng sản phẩm theo tên', () => {
  assert.strictEqual(matchButton(buttons, 'stock'), 'b0');
  assert.strictEqual(matchButton(buttons, 'creative'), 'b1');
  assert.strictEqual(matchButton(buttons, 'substance'), 'b2');
  assert.strictEqual(matchButton(buttons, 'acrobat'), 'b3');
  assert.strictEqual(matchButton(buttons, 'photography'), 'b4');
});

t('thứ tự nút đảo vẫn khớp đúng', () => {
  const shuffled = [buttons[3], buttons[0], buttons[4], buttons[1], buttons[2]];
  assert.strictEqual(matchButton(shuffled, 'stock'), 'b0');
  assert.strictEqual(matchButton(shuffled, 'acrobat'), 'b3');
});

t('link không có sản phẩm -> null', () => {
  assert.strictEqual(matchButton([{ id: 'x', text: 'Adobe Stock' }], 'acrobat'), null);
});

t('COL_ORDER khớp số sản phẩm', () => {
  assert.strictEqual(COL_ORDER.length, PRODUCTS.length);
  assert.strictEqual(COL_ORDER.length, 5);
});

console.log(`\n${pass} test PASS.`);
