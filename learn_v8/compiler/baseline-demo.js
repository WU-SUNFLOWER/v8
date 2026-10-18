function add(x, y) {
    return x + y;
}

for (let i = 0; i < 20000; i++) {
  //print(i);
  add(i, i + 1);
}

%DebugPrint(add);