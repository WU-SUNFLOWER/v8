---
title: "Why V8 does not check the color of objects in Marking Barrier"
description: "从三色不变式、Relaxed Atomic 与并发执行时序出发，理解 V8 为什么移除标记写屏障对 host 颜色的逐对象检查。"
date: 2026-10-22
tags: [V8, Garbage Collection, Concurrent Marking, Write Barrier, Memory Model]
---

# Why V8 does not check the color of objects in Marking Barrier

> **一句话摘要：** V8 的并发标记写屏障不再依赖“引用来源对象（host）必须是黑色”这一逐对象颜色条件。因为在 Relaxed Atomic 的并发执行环境中，先写字段、再检查 host 颜色的代码若缺少必要同步，可能漏标；保守地尝试标记写入的目标（value），则能避免在每次写入后额外插入昂贵的内存屏障。

## 1. 先澄清标题中的一个歧义

标题中的“does not check the color of objects”需要精准理解：

**V8 不是完全不查看任何对象的标记状态。** 它不再为了判断本次写入是否需要标记，而**逐个检查引用来源 `host` 是不是黑色**；它仍然需要判断和原子更新引用目标 `value` 的标记状态。

此外，V8 仍会在写屏障的快速路径上检查**内存页的标志位**，并有对 Smi、只读对象、特殊初始化写入等情形的优化。这些**页级过滤条件**不能与 `color(host) == BLACK` 的**逐对象颜色检查**混为一谈。[2]

本文重点讨论的是：**为什么并发标记时不保留 `color(host) == BLACK` 这一判断？**

## 2. 从 Dijkstra 风格的增量写屏障说起

三色标记将对象划分为：

- **White：** 尚未发现；
- **Grey：** 已发现，后继引用还未处理完；
- **Black：** 后继引用已处理。

我们希望避免发生以下情况：

```text
GC Roots
   |
   v
  A(黑) ----------> C(白)
                    ^
                    |
            GC 可能再也不会发现它
```

如果 A 已经被扫描为黑色，此时 Mutator 执行 `A.field = C`，而 C 还是白色，GC 就可能漏掉仍然可达的 C。这违反了增量更新式三色标记要维护的 **强三色不变式（strong tri-color invariant）**：不允许黑色对象指向未被适当处理的白色对象。

在一个按程序顺序执行的简单增量标记模型中，可以使用下面的屏障：

```cpp
// 教学伪代码：单线程增量标记模型
store(host.field, value);

if (color(host) == BLACK && color(value) == WHITE) {
    color(value) = GREY;
    marking_worklist.push(value);
}
```

它的判断非常直观：

- host 为**黑色**：它已经扫描完毕；这次新增的白色目标可能不会再被正常遍历发现，因此必须补标。
- host 为**灰色**：将来扫描它的引用字段时，本应能够发现目标，所以似乎可以跳过屏障。

V8 官方 2018 年的文章在介绍从增量标记迁移到并发标记的过程时，正是用这种简化写法对比后续设计。[1]

## 3. 并发标记为什么把问题变复杂？

在 **Parallel Marking** 阶段，JavaScript 暂停，多个 GC 线程共同扫描一个相对静止的对象图；而 **Concurrent Marking** 允许 GC Worker 扫描堆的同时，Mutator 继续修改对象字段。

因此，下面两种操作可能并发发生：

```cpp
// Mutator
host.field.store(value, std::memory_order_relaxed);
```

```cpp
// GC Worker
auto observed = host.field.load(std::memory_order_relaxed);
```

对同一个原子字段，`memory_order_relaxed` 提供的是原子性及该原子对象的修改顺序约束，**不自动建立这两条操作之间的 synchronizes-with / happens-before 关系，也不保证 Worker 每次都读取到 Mutator 最近写下的值**。

这本身不意味着 GC 错误：GC 可以允许 Worker 读到旧引用，再由写屏障提供另一条“发现新目标”的路径。

危险在于：**如果这个写屏障仍然根据 host 的颜色决定要不要工作，并且没有必要的排序约束，就可能同时失去这两条路径。**

## 4. 一个真正会漏标的竞态时序

假设：

```text
Root --> A(灰) --> B(已标记)

C(白)
```

Mutator 打算执行 `A.field = C`。GC Worker 正在扫描 A。

表面上，Mutator 的程序是“先写 A.field，再检查 A 的颜色”：

```cpp
A.field.store(C, std::memory_order_relaxed);

if (color(A) == BLACK) {
    shade_if_white(C);
}
```

但如果没有额外同步，不能依赖这次 relaxed 写入与另一个位置上的 `color(A)` 读取，在**跨线程可观察顺序**上始终满足算法所需要的约束。V8 官方特别指出，host 颜色读取可能被重排到字段写入之前。[1]

于是有一种危险的可观察执行（教学时序）：

| 顺序 | Mutator | GC Worker |
| --- | --- | --- |
| ① | 提前观察 `color(A) == GREY` | |
| ② | | 读取 `A.field`，仍看到旧值 B |
| ③ | | 扫描完 A，把 A 转成 BLACK |
| ④ | 执行/发布 `A.field = C` | |
| ⑤ | 因之前观察到 GREY，决定**不标记 C** | |

最终形成：

```text
Root --> A(黑) ----> C(白)
                        X 没有进入标记工作队列
```

C 现在明明通过 Root → A → C 可达，却仍可能在本轮结束时是白色。如果 GC 不做其他补救，就可能**错误回收活对象**，造成严重的正确性问题。

注意：这里讨论的是**在缺少恰当同步时允许的跨线程行为**，不是声称每次在某种 CPU 上都会按表中的物理指令顺序执行。关键在于：源码中的语句顺序本身，不能自动充当并发 GC 正确性证明。

## 5. 两种解决路径：强制排序，或者保守标记

### 方案 A：保留 host 颜色检查，加同步

一种理论方案是：

```cpp
atomic_relaxed_write(&host.field, value);

// 必须使用与其他并发操作配套、足以排除危险交错的同步协议
appropriate_memory_fence();

if (color(host) == BLACK && color(value) == WHITE) {
    shade(value);
}
```

V8 官方文章用 `memory_fence()` 表示为了保留 host 颜色判断所需的额外排序成本。[1] 这里的 `appropriate_memory_fence()` 是**算法示意**，并不是说任意一条孤立的 C++ fence 就一定足够；具体正确性仍取决于所有相关原子操作及同步协议。

问题在于：**对象字段写入非常频繁。** 如果大量普通堆字段写入都需要额外的昂贵同步，吞吐量可能受到明显影响。

### 方案 B：不检查 host 是否为黑色，直接尝试标记 value

V8 在文章中给出的并发写屏障模型是：

```cpp
// 教学伪代码，概括 V8 2018 年文章中的算法
atomic_relaxed_write(&host.field, value);

// 写入后的 marking barrier：不查询 color(host)
if (color(value) == WHITE &&
    atomic_color_transition(value, WHITE, GREY)) {
    marking_worklist.push(value);
}
```

这里有两个核心变化：

1. **移除 `color(host) == BLACK`**：不依赖 Mutator 对 host 扫描进度的观察结果。
2. **原子地尝试把 value 从白色变成灰色**：当 Worker 和 Mutator 同时发现同一个 value 时，由原子状态转换协调；成功认领标记工作的参与者将它加入工作队列。

看回刚才的危险竞态：即使 Worker 读取到了旧的 B，Mutator 在写入 C 后仍然会通过写屏障尝试标记 C。因此，**GC 不要求 Worker 必须通过扫描 `A.field` 才能发现 C**。

可以把它想象成两条互为补充的发现路径：

```text
   GC Worker                  Mutator
      |                          |
扫描对象字段                  写入新引用
      |                          |
发现被引用对象              Marking Barrier
      |                          |
      +------------+-------------+
                   |
            原子标记状态
                   |
             Marking Worklist
```

这并不等于“整个 V8 的写屏障对所有写入都无条件标记”：快速路径、对象类型、堆空间、是否处于标记阶段等前置条件仍然存在。这里描述的是**到达适用的标记屏障路径后，不再逐对象查询 host 的黑/灰颜色**。[2]

## 6. 以源码理解：为什么还要 `TryMark()`？

对于目标对象，不能简单执行：

```cpp
if (color(value) == WHITE) {  // 普通检查
    color(value) = GREY;       // 普通修改
    worklist.push(value);
}
```

因为并发线程可能同时看到白色并重复修改状态、重复认领任务。并发 GC 需要把“我是否成功认领了这个尚未标记对象”的决定做成原子操作。

一个 V8 源码快照中的关键函数是：[3]

```cpp
// 摘自指定源码快照，省略无关部分
bool MarkingBarrier::WhiteToGreyAndPush(HeapObject obj) {
    if (marking_state_.TryMark(obj)) {
        current_worklist_->Push(obj);
        return true;
    }
    return false;
}
```

这段代码的理解重点不是精确背诵函数名，而是其中的协议：

- 对 `value` 的标记状态做并发安全的尝试；
- 成功者提交相应的标记工作；
- 已标记的对象不需要被再次当作全新对象提交。

这样，Mutator 的写屏障与 GC Worker 的普通追踪可以协调完成对象发现，而不是依靠对 `host` 黑色状态的一次可能不可靠的读取。

## 7. 保守写屏障的代价：多标记一些垃圾

移除 host 颜色检查会扩大需要尝试标记的情况。

例如，某次写入发生在一个**尚未可达，或者最终不会被 Roots 到达**的 host 上：

```text
Root --> A

H(不可达或将不可达) ----> C(白)
                          |
                   被写屏障标记
```

如果写入满足实际标记屏障的适用条件，C 仍可能被保守地标记为灰色，再被扫描并保留。即使 C 最终并没有从 Roots 出发的有效强引用路径，它也可能留到后续适当的收集周期。

这就和上一篇文章的 **Floating Garbage** 联系了起来：

> **宁可多标记一个暂时不需要保留的对象，也不能因为竞态而漏标一个仍然活着的对象。**

它不是“使用 relaxed memory order 就一定有问题”，而是**通过算法上的保守性，避免在每次字段写入时施加更强的同步约束**。

## 8. 几个容易混淆的边界

### 8.1 “不检查 host 颜色”不等于“完全不检查 host”

V8 的现代写屏障实现仍会通过 `POINTERS_FROM_HERE_ARE_INTERESTING` 等内存页标志进行筛选，并根据写入目标是否有需要记录的引用决定是否进入更慢的路径。页级条件不是逐个对象的 `color(host) == BLACK`。[2]

### 8.2 标记屏障不等于所有写屏障

V8 还有记录 Old-to-New 引用的代际写屏障，以及在整理期间用于记录搬迁相关槽位的屏障。三者目的不同，不能把 `marking_worklist.push(value)` 当成所有写屏障的统一行为。[2]

### 8.3 不要把强引用和弱引用混成一种语义

前面的例子都默认 `host.field` 是**强引用槽位**。Weak References、Ephemerons、JS WeakMap 等有专门的追踪语义；不能把“所有被写入的指针都应该作为强引用保活”当作通用 GC 规则。

### 8.4 这里讨论的是 Concurrent Marking，不是普通 STW Parallel Marking

如果 Mutator 已经停止，堆对象图不再与它并发变化，GC Worker 的主要任务是安全地分工遍历堆图；而本文的问题恰恰是**Mutator 和 Worker 同时读写对象图**时，如何避免丢失存活边。

### 8.5 Relaxed 不等于可以读到任意陈旧值

Relaxed Atomic 仍满足同一原子对象的修改顺序和 C++ coherence 约束。一旦**其他同步操作**建立了字段写入 happens-before 读取，后续 relaxed load 仍受 write-read coherence 规则约束。本文并没有声称 relaxed 永远看不到最新值，而是说**它本身不负责建立最新值可见性所需的跨线程同步**。

## 9. 我的复习卡片

> **问题：** 为什么 V8 的并发标记写屏障不检查 `color(host) == BLACK`？
>
> **根源：** Relaxed 字段写入与 host 颜色读取若缺少必要排序约束，可能产生“Worker 看见旧字段、Mutator 看见旧的 GREY 状态”的竞态，使白色可达对象丢失。
>
> **权衡：** 与其在每次适用的对象字段写入后加入昂贵的同步，不如保守地尝试标记 `value`。
>
> **并发正确性：** 用原子状态转换（如 `TryMark`）协调对象标记，用工作队列交付尚需扫描的对象。
>
> **代价：** 可能额外标记当前不可达的对象，形成或增加 Floating Garbage。
>
> **精确措辞：** 不逐对象检查 **host 是否黑色**，不代表不检查 **value 的标记状态**或不用**页级过滤**。

### 留给自己思考的三个问题

1. 如果我们坚持 `color(host) == BLACK` 这个条件，必须建立怎样的操作排序与同步关系，才能排除第 4 节的竞态？
2. `TryMark(value)` 和 `worklist.push(value)` 各自维护什么不变式？只有原子更新标记位而不提交工作，为什么仍然可能出问题？
3. 进入 STW 后，新启动的 GC Worker 为什么可以使用 relaxed load 读取暂停前的字段写入？**提示：** 需要从任务发布、Mutex 或其他同步协议证明 happens-before，不能仅凭“STW”三个字得出结论。

## 参考资料

1. [V8 Blog — Concurrent marking in V8（2018）](https://v8.dev/blog/concurrent-marking)：本文的主要一手依据，尤其是 **Write barrier** 小节对“移除 host 颜色判断”与内存屏障的解释。
2. [V8 Source — WRITE_BARRIER.md（main 分支）](https://chromium.googlesource.com/v8/v8.git/+/refs/heads/main/src/heap/WRITE_BARRIER.md)：现代 V8 写屏障的种类、页级过滤和特殊情况。
3. [V8 Source — marking-barrier-inl.h（固定提交快照）](https://chromium.googlesource.com/v8/v8/+/0e002e07d8710d18776fb873fd816cc9f20cc857/src/heap/marking-barrier-inl.h)：`MarkValueLocal`、`WhiteToGreyAndPush` 与 `TryMark` 的具体例子。实际版本中的函数签名、辅助路径可能变化。
4. [V8 Blog — Trash talk: the Orinoco garbage collector（2019）](https://v8.dev/blog/trash-talk)：Parallel、Incremental、Concurrent 这三个概念的区分。

---

*写作说明：本文区分了 V8 官方 2018 年解释设计动机时的算法伪代码，与具体版本中的实现细节。竞态时序是为展示缺失同步时的可行错误执行而构造的教学模型，并非声称 V8 当前存在这一 bug。*
