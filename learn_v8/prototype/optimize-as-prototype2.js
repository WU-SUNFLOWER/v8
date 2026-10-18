function Animal(name) {
  this.name = name;
}

Animal.prototype.sayHello = function () {
  console.log("I'm " + this.name);
};

function Dog(name) {
  Animal.call(this, name);
}

Dog.prototype = new Animal();
Dog.prototype.constructor = Dog;

Dog.prototype.bark = function () {
  console.log("Woof!");
};

const dog = new Dog("Rex");

%DebugPrint(Dog.prototype);

print("%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%");

Dog.prototype.die = function() {
  console.log("dead!");
};

print("%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%");

%DebugPrint(Dog.prototype);