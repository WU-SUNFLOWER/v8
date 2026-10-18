function createCounters() {
    function increment(x) {
        return x + 1;
    }
    return increment;
}

%DebugPrint("3");

let counters = [];
for (let i = 0; i < 10; i++) {
    counters.push(createCounters());
    %DebugPrint(createCounters);
}

%DebugPrint(createCounters);

for (let i = 0; i < 10; i++) {
    %DebugPrint(counters[i]);
}
for (let i = 0; i < 11; i++) {
    counters[0](336);
}

counters[1](337);
%DebugPrint(counters[1]);

counters[2](338);
%DebugPrint(counters[2]);