function add(a, b) {
    return a ** b;
}

for (let i = 0; i < 30; ++i) {
    add(BigInt(i), BigInt(i));
}
%DebugPrint(add);

// add(1000, 123);
// %DebugPrint(add);