// 模块加载时执行
function Person(name) {
  this.name = name;
}

print("******************I %DebugPrint(Person) BEGIN**************************");
%DebugPrint(Person);
print("******************I %DebugPrint(Person) END**************************");

// 这里发生 “SetPrototype/SetInstancePrototype” 逻辑
Person.prototype = {
  sayHi() { return `hi ${this.name}`; }
};

print("******************II %DebugPrint(Person) BEGIN**************************");
%DebugPrint(Person);
print("******************II %DebugPrint(Person) END**************************");
  
// 到这里为止，业务上并没有 new Person()，很多情况下 V8 只存 prototype 对象即可
// => prototype_or_initial_map 可能先指向这个 JSReceiver（上面的对象字面量）
  
// 很久以后，某个请求到来才开始创建实例
const p = new Person("A");   // 这里会触发 EnsureHasInitialMap 创建 initial_map

print("******************III %DebugPrint(Person) BEGIN**************************");
%DebugPrint(Person);
print("******************III %DebugPrint(Person) END**************************");