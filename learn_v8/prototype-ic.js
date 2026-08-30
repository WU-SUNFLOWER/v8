%SetDebuggerBreakpointEnabled(false);

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
    %SetDebuggerBreakpointEnabled(true);
    dog.sayHello;
    %SetDebuggerBreakpointEnabled(false);
    //dog.bark();
    return dog.name;
};

const dog1 = new Dog("Rex");
const dog2 = new Dog("Denny");

for (let i = 0; i < 100; ++i) {
    console.log(`i=${i}`);
    testDog(Math.random() < 0.5 ? dog1 : dog2);
};

%DebugPrint(dog1);
%DebugPrint(dog2);

print("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");

%DebugPrint(Animal.prototype, 1, false);
%DebugPrint(Dog.prototype, 1, false);
%DebugPrint(testDog, 1, false);