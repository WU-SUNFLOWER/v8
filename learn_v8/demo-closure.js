function outer(x) {
    return function inner(obj) {
        return obj.value + x;
    };
}

let f1 = outer(1);        // 常喂普通对象
let f2 = outer("hello");  // 常喂字符串包装对象或别的奇怪对象
let f3 = outer({});       // 行为更不一样