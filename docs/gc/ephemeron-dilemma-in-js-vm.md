# What's Ephemeron Dilemma in JS VM and how to solve it

在实现一门 JavaScript VM 的 Garbage Collector 时，`WeakMap` 往往是一个比想象中更棘手的功能。

乍看之下，它似乎只是：

> Map 的 key 不应该阻止对象被 GC。

于是一个很自然的想法是：把 `WeakMap` 的 key 做成 weak reference，不就行了吗？

遗憾的是，并没有这么简单。

真正困难的地方在于：**WeakMap 的 value 可以引用 key。**

这会把一个看似普通的 weak reference 问题，升级成垃圾回收领域一个经典的问题：

> **Ephemeron Dilemma**

它迫使 GC 回答一个很微妙的问题：

> 一个对象是否存活，可能取决于另一个对象是否存活；而后者是否存活，又可能间接依赖前者。GC 如何在不产生“自我证明存活”的情况下求出正确的 live object closure？

这篇文章尝试从 VM/GC 实现者的角度解释这个问题，并看看 V8、HotSpot 和 QuickJS 分别是怎么面对它的。

---

## 1. 从普通 GC 的 reachability 说起

对于传统 tracing GC，世界通常很简单。

假设：

```text
Root
 |
 v
 A
 |
 v
 B
 |
 v
 C
```

GC 从 Roots 开始进行 tracing：

```text
Root -> A -> B -> C
```

于是：

```text
A = live
B = live
C = live
```

所有无法从 Root 沿强引用到达的对象，则被视为 unreachable，并最终被回收。

可以把这个规则简单理解成：

```text
if A is live
and A strongly references B
then B is live
```

也就是一种普通的可达性闭包：

```text
Live = transitive_closure(Roots)
```

Mark-Sweep、Mark-Compact、Copying GC、Generational GC 虽然具体实现差异很大，但这一基本思想是相通的。

问题从 weak reference 出现时开始变得复杂。

---

## 2. Weak Reference 并不等于 Ephemeron

对于普通 weak reference：

```text
A --weak--> B
```

规则通常是：

> A 活着，并不能使 B 活着。

也就是说，GC tracing 时不会因为这条 weak edge 去 mark `B`。

例如：

```text
Root -> WeakRef -> B
```

如果没有其他 strong path：

```text
Root ==> B
```

那么 `B` 仍然可以被回收。

所以 weak reference 的语义其实很好理解：

```text
strong edge: participates in liveness
weak edge:   does not participate in liveness
```

但 `WeakMap` 并不是简单的：

```text
WeakMap --weak--> key
WeakMap --strong--> value
```

如果真的这样实现，很快就会出现问题。

---

## 3. WeakMap 为什么不能只是「weak key + strong value」

考虑：

```javascript
const wm = new WeakMap();

let key = {};
let value = { key };

wm.set(key, value);

key = null;
value = null;
```

这里对象关系是：

```text
             WeakMap
             /     \
         weak       strong
          |           |
          v           v
          K <-------- V
                strong
```

其中：

```text
V -> K
```

是一条普通强引用。

如果 VM 简单地把：

```text
WeakMap -> V
```

当成普通强引用，那么 tracing 会得到：

```text
Root
 |
 v
WeakMap
 |
 v
 V
 |
 v
 K
```

于是：

```text
V = live
K = live
```

问题出现了：

**WeakMap 自己通过 value 间接把 key 救活了。**

结果就是：

```text
WeakMap -> V -> K
```

导致 `K` 永远不能死亡。

而 `K` 不死亡，WeakMap entry 也不会删除。

于是 WeakMap 失去了存在意义。

这正是为什么：

> `WeakMap<K, V>` 不能简单实现为 weak `K` + strong `V`。

---

# 4. Ephemeron 是什么？

Ephemeron 可以抽象成一对：

```text
(key, value)
```

但是这条关系不是普通的：

```text
key -> value
```

而是一条**条件强引用（conditional strong edge）**：

> 只有当 key 已经因为 ephemeron 之外的原因存活时，value 才因为这个 ephemeron 而存活。

也就是说：

```text
if key is already live:
    value becomes live
```

这里最重要的词是：

> **already**

我们不能先通过 `value` 找到 `key`，然后再以“key 活着”为理由保留 `value`。

否则就会出现循环论证：

```text
value is live
    because key is live

key is live
    because value references key
```

这是一种典型的：

```text
A because B
B because A
```

也就是：

> **self-sustaining liveness cycle**

Ephemeron 的核心语义，就是禁止这种“自我证明存活”。

---

# 5. Ephemeron Dilemma

现在重新看刚才的对象图：

```text
             Ephemeron
             (K, V)

               V
               |
               v
               K
```

假设外界已经没有任何引用能够到达 `K`。

正确答案应该是：

```text
K = dead
V = dead
```

即使：

```text
V -> K
```

也不能让 `K` 活下来。

为什么？

因为 `V` 自己是否应该存活，取决于：

```text
K 是否首先存活
```

而不是反过来。

于是 GC 必须区分两种 reachability：

```text
普通 strong reachability

和

由 ephemeron 条件触发出来的 reachability
```

这就是 ephemeron dilemma 的核心：

> **我们需要允许 live key 保留 value，却不能允许 value 反过来成为 key 存活的理由。**

事情到这里还不算最麻烦。

真正使 GC 算法复杂化的是：

**ephemeron 可以形成依赖链。**

---

# 6. 为什么扫描一遍是不够的？

考虑三个 ephemeron：

```text
E1 = (K1, K2)
E2 = (K2, K3)
E3 = (K3, V)
```

同时：

```text
Root -> K1
```

对象关系是：

```text
Root
 |
 v
K1
 |
 | E1
 v
K2
 |
 | E2
 v
K3
 |
 | E3
 v
V
```

注意这些箭头不是普通强引用，而是：

```text
if Ki is live:
    Ki+1 becomes live
```

第一轮普通 GC tracing 完成之后，我们只知道：

```text
K1 = live
```

于是检查 ephemeron：

```text
E1.key == K1
```

发现 K1 已经存活。

因此：

```text
K2 = live
```

但是新的问题出现了：

K2 刚刚变成 live。

而：

```text
E2 = (K2, K3)
```

现在也应该生效。

于是：

```text
K3 = live
```

接着：

```text
E3 = (K3, V)
```

又生效：

```text
V = live
```

因此最终 closure 是：

```text
K1
 ↓
K2
 ↓
K3
 ↓
V
```

也就是说：

> ephemeron processing 本质上不是一次扫描，而是一个 fixed-point computation。

---

# 7. 最简单的解法：Fixed-Point Iteration

最直观的算法非常简单。

首先进行普通 marking：

```text
MarkFromRoots()
```

完全忽略 ephemeron 的 value edge。

然后反复扫描 ephemerons：

```text
repeat:
    changed = false

    for each (key, value) in ephemerons:
        if key is marked and value is not marked:
            mark(value)
            changed = true

    drain_marking_worklist()

until changed == false
```

换一种更加 VM 风格的伪代码：

```cpp
MarkRoots();
DrainMarkingWorklist();

do {
    bool changed = false;

    for (Ephemeron e : ephemerons) {
        if (IsMarked(e.key)) {
            if (TryMark(e.value)) {
                marking_worklist.push(e.value);
                changed = true;
            }
        }
    }

    if (DrainMarkingWorklist())
        changed = true;

} while (changed);
```

为什么这能工作？

因为算法只允许：

```text
already-live key
       ↓
     value
```

而不会让：

```text
value
  ↓
 key
```

反过来证明自己的 ephemeron entry 合法。

最终我们找到的是一个：

```text
least fixed point
```

即满足 ephemeron constraints 的**最小存活对象集合**。

这一点非常重要。

我们不是寻找：

```text
“有没有一种方法可以证明这些对象全都活着”
```

而是在寻找：

```text
“从真实 roots 出发，最少有哪些对象必须活着”
```

这正好消除了 self-sustaining cycle。

---

# 8. 为什么这仍然是一个 GC 工程问题？

上面的算法虽然正确，但它可能很慢。

假设存在：

```text
E1 = (K1, K2)
E2 = (K2, K3)
E3 = (K3, K4)
...
En = (Kn, V)
```

并且：

```text
Root -> K1
```

如果扫描顺序很不幸，那么：

第一轮：

```text
discover K2
```

第二轮：

```text
discover K3
```

第三轮：

```text
discover K4
```

……

最终可能需要：

```text
O(n)
```

轮。

而每一轮又扫描：

```text
O(n)
```

个 ephemerons。

于是最坏情况下接近：

```text
O(n²)
```

对于一个语言 VM 来说，这是不能轻易接受的。

因为攻击者甚至有可能人为构造非常长的 WeakMap dependency chain：

```text
K1 -> K2 -> K3 -> ... -> Kn
```

从而把一次 GC pause 放大。

于是问题进一步变成：

> 如何高效地计算 ephemeron fixed point？

---

# 9. 更好的思路：不要不停扫描所有 Ephemeron

关键观察是：

对于：

```text
E = (K, V)
```

如果目前：

```text
K = dead/unmarked
```

我们真正关心的事情只有一个：

> **K 什么时候第一次变成 marked？**

一旦 `K` 被 mark：

```text
K transitions:
white -> grey/black
```

我们就可以立即激活所有：

```text
key == K
```

的 ephemerons。

于是可以维护类似这样的依赖关系：

```text
waiting[K] = {
    V1,
    V2,
    V3,
    ...
}
```

当 K 被 mark：

```text
for value in waiting[K]:
    mark(value)
```

于是算法从：

```text
不断扫描所有 ephemerons
```

变成：

```text
key 状态发生变化时，
只唤醒依赖这个 key 的 ephemerons
```

概念上类似：

```cpp
void Mark(Object* obj) {
    if (!TryMark(obj))
        return;

    marking_worklist.push(obj);

    for (Object* value : pending_ephemerons[obj]) {
        Mark(value);
    }
}
```

当然真实 VM 要复杂得多。

例如必须处理：

```text
concurrent marking
parallel marking
generational GC
write barrier
incremental marking
young / old generation
weak processing phase
embedder tracing
```

但核心思想没有变：

> **把 ephemeron dependency 当成一个需要传播的 liveness dependency graph。**

---

# 10. 一个很有用的心智模型：Ephemeron 是 Horn Clause

甚至可以把：

```text
(key, value)
```

理解成一条逻辑规则：

```text
Live(key) => Live(value)
```

普通 strong reference：

```text
A -> B
```

对应：

```text
Live(A) => Live(B)
```

GC roots 对应：

```text
Live(RootObject)
```

整个 GC marking，其实可以看作是在求：

```text
Live(x)
```

这一组逻辑规则的最小闭包。

区别在于：

普通 strong edge：

```text
Live(A) => Live(B)
```

可以在对象扫描过程中立即处理。

Ephemeron：

```text
Live(K) => Live(V)
```

则必须确保：

```text
Live(K)
```

不是由这条 ephemeron 自己循环推导出来的。

从这个角度看，ephemeron GC 本质上就是：

> **monotonic data-flow fixed-point computation**

这也是为什么 worklist algorithm 会成为自然的实现方式。

---

# 11. V8 是怎么做的？

V8 是研究工业级 ephemeron 实现非常好的案例。

在 V8 的 `MarkCompactCollector` 中，可以直接看到 ephemeron 相关逻辑，例如：

```cpp
ProcessEphemeron(...)
MarkTransitiveClosureUntilFixpoint(...)
MarkTransitiveClosureLinear(...)
ProcessEphemerons(...)
```

其核心语义可以简化为：

```cpp
if (key is marked) {
    mark(value);
} else if (value is still unmarked) {
    defer(key, value);
}
```

也就是说，ephemeron 会被分成两种情况：

```text
key already reachable
        |
        v
mark value
```

或者：

```text
key not reachable yet
        |
        v
put into pending ephemerons
```

之后如果新的 marking 工作使更多 key 变成 reachable，就再次处理 unresolved ephemerons。

因此 V8 实际做的是：

```text
ordinary marking
      ↓
ephemeron processing
      ↓
new objects become marked
      ↓
drain marking worklist
      ↓
more keys may become marked
      ↓
ephemeron processing again
      ↓
...
      ↓
fixed point
```

更值得注意的是，V8 并不是无限制地依赖朴素 fixed-point iteration。

其实现中保留了两套路径：

```text
Fixed-point iteration

        ↓
if too many iterations

Linear ephemeron algorithm
```

也就是说：

> 对于常见情况，用简单且低常数开销的 iterative algorithm；如果 dependency chain 导致迭代次数过多，就切换到具有复杂度保证的 linear approach。

这是非常典型的工业 GC 设计：

```text
fast common case
+
bounded pathological case
```

而不是单纯追求理论上最漂亮的一套算法。

---

# 12. 为什么 Java WeakHashMap 不是 Ephemeron？

这里有一个非常容易产生的误区：

```text
VM 支持 weak reference
```

并不意味着：

```text
VM 支持 ephemeron
```

Java 的 `WeakHashMap` 就是一个很好的反例。

在 Java 中，`WeakHashMap<K, V>` 的 key 通过 weak reference 保存。

但是：

> **value 是普通的 strong reference。**

也就是说：

```text
WeakHashMap
    |
    +----weak----> K
    |
    +---strong---> V
                   |
                   +---strong---> K
```

如果：

```text
V -> K
```

那么从普通 GC tracing 看：

```text
Root
 |
 v
WeakHashMap
 |
 v
 V
 |
 v
 K
```

于是：

```text
K = live
```

因此这个 key 不会被回收。

事实上 Java `WeakHashMap` 的文档专门提醒：

> value 不应该直接或间接 strong-reference 自己的 key，否则 key 可能无法被回收。

而真正的 ephemeron：

```text
Ephemeron(K, V)
```

不会出现这个问题。

因为：

```text
V -> K
```

不能反过来成为：

```text
K is live
```

的证明。

因此：

```text
Java WeakHashMap
        !=
JavaScript WeakMap
```

这是理解 ephemeron 时非常重要的一点。

---

# 13. HotSpot 有没有 Ephemeron Solver？

HotSpot 当然拥有非常成熟的 weak-reference processing。

例如 Java 中存在：

```text
SoftReference
WeakReference
FinalReference
PhantomReference
```

HotSpot 的 GC 在 marking 的特定阶段会通过 reference processing machinery 对这些对象进行特殊处理。

大体可以理解成：

```text
ordinary tracing
       ↓
discover special References
       ↓
Reference Processing
       ↓
Soft / Weak / Final / Phantom
       ↓
clear / retain / enqueue
```

但是：

```text
Reference processing
```

和：

```text
Ephemeron fixed-point processing
```

不是同一个问题。

至少从 Java SE 暴露出来的对象语义看，并没有一个与 JavaScript `WeakMap` 等价的通用：

```text
(key, value)
```

ephemeron abstraction。

因此不能简单地说：

```text
HotSpot supports WeakReference

therefore

HotSpot has the same Ephemeron algorithm as V8
```

这是错误的推论。

更准确地说：

> **HotSpot 原生解决 Java reference semantics；V8 则因为 JavaScript WeakMap 的语义，必须在 GC 中解决 ephemeron closure。**

---

# 14. QuickJS 更有意思：它甚至不是传统 tracing GC

QuickJS 是另一个很值得对比的案例。

V8 的思考方式大体是：

```text
Tracing GC
+
Ephemeron marking
```

而 QuickJS 的基本 GC 架构不同。

QuickJS 主要使用：

```text
Reference Counting
+
Cycle Removal
```

普通对象可以通过引用计数及时释放：

```text
refcount == 0
        ↓
destroy object
```

但是：

```text
A -> B
^    |
|____|
```

这种 cycle 会使：

```text
refcount(A) > 0
refcount(B) > 0
```

即使整个环已经与程序 roots 完全断开。

所以 QuickJS 还有额外的：

```text
cycle removal pass
```

这意味着，对于 WeakMap 这样的结构，QuickJS 面临的是相同的**语言语义要求**，但底层 GC 问题的形状和 V8 不一样。

V8 可以描述为：

```text
roots
 ↓
marking
 ↓
ephemeron fixed point
 ↓
sweep / compact
```

QuickJS 更接近：

```text
reference counting
       +
weak-edge handling
       +
cycle removal
```

所以不能把 V8 的：

```text
MarkTransitiveClosureUntilFixpoint()
```

原封不动套到 QuickJS 上。

这里有一个非常重要的 VM 设计原则：

> **Ephemeron 是语言层面的 liveness semantics；fixed-point marking 只是 tracing GC 中实现这种 semantics 的一种方式。**

换句话说：

```text
Semantic requirement
        !=
Specific GC algorithm
```

GC 架构不同，解决 ephemeron problem 的工程方式也会不同。

---

# 15. 三种 VM 放在一起看

可以得到这样一个很有意思的比较：

| VM      | 主要弱关联                           | GC 模型                               | Ephemeron 情况                                                                   |
| ------- | ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| V8      | JS `WeakMap` / `WeakSet`        | Tracing / Generational / Concurrent | GC 原生实现 ephemeron semantics 与 fixed-point/linear processing                    |
| HotSpot | `WeakReference` / `WeakHashMap` | Tracing + Reference Processing      | 有成熟 weak-reference processing，但 Java `WeakHashMap` 本身不是 JS WeakMap 式 ephemeron |
| QuickJS | JS `WeakMap` / `WeakSet`        | Reference Counting + Cycle Removal  | 必须满足 WeakMap 的弱关联语义，但解决机制与 tracing GC 的 ephemeron marking 不同                   |

因此，当我们看到：

```text
weak
WeakRef
WeakMap
WeakHashMap
weak table
```

这些词时，不应该默认它们是同一种 GC primitive。

特别值得区分：

```text
Weak Reference
```

和：

```text
Ephemeron
```

两者并不等价。

---

# 16. 如果自己实现一个 JS VM，应该怎么设计？

如果正在给自己的 tracing GC 加 `WeakMap`，一个比较清晰的设计可以分成几个阶段。

## Phase 1：正常 Mark

从 GC Roots 开始：

```text
stack
globals
handles
native roots
VM roots
...
```

沿普通 strong references tracing：

```cpp
MarkRoots();
DrainMarkingWorklist();
```

遇到 `WeakMap` 时：

**不要直接 mark key，也不要无条件 mark value。**

只记录：

```text
(key, value)
```

ephemeron pair。

---

## Phase 2：Ephemeron Processing

对于每个：

```text
(key, value)
```

执行：

```cpp
if (IsMarked(key)) {
    Mark(value);
} else {
    Pending(key, value);
}
```

如果 value 被新 mark：

```text
value
 |
 +--> object A
 |
 +--> object B
```

还必须继续扫描其普通 strong edges。

于是：

```cpp
DrainMarkingWorklist();
```

---

## Phase 3：求 Fixed Point

新标记的对象可能使之前 unresolved 的 key 变成 live。

所以继续：

```text
process pending ephemerons
        ↓
drain marking worklist
        ↓
process newly enabled ephemerons
        ↓
...
```

直到：

```text
no new marked object
```

这时得到：

```text
ephemeron closure
```

---

## Phase 4：清理 Dead Entries

fixed point 完成后：

```text
if key is still unmarked:
    remove / clear ephemeron entry
```

然后 GC 才能安全地进入后续的：

```text
weak processing
sweeping
compaction
finalization
...
```

具体顺序当然取决于 GC 架构。

---

# 17. 一个更实用的算法框架

一个 VM 可以先实现简单版本：

```cpp
void ProcessEphemerons() {
    bool changed;

    do {
        changed = false;

        for (auto& e : ephemerons) {
            if (IsMarked(e.key) &&
                TryMark(e.value)) {
                marking_worklist.push(e.value);
                changed = true;
            }
        }

        if (DrainMarkingWorklist())
            changed = true;

    } while (changed);
}
```

优点：

```text
简单
正确
容易验证
容易 debug
```

对于小型 VM，这是一个非常合理的第一版。

等性能问题真正出现，再升级成：

```text
current_ephemerons
next_ephemerons
key-indexed pending table
worklist
```

或者：

```text
iterative fast path
+
linear fallback
```

这实际上也是非常值得借鉴的工业实现策略。

不要一开始就为了理论上的最优复杂度，把 GC weak processing 做成难以验证的状态机。

对于 GC 来说：

> **correctness > simplicity > optimization**

通常是更加健康的开发顺序。

---

# 18. Concurrent GC 下事情会更复杂

如果 GC 是 Stop-The-World collector，上述模型已经基本够用了。

但到了 concurrent / incremental marking，ephemeron 会产生新的问题。

例如 GC 已经判断：

```text
key currently unmarked
```

但 mutator 随后：

```text
Root -> key
```

使 key 重新变成 reachable。

或者 mutator 修改：

```text
WeakMap.set(key, value)
```

这些行为就可能需要：

```text
write barrier
weak write barrier
remembered set
ephemeron remembered set
```

之类的机制参与。

本质仍然是在维护一个 invariant：

> GC 不能错过任何一个“已经变成 live 的 key 所激活的 value”。

因此 concurrent ephemeron implementation 真正难的地方，不只是 fixed-point 本身，而是：

```text
Ephemeron semantics
        ×
Concurrent marking
        ×
Write barriers
        ×
Generational invariants
```

这些因素组合之后，才是工业 VM 中 weak processing 最容易出 bug 的地方之一。

---

# 19. 为什么 WeakMap 不允许枚举 key？

JavaScript 还有一个看似 API 设计、实际上和 GC 紧密相关的决定：

`WeakMap` 没有：

```javascript
keys()
values()
entries()
[Symbol.iterator]()
size
```

为什么？

因为如果程序能够观察：

```text
某个 weak key 现在还在不在
```

GC timing 就会直接变成 JavaScript observable semantics。

程序可能写：

```javascript
if (weakMap.size === 10) {
    ...
}
```

那么：

```text
GC 什么时候运行
```

就可能改变程序行为。

这会把本来应该属于 VM 实现细节的：

```text
GC scheduling
```

变成语言语义。

因此 WeakMap 的 API 有意避免暴露：

```text
“所有当前仍然存活的 keys”
```

这样的能力。

你必须已经拥有：

```text
key
```

才能调用：

```javascript
weakMap.has(key);
weakMap.get(key);
```

这也是 WeakMap 整体设计中非常漂亮的一点：

> API semantics 和 GC semantics 是共同设计出来的。

---

# 20. Ephemeron Dilemma 最核心的一句话

如果要把整篇文章压缩成一句话，我会这样描述：

> **Ephemeron Dilemma 是：GC 必须允许一个已经独立存活的 key 保留其 value，却不能允许这个 value 通过对象图反过来成为 key 存活的理由；同时 GC 还必须高效计算这种条件依赖关系产生的传递闭包。**

或者写成公式：

```text
Live(K)
   =>
Live(V)
```

但不能允许：

```text
Live(V)
   =>
Live(K)
   =>
Live(V)
```

形成一个没有外部 root 的自我支撑闭环。

---

# 21. 最后：WeakMap 实际上改变了 GC 的问题定义

普通 tracing GC 问的是：

> 哪些对象从 Roots 可达？

加入 ephemeron 后，问题变成：

> 在普通可达性和一组条件可达性规则共同作用下，哪些对象属于最小 live closure？

这已经不再是简单的 graph traversal。

它实际上变成了：

```text
Graph Traversal
       +
Conditional Edges
       +
Fixed-Point Computation
```

这也是为什么，第一次真正实现 `WeakMap` 时，很多 VM 开发者才会发现：

```text
WeakMap
```

不是一个普通 collection feature。

它实际上深入到了 GC 的对象存活定义之中。

而这正是 Ephemeron 最值得研究的地方。

它提醒我们：

> **Garbage Collection 从来不只是“找到不可达对象并释放内存”。真正困难的是先定义：什么叫做 reachable，什么叫做 live。**

当语言加入 weak references、ephemerons、finalizers、native objects、concurrent marking 之后，这个看似简单的问题，会迅速变成整个 VM runtime 最深的语义问题之一。

---

## References

- Barry Hayes, *Ephemerons: a New Finalization Mechanism*, OOPSLA 1997.
- ECMAScript Language Specification, *WeakMap Objects*.
- V8 source code, `src/heap/mark-compact.h` and `src/heap/mark-compact.cc`.
- Java SE API Specification, `java.util.WeakHashMap`.
- OpenJDK / HotSpot Reference Processing implementation.
- QuickJS Documentation, *Garbage Collection*.
- Alexandra Barros, Roberto Ierusalimschy, *Eliminating Cycles in Weak Tables*.
