
'use strict';

// 纯 JavaScript 负载，不调用 gc() 或 V8 内部 Runtime 函数。

const say = typeof print === 'function' ? print : console.log;

// 可根据 V8 的堆配置调整
const CACHE_PAGES = 112;
const ROWS_PER_PAGE = 96;
const VALUES_PER_ROW = 48;
const ROUNDS = 800;

// 长期存活的对象根集合
const cache = new Array(CACHE_PAGES);

let check = 0;
let nextId = 1;

// 创建具有大量引用的业务对象
function newRow() {
  const id = nextId++;
  const values = new Array(VALUES_PER_ROW);

  for (let i = 0; i < VALUES_PER_ROW; ++i) {
    values[i] = {
      kind: i,
      amount: (id + i) & 65535,
      active: (i & 1) === 0
    };
  }

  return {
    id,
    name: 'user-' + id,
    values,
    meta: {version: id & 7, score: id * 3},
    next: null
  };
}

// 创建对象图：一页包含多个互相引用的对象
function newPage(epoch) {
  const rows = new Array(ROWS_PER_PAGE);

  for (let i = 0; i < rows.length; ++i) {
    rows[i] = newRow();
  }

  // 构建循环引用，使标记阶段需要遍历对象图
  for (let i = 0; i < rows.length; ++i) {
    rows[i].next = rows[(i + 1) % rows.length];
  }

  return {epoch, rows, root: rows[0]};
}

// 模拟大量短生命周期请求对象
function handleRequests(epoch) {
  const requests = new Array(1400);

  for (let i = 0; i < requests.length; ++i) {
    requests[i] = {
      path: '/api/user/' + ((i + epoch) & 1023),
      body: {
        id: i,
        list: [epoch, i, i * 3],
        ok: (i & 1) === 0
      }
    };
  }

  // 消费结果，避免整个计算变成无用计算
  check = (
    check +
    requests[(epoch * 37) % requests.length].body.list[1]
  ) | 0;
}

// 阶段一：建立需要长期保留的数据
say('warmup: fill retained cache');

for (let i = 0; i < cache.length; ++i) {
  cache[i] = newPage(i);

  // 穿插短命对象分配，让缓存对象经历年轻代回收
  if ((i & 3) === 0) {
    handleRequests(i);
  }
}

// 阶段二：持续运行，更新引用、分配对象、淘汰缓存
say('steady state: churn, edit old objects and evict old pages');

for (let round = 0; round < ROUNDS; ++round) {
  const index = round % CACHE_PAGES;

  // 修改一个仍被缓存引用的存活对象
  const page = cache[(index + 17) % CACHE_PAGES];
  const row = page.rows[round % ROWS_PER_PAGE];

  // 对象字段写入：方便观察 Write Barrier
  row.meta = {
    version: round,
    score: (round * 13) & 65535
  };

  // 数组元素引用更新
  row.values[round % VALUES_PER_ROW] = {
    kind: round,
    amount: round * 2,
    active: true
  };

  // 产生大量短命对象
  handleRequests(round);

  // 淘汰旧缓存，旧对象图逐渐变成垃圾
  cache[index] = newPage(round + CACHE_PAGES);

  check = (
    check + cache[index].root.values[0].amount
  ) | 0;

  if (round % 50 === 0) {
    say('round=' + round + ' checksum=' + check);
  }
}

say('done; checksum=' + check +
    ', cache pages=' + cache.length);
