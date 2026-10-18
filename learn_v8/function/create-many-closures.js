function makeAdder(y) {
    return function(x) {
        return x + y;
    }
}

let f1 = makeAdder(2026);
let f2 = makeAdder(2027);
let f3 = makeAdder(2028);

f1(721);
f2(721);
f3(721);
  
for (let i = 0; i < 600; ++i) {
    f1(i);
}

// %CompileBaseline(f1);
// %CompileOptimized(f1);

%DebugPrint(f1);
%DebugPrint(f2);
%DebugPrint(f2);

f1(721);
f2(721);
f3(721);

%DebugPrint(f1);
%DebugPrint(f2);
%DebugPrint(f2);

//%DebugPrint(f3);