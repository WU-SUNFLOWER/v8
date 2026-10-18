function f() {
    return function inner(a, b) {
        return a + b;
    }
}

let f1 = f();
let f2 = f();
let f3 = f();

for (let i = 0; i < 10000; ++i) {
  f1(i, i + 1);
}

%DebugPrint(f1);
%DebugPrint(f2);
%DebugPrint(f3);
