print("hello from DebugPrintSimply");
%DebugPrintSimply("hello from DebugPrintSimply");

print(Math.cos);
%DebugPrintSimply(Math.cos);

print(Math.cos(Math.PI));
%DebugPrintSimply(Math.cos(Math.PI));

function Point(x, y) {
    this.x = x;
    this.y = y;
}

print(Point);
%DebugPrintSimply(Point);
