%SetDebuggerBreakpointEnabled(false);
%SetDebugPrintEnabled(false);

function Animal(name) {
  this.name = name;
}

Animal.prototype.sayHello = function () {
  return "I'm " + this.name;
};

function Dog(name) {
  Animal.call(this, name);
};

Dog.prototype = Object.create(Animal.prototype);
Dog.prototype.constructor = Dog;

Dog.prototype.bark = function () {
  return "Woof!";
};

function testDog(dog) {
    //%SetDebuggerBreakpointEnabled(true);
    //%SetDebugPrintEnabled(true);
    dog.sayHello;
    //%SetDebuggerBreakpointEnabled(false);
    //%SetDebugPrintEnabled(false);
    dog.bark;
    return dog.name;
};

const dog1 = new Dog("Rex");
const dog2 = new Dog("Denny");

for (let i = 0; i < 11; ++i) {
  console.log(`i=${i}`);
  testDog(Math.random() < 0.5 ? dog1 : dog2);
};

//%SetDebuggerBreakpointEnabled(true);
//%SetDebugPrintEnabled(true);
Animal.prototype.sayHello = function () {
  return "I'm " + this.name + "(override)";
};
//%SetDebuggerBreakpointEnabled(false);
//%SetDebugPrintEnabled(false);

%SetDebuggerBreakpointEnabled(true);
%SetDebugPrintEnabled(true);
Animal.prototype.die = function () {
  return "I'm " + this.name + ", dead";
};
%SetDebuggerBreakpointEnabled(false);
%SetDebugPrintEnabled(false);

console.log("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");

testDog(dog1);

// %SetDebugPrintEnabled(true);
// %DebugPrint(testDog);
// %SetDebugPrintEnabled(false);

console.log("&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&");

testDog(dog2);

