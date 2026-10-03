%SetDebuggerBreakpointEnabled(true);

// 保留少量对象，让 Scavenger 既看到 dead object，
// 又看到需要 copy / eventually promote 的 live object。
const survivors = [];

function allocateBatch(round) {
  for (let i = 0; i < 20000; ++i) {
    const obj = {
      round: round,
      index: i,
      x: i + 1,
      y: i + 2,
      child: {
        value: i
      }
    };

    // 绝大多数对象立即变成垃圾。
    //
    // 但每隔一段保留一个对象，使 Scavenge 不至于
    // 只是处理一个完全死亡的 New Space。
    if ((i & 1023) === 0) {
      survivors.push(obj);
    }
  }
}

for (let round = 0; round < 100; ++round) {
  allocateBatch(round);

  if ((round % 10) === 0) {
    print("round =", round,
          "survivors =", survivors.length);
  }
}

// 防止 survivors 被认为后续完全不可观察。
print("done, survivors =", survivors.length);
print(survivors[0].child.value);