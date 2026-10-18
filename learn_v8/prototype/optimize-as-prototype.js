// 1. 定义构造函数（用于创建对象，初始化属性）
function Person(name, age) {
    this.name = name;
    this.age = age;
}

// 2. 通过 prototype 添加方法（所有实例共享）
Person.prototype.sayHello = function() {
    return '你好，我是' + this.name + '，今年' + this.age + '岁。';
};

//%DebugPrint(Person.prototype);

// 3. 使用 new 创建实例
const person1 = new Person('张三', 25);

//%DebugPrint(Person.prototype);