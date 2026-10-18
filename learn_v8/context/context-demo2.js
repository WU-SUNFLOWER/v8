var x = 123;
print(globalThis.__proto__.x) // => undefined
print(globalThis.__proto__.__proto__ === Object.prototype) // => true