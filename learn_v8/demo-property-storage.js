function foo() {
  const obj = {};
  obj.a = 1;
  obj.b = 2;
  obj.c = 3;
  obj.d = 4;
  obj.e = 5;  // 很可能从这里开始溢出到 PropertyArray
  obj.f = 6;
  obj.g = 7;
  obj.h = 8;
  %DebugPrint(obj);
}
foo();