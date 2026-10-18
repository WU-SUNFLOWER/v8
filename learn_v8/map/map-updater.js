function Point() {
    this.x = 1;
}

function foo() {
    let p1 = new Point();
    %DebugPrint(p1);
    print("$$$$$$$$$$$$$$$$$flag$$$$$$$$$$$$$$$$");
    p1.x = [1,2,3];
    %DebugPrint(p1);
}

foo();