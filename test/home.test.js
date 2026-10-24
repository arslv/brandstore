// Вкладки главной: разбор и запись stores.home_tabs
const test = require('node:test');
const assert = require('node:assert');
const { parseHomeTabs, formatHomeTabs, NO_RANK } = require('../src/lib/format');

test('вкладки главной: номер, без номера, мусор', () => {
  assert.deepStrictEqual(parseHomeTabs('all:1,women:3,men,kids:0,foo:2,home:abc'), { all: 1, women: 3, men: NO_RANK, kids: NO_RANK, home: NO_RANK });
  assert.deepStrictEqual(parseHomeTabs(''), {});
  assert.deepStrictEqual(parseHomeTabs(null), {});
  assert.strictEqual(formatHomeTabs({ men: 2, all: 1, kids: NO_RANK }), 'all:1,men:2,kids:999');
  assert.deepStrictEqual(parseHomeTabs(formatHomeTabs({ women: 5, home: 1 })), { women: 5, home: 1 });
});
