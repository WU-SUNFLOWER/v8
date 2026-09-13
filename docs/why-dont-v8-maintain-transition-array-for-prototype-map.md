# 为什么 V8 没有为 prototype map 维护 Transition Array？

核心原因是 **复用价值很低，而且 prototype 的变化需要处理的是另一类问题**。

普通 Map 的场景是：

```text
10000 个 Foo 实例
        │
        ├── foo1
        ├── foo2
        ├── foo3
        └── ...
```

它们共享 Map，所以记录：

```text
Map{x} -- add y --> Map{x,y}
```

非常划算。

但 prototype object 通常更像：

```text
             A.prototype
                  │
一个会被大量JavaScript实例对象（的属性读写操作）依赖的原型对象
                  │
           当前 prototype Map
```

当：

```js
A.prototype.foo = ...
```

发生以后，V8 真正关心的不是：

> “以后如果另一个对象碰巧从这个 prototype Map 添加 `foo`，能不能复用 Map？”

而是：

> “所有依赖这条 prototype chain 的 IC / optimized code 现在是不是失效了？”

因此 prototype map 把本来存 TransitionArray 的空间拿来存 **`PrototypeInfo`**。

`PrototypeInfo` 里面恰恰存的是 prototype 特有的东西，例如：

```text
prototype_users
derived_maps
prototype_chain_enum_cache
registry_slot
cached_handler
...
```

尤其是 `prototype_users`，它维护“哪些 Map 使用这个对象作为 prototype”，用于 prototype chain invalidation。

所以可以把两类 Map 的重点理解成：

```text
普通 Map
━━━━━━━━━━━━━━━━━━━━━━━━━━
关注：
    “我的 shape 下一步可能变成什么？”

所以保存：
    TransitionArray


Prototype Map
━━━━━━━━━━━━━━━━━━━━━━━━━━
关注：
    “谁依赖我这个 prototype？”
    “我的改变会使哪些 prototype chain 失效？”

所以保存：
    PrototypeInfo
```

这两个需求在 V8 的设计里恰好是**互斥的**，于是可以 union 到一个字段里。

# 一个很重要的细节：PrototypeInfo 会跟着 Map 搬家

这也能很好地说明“没有 transition ≠ 没有 Map migration”。

prototype object 发生 shape change 后，会从：

```text
object
  │
  └── old prototype Map
```

迁移到：

```text
object
  │
  └── new prototype Map
```

V8 此时会做：

```cpp
new_map->set_prototype_info(old_map->prototype_info());
old_map->set_prototype_info(Smi::zero());
```

也就是说：

```text
old ProtoMap
 ┌──────────────┐
 │ PrototypeInfo│──────────────┐
 └──────────────┘              │
                               ▼
                       new ProtoMap
                     ┌──────────────┐
                     │ PrototypeInfo│
                     └──────────────┘
```

同时会 invalidate prototype chains，并重新处理 prototype user registration。

这个机制其实特别漂亮：

**V8 不保存 `old prototype Map → new prototype Map` 的 transition edge；它把真正有意义的 prototype 元数据从旧 Map 搬到新 Map。**
