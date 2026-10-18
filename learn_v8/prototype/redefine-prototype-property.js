function Animal(name) {
    this.name = name;
}

function callBark(o) {
    return o.bark();
}

Animal.prototype.bark = function() {
    return "bark!";
}

const dog = new Animal("Dog");

Animal.prototype.bark = function() {
    return "woof!";
};

Animal.prototype.bark = function() {
    return "wowo!";
};

%SetDebuggerBreakpointEnabled(true);

%SetDebugPrintEnabled(true);
%DebugPrint(%GetCurrentFunction());
%SetDebugPrintEnabled(false);

for (let i = 0; i < 100; i++) {
    callBark(dog);
}

%SetDebugPrintEnabled(true);
%DebugPrint(%GetCurrentFunction());

Animal.prototype.die = function() {
    return "die!";
};
