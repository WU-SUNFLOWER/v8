// d8 --no-turbo --trace-ic your_script.js        (可选，用来观察 IC 转换日志)

function makeA(c) {
    function inner(x) { return c + x; }
    return inner;
}

function makeB(d) {
    function inner(x) { return d * x; }
    return inner;
}

function wrapper(fn) {
    // CallIC 通常出现在: 对"可变 callee（参数 fn）"的调用处
    return fn(10);
}

const f1 = makeA(1);
const f2 = makeA(2);
const f3 = makeB(3);
wrapper(f1);
%DebugPrint(wrapper);

// 1) UNINITIALIZED -> MONOMORPHIC
for (let i = 0; i < 8; i++) wrapper(f1);
%DebugPrint(wrapper);

wrapper(f1);
%DebugPrint(wrapper);

// 2) MONOMORPHIC -> POLYMORPHIC
// 交替 f1/f2, 促使 call site 学到"多个目标，但它们可共享同一 feedback_cell"
// for (let i = 0; i < 20; i++) wrapper((i & 1) === 0 ? f1 : f2);
// %DebugPrint(wrapper);

// 3) POLYMORPHIC -> GENERIC
for (let i = 0; i < 20; i++) wrapper(f3);
%DebugPrint(wrapper);