//"use strict";

// 运行：d8 --allow-natives-syntax --trace-ic ic_lesson1_lite.js

// 三种 shape：用于 UNINITIALIZED → MONO → POLY
function createShape(kind) {
  if (kind === 0)  return { x: 1 };
  if (kind === 1)  return { x: 1, y: 2 };
  if (kind === 2)  return { y: 1, x: 2 };
  if (kind === 3)  return { x: 1, y: 2, z: 3 };
  if (kind === 4)  return { y: 1, x: 2, z: 3 };
  if (kind === 5)  return { y: 1, z: 2, x: 3 };
  if (kind === 6)  return { x: 1, a: 2, y: 3 };
  if (kind === 7)  return { a: 1, x: 2, y: 3 };
  if (kind === 8)  return { a: 1, y: 2, x: 3 };
  if (kind === 9)  return { x: 1, y: 2, a: 3, b: 4 };
  if (kind === 10) return { y: 1, x: 2, a: 3, b: 4 };
  if (kind === 11) return { y: 1, a: 2, x: 3, b: 4 };
  if (kind === 12) return { a: 1, x: 2, y: 3, b: 4 };
  if (kind === 13) return { a: 1, y: 2, x: 3, b: 4 };
  if (kind === 14) return { a: 1, b: 2, x: 3, y: 4 };
  if (kind === 15) return { x: 1, y: 2, z: 3, a: 4, b: 5 };
  if (kind === 16) return { y: 1, x: 2, z: 3, a: 4, b: 5 };
  if (kind === 17) return { y: 1, z: 2, x: 3, a: 4, b: 5 };
  if (kind === 18) return { y: 1, z: 2, a: 3, x: 4, b: 5 };
  if (kind === 19) return { y: 1, z: 2, a: 3, b: 4, x: 5 };
  if (kind === 20) return { x: 1, p: 2 };
  if (kind === 21) return { p: 1, x: 2 };
  if (kind === 22) return { x: 1, p: 2, q: 3 };
  if (kind === 23) return { p: 1, x: 2, q: 3 };
  if (kind === 24) return { p: 1, q: 2, x: 3 };
  if (kind === 25) return { x: 1, m: 2, n: 3, o: 4 };
  if (kind === 26) return { m: 1, x: 2, n: 3, o: 4 };
  if (kind === 27) return { m: 1, n: 2, x: 3, o: 4 };
  if (kind === 28) return { m: 1, n: 2, o: 3, x: 4 };
  if (kind === 29) return { x: 1, y: 2, z: 3, a: 4, b: 5, c: 6 };

  // 默认分支（kind >= 30 或其它值），仍然带 x，且 shape 也不同于上面任何一种
  return { y: 1, a: 2, b: 3, c: 4, x: 5 };
}

// 一个函数里集中触发几种 IC：LoadIC / StoreIC / KeyedLoadIC / KeyedHasIC
function propertyInlineCacheDemo(targetObject, propertyName) {
  let total = 0;

  total += targetObject.x;              // LoadIC
  targetObject.x = total;               // StoreIC
  // total += targetObject[propertyName];  // KeyedLoadIC
  // if (propertyName in targetObject) {   // KeyedHasIC
  //   total++;
  // }
  return total;
}

// ---------- 预热：建立 feedback + handler（第 1 讲核心） ----------
//%DebugPrint("1");
// 先让 IC 变成 MONOMORPHIC
for (let i = 0; i < 10; i++) {
  const objectForMono = createShape(0);
  propertyInlineCacheDemo(objectForMono, "x");
}
for (let i = 1; i < 30; i++) {
  const objectForMono = createShape(i);
  propertyInlineCacheDemo(objectForMono, "x");
  %DebugPrint(propertyInlineCacheDemo);
}

// let last = {"u":1,"v":2,"w":3,"x":4};
// %DebugPrint(propertyInlineCacheDemo);
// propertyInlineCacheDemo(last, "x");