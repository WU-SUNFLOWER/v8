---
title: "Why V8 Uses Dynamic Work Claiming Instead of Static Assignment When Concurrently Scavenging Old-Space Pages"
date: 2026-10-03
tags:
  - V8
  - Garbage Collection
  - Generational GC
  - Concurrency
  - Runtime Internals
---

# Why V8 Uses Dynamic Work Claiming Instead of Static Assignment When Concurrently Scavenging Old-Space Pages

> 本文讨论一个看似很小、实际上很能体现 GC 工程思维的问题：
>
> **当 V8 并发处理老生代中包含 old-to-new 引用的 pages 时，为什么不在 GC 开始前把这些 pages 平均分给每个 `Scavenger`，而要使用 `IndexGenerator + TryAcquire()` 这种动态认领（dynamic claiming）的方式？**

如果只看任务形态，这似乎是一个非常普通的并行循环：

```cpp
void ScavengerCollector::JobTask::ConcurrentScavengePages(
    Scavenger* scavenger) {
  while (remaining_memory_chunks_.load(std::memory_order_relaxed) > 0) {
    base::Optional<size_t> index = generator_.GetNext();
    if (!index) return;

    for (size_t i = *index; i < memory_chunks_.size(); ++i) {
      auto& work_item = memory_chunks_[i];
      if (!work_item.first.TryAcquire()) break;

      scavenger->ScavengePage(work_item.second);

      if (remaining_memory_chunks_.fetch_sub(
              1, std::memory_order_relaxed) <= 1) {
        return;
      }
    }
  }
}
```

一个自然的问题是：

假设 GC 开始时已经知道共有 100 个 old-space pages 包含 old-to-new remembered slots，而系统准备了 4 个 `Scavenger`，为什么不直接分成：

```text
Scavenger 0: Page  0 ~ 24
Scavenger 1: Page 25 ~ 49
Scavenger 2: Page 50 ~ 74
Scavenger 3: Page 75 ~ 99
```

这样甚至连 `TryAcquire()` 都不需要。

乍看之下，它更简单、更确定，也更少同步。

但 V8 没有这么做。

原因并不是 V8 偏爱“抢任务”，而是 **Scavenge old-to-new pages 具有几个非常典型的不规则并行工作负载特征**：

1. page 与 page 之间的实际处理成本高度不均匀；
2. GC Job 实际获得的并发度并不一定等于预先创建的 `Scavenger` 数量；
3. 处理一个 old-to-new page 还可能产生新的 copied/promoted object work；
4. Stop-The-World GC 对尾部延迟（tail latency）极其敏感；
5. 完全细粒度的中央任务队列虽然平衡性好，却会损失局部性并增加协调成本。

V8 采用的策略，本质上是在静态划分和细粒度 work stealing 之间找到一个很漂亮的折中：

> **用 `IndexGenerator` 动态切分工作区间，用 `ParallelWorkItem::TryAcquire()` 决定单个 page 的唯一所有权，再让成功认领的 worker 尽量连续向后处理。**

这更准确地说是一种 **dynamic work claiming + lazy partitioning**。

---

## 1. 先明确：这里到底在 “Scavenge” 什么？

理解调度策略之前，先要避免一个容易产生误解的地方：

```cpp
scavenger->ScavengePage(page);
```

并不意味着 V8 会遍历这个老生代 page 上的所有对象。

Minor GC 的目标是收集新生代，因此它不应该因为一个 old-space page 上存在一条 old-to-new 引用，就重新遍历整页老对象。

真正被处理的是这个 page 上记录下来的 remembered slots。

当前 V8 的实现大致是：

```cpp
void Scavenger::ScavengePage(MutablePage* page) {
  if (page->slot_set<OLD_TO_NEW, AccessMode::ATOMIC>() != nullptr) {
    RememberedSet<OLD_TO_NEW>::IterateAndTrackEmptyBuckets(
        page,
        [this, ...](MaybeObjectSlot slot) {
          return CheckAndScavengeObject(heap_, slot);
        },
        &local_empty_chunks_);
  }

  if (page->is_executable()) {
    RememberedSet<OLD_TO_NEW>::IterateTyped(...);
    // ...
  }

  if (page->slot_set<OLD_TO_NEW_BACKGROUND,
                     AccessMode::ATOMIC>() != nullptr) {
    RememberedSet<OLD_TO_NEW_BACKGROUND>::IterateAndTrackEmptyBuckets(...);
  }
}
```

所以这里的 “page work” 更准确地理解成：

```text
old-space page
      │
      ├── OLD_TO_NEW slots
      ├── typed OLD_TO_NEW slots
      └── OLD_TO_NEW_BACKGROUND slots
                  │
                  ▼
          CheckAndScavengeObject()
```

这也是为什么 V8 会在 GC 开始前先收集出：

```cpp
old_to_new_chunks_
```

而不是简单遍历整个 old generation。

从调度角度来说，一个 `MutablePage*` 只是 **remembered-set work 的容器和调度粒度**。

---

## 2. 为什么最直观的“预先平均分配”并不理想？

假设存在 16 个待处理 pages：

```text
P0 P1 P2 P3 P4 P5 P6 P7 P8 P9 P10 P11 P12 P13 P14 P15
```

有 4 个 scavenger。

最朴素的静态分配是：

```text
S0: P0  P1  P2  P3
S1: P4  P5  P6  P7
S2: P8  P9  P10 P11
S3: P12 P13 P14 P15
```

这种方案隐含了一个非常强的假设：

> `Cost(P0) ≈ Cost(P1) ≈ ... ≈ Cost(P15)`

但对于 remembered-set scanning，这个假设并不成立。

### 2.1 每个 page 上的 remembered slots 数量可以完全不同

例如：

```text
P0:    3 个 old-to-new slots
P1:   17 个 old-to-new slots
P2: 2400 个 old-to-new slots
P3:    5 个 old-to-new slots
```

虽然在 `old_to_new_chunks_` 里它们都只占一个元素，但真实工作量完全不同。

仅仅按照 page 数量平均划分，并不能得到平均工作量。

### 2.2 即使 slot 数量相同，处理成本也不相同

一个 remembered slot 可能指向一个已经被其他 worker evacuate 的对象：

```text
old slot
   │
   ▼
young object
   │
   └── already forwarded
```

此时工作基本只是：

```text
读取 forwarding address
        ↓
更新 old-space slot
```

但另一个 slot 可能第一次发现某个尚未处理的新生代对象：

```text
old slot
   │
   ▼
young object X
   │
   ├── copy to survivor space
   │
   └── 或 promote to old space
```

这会继续产生后续工作。

因此，一个 page 的成本并不是简单的：

```text
Cost(page) = number_of_slots(page)
```

更接近：

```text
Cost(page)
  ≈ 遍历 remembered slots 的成本
  + 首次发现 live young objects 的成本
  + copy / promotion 成本
  + forwarding contention
  + typed-slot 处理成本
  + remembered-set maintenance
  + 间接产生的后续 object tracing work
```

这是一种典型的 **irregular workload**。

---

## 3. 对 GC 来说，负载不均衡的真正代价是尾部延迟

普通后台任务里，某个线程多工作几毫秒可能只是吞吐量问题。

但 Scavenge 是 GC 的一部分。

对于 Stop-The-World 阶段，真正决定 pause time 的不是平均 worker 完成时间，而是：

```text
max(worker_0_time,
    worker_1_time,
    ...
    worker_n_time)
```

也就是最后完成的那个 worker。

假设静态分配之后真实工作量变成：

```text
S0: ███
S1: ███████████████████████
S2: ████
S3: ██
```

S0、S2、S3 很早就结束了。

但 mutator 仍然不能恢复，因为 S1 还在工作。

这意味着大量 CPU 已经闲置，而 GC pause 仍在继续。

对于并行 GC 来说，这种现象往往比“多做几次原子操作”昂贵得多。

因此，V8 更希望：

```text
处理得快的 worker
      ↓
继续认领新的 page
      ↓
自动承担更多工作
```

而不是：

```text
你的 pages 做完了
      ↓
即使别人还有一大堆工作
      ↓
你也退出
```

这就是 dynamic claiming 的第一个核心价值：

> **让实际执行速度，而不是预先估算，决定最终负载分布。**

---

## 4. 但 V8 也没有简单使用一个全局 `fetch_add` 队列

最简单的动态分配其实可以写成：

```cpp
while (true) {
  size_t i = next.fetch_add(1, std::memory_order_relaxed);
  if (i >= pages.size()) break;

  scavenger->ScavengePage(pages[i]);
}
```

这种模式非常常见。

每个 worker：

```text
拿一个 page
   ↓
处理
   ↓
再拿一个 page
```

负载均衡通常会很好。

但 V8 使用的是：

```cpp
IndexGenerator generator_;
ParallelWorkItem::TryAcquire();
```

原因在于 V8 并不只追求负载均衡。

它还希望：

- 避免每处理一个 page 都访问同一个全局计数器或队列；
- 尽量让一个 worker 连续处理相邻 work items；
- 允许新加入的 worker 从一个尚未处理完的大区间中间“切入”；
- 保持 ownership 判定非常便宜。

于是我们看到了一个更有意思的方案。

---

## 5. `IndexGenerator`：不是分配任务，而是寻找“切入点”

`IndexGenerator::GetNext()` 的核心逻辑是：

```cpp
std::optional<size_t> IndexGenerator::GetNext() {
  base::MutexGuard guard(&lock_);

  if (first_use_) {
    first_use_ = false;
    return 0;
  }

  if (ranges_to_split_.empty()) return std::nullopt;

  // Split the oldest running range in 2 and return the middle index
  // as starting point.
  auto range = ranges_to_split_.front();
  ranges_to_split_.pop();

  size_t size = range.second - range.first;
  size_t mid = range.first + size / 2;

  if (mid - range.first > 1)
    ranges_to_split_.emplace(range.first, mid);

  if (range.second - mid > 1)
    ranges_to_split_.emplace(mid, range.second);

  return mid;
}
```

第一次调用返回：

```text
0
```

之后不断把已有区间二分。

如果总共有 16 个 work items，多个 worker 的起点可能大致演化为：

```text
0
8
4
12
2
6
10
14
...
```

也就是说，`IndexGenerator` 并不是告诉 worker：

> “这些 pages 归你。”

它只是告诉 worker：

> “从这里尝试开始工作。”

这两个概念非常不同。

---

## 6. `TryAcquire()`：真正决定 page 属于谁

每一个 page 都绑定一个：

```cpp
ParallelWorkItem
```

其核心逻辑非常轻量：

```cpp
bool TryAcquire() {
  return reinterpret_cast<std::atomic<bool>*>(&acquire_)
             ->exchange(true, std::memory_order_relaxed) == false;
}
```

也就是说：

```text
false → true 成功
    │
    └── 这个 worker 获得该 page 的处理权

已经是 true
    │
    └── 其他 worker 已经获得该 page
```

于是：

```cpp
for (size_t i = *index; i < old_to_new_chunks_.size(); ++i) {
  auto& work_item = old_to_new_chunks_[i];

  if (!work_item.first.TryAcquire()) {
    break;
  }

  scavenger->ScavengePage(work_item.second);
}
```

产生了一个非常有意思的效果：

> 一个 worker 从某个起点开始，尽量连续向后吃掉一段 pages，直到撞上另一个 worker 已经认领的区域。

---

## 7. 这实际上是一种 lazy partitioning

假设一共有 16 个 pages。

第一个 worker：

```text
S0 starts at 0
```

然后不断向后：

```text
P0 → P1 → P2 → P3 → ...
```

第二个 worker 出现后，`IndexGenerator` 可能返回：

```text
8
```

于是：

```text
S0                        S1
↓                         ↓
P0 P1 P2 P3 P4 P5 P6 P7  P8 P9 P10 P11 P12 P13 P14 P15
```

但这并不是静态划分。

假设第三个 worker 随后加入，generator 返回：

```text
4
```

如果 S0 还没有处理到 P4，那么第三个 worker 可以率先：

```text
TryAcquire(P4) == true
```

接着：

```text
S2: P4 → P5 → P6 → P7
```

当 S0 最终到达 P4 时：

```text
TryAcquire(P4) == false
```

于是 S0 停止当前连续扫描。

此时实际形成：

```text
0--------4--------8----------------16
    S0       S2          S1
```

关键在于：

**这个 partition 并不是 GC 开始前算出来的。**

它是在 worker 真正出现、真正运行之后自然形成的。

因此，可以把这种策略理解为：

> **lazy partitioning：延迟决定每个 worker 的工作范围。**

这比“所有 worker 抢同一个中央队列”更粗粒度，又比“启动前固定切 N 份”更灵活。

---

## 8. 为什么这种设计特别适合 V8 的 Job 系统？

还有一个容易被忽略的事实：

> `Scavenger` 实例的数量，并不等价于某一时刻真正获得 CPU 执行的 worker 数量。

V8 的 Job 会动态计算期望并发度。

当前 `ScavengerJobTask::GetMaxConcurrency()` 大致会考虑：

```cpp
remaining_memory_chunks_
copied_list_.Size()
promoted_list_.Size()
worker_count
```

并且还会受：

```cpp
heap_->ShouldUseBackgroundThreads()
heap_->ShouldOptimizeForBattery()
```

等运行时条件影响。

换句话说，实际情况可能是：

```text
理论上准备了 8 个 scavenger
```

但某个时刻真正运行的可能只有：

```text
2 个 worker
```

之后可能变成：

```text
4 个 worker
```

或者在某种策略下始终只有：

```text
1 个 worker
```

如果 GC 开始前就做静态 ownership：

```text
S0 ← P0  ~ P9
S1 ← P10 ~ P19
...
S7 ← P70 ~ P79
```

那么一个很尴尬的问题就出现了：

> 如果 S7 很晚才真正得到调度，它负责的 P70~P79 是否也必须等它？

当然可以设计 stealing：

```text
如果 owner 没运行
    ↓
允许别人偷走它的 pages
```

但一旦这么做，系统本质上又回到了动态 ownership。

所以 V8 采取了更直接的原则：

> **不要在 GC 开始前把 page 与某个 Scavenger 实例永久绑定。**

`Scavenger` 是执行者。

page 是 work item。

二者的绑定只在真正执行时发生。

---

## 9. old-to-new page scanning 还会“生产”新的 GC 工作

这可能是整个设计里最值得注意的一点。

`ProcessItems()` 的结构是：

```cpp
void ScavengerCollector::JobTask::ProcessItems(
    JobDelegate* delegate,
    Scavenger* scavenger) {
  ConcurrentScavengePages(scavenger);
  scavenger->Process(delegate);
}
```

前半部分：

```text
ConcurrentScavengePages
```

处理 remembered slots。

但一个 old-to-new slot 可能第一次发现某个 live young object：

```text
Old object
    │
    ▼
Young object A
```

于是 A 可能被：

```text
copy
```

或：

```text
promote
```

并进入：

```text
copied_list
promoted_list
```

所以整个 workload 并不是：

```text
固定的一组 pages
```

而是：

```text
old-to-new pages
       │
       ▼
  ScavengePage
       │
       ├──────────────┐
       ▼              ▼
 copied objects   promoted objects
       │              │
       └──────┬───────┘
              ▼
      Scavenger::Process()
```

这意味着 GC 的工作量组成会随着执行过程动态变化：

```text
开始阶段：
page work 很多
object work 较少

        ↓

中间阶段：
page work 下降
copied/promoted work 增长

        ↓

后期：
page work 接近 0
主要剩下传递扫描
```

因此，从更高层看，`old_to_new_chunks_` 只是整个 Scavenger Job 的一个 work source。

静态地把这个 work source 切成 N 份，并不能静态地平衡整个 GC Job。

---

## 10. 为什么不提前根据 remembered-set 大小做 weighted partition？

进一步想，一个看似更聪明的方案是：

```text
weight(page) = remembered_slot_count(page)
```

然后 GC 开始前做一次 weighted partition：

```text
S0: total weight ≈ 1000
S1: total weight ≈ 1000
S2: total weight ≈ 1000
S3: total weight ≈ 1000
```

这理论上比简单按 page 数均分更好。

但它仍然有两个问题。

### 第一，slot 数量不是可靠的成本模型

例如：

```text
Page A:
1000 个 slots
但它们大量指向已经 forwarded 的对象
```

可能并不昂贵。

而：

```text
Page B:
只有 50 个 slots
但它们第一次发现许多仍然存活的 young objects
```

反而可能触发大量 copy/promotion。

remembered-set density 能提供一些信息，但远不足以准确预测 `ScavengePage()` 的墙钟时间。

### 第二，预测本身也有成本

为了获得更好的静态分配，需要：

```text
统计
  ↓
建模
  ↓
排序
  ↓
partition
  ↓
建立 worker → page ownership
```

这些工作本身也发生在 GC 敏感路径上。

而 dynamic claiming 有一个很有吸引力的特点：

```text
prediction cost ≈ 0
```

它让真实运行速度直接成为负载反馈。

快的 worker 多拿一点。

慢的 worker 少拿一点。

这是最直接的在线负载均衡。

---

## 11. 为什么 `TryAcquire()` 使用 relaxed atomic？

这段代码还有一个很漂亮的小细节：

```cpp
std::memory_order_relaxed
```

`remaining_memory_chunks_` 使用 relaxed load/fetch-sub。

`ParallelWorkItem::TryAcquire()` 也只需要 relaxed exchange。

原因在 `ParallelWorkItem` 的源码注释里说得非常明确：

> work item 自身的状态从 job 开始后并没有被修改；这里的原子操作只是用来获取“处理这个 work item 的权利”。

换句话说，这个 atomic 并不是在承担复杂的数据发布协议。

它主要回答：

```text
这个 page 是否已经有人负责？
```

而不是：

```text
这个 page 的内容是否已经安全发布给另一个线程？
```

因此这里的 synchronization metadata 非常薄。

这很重要，因为它意味着：

> V8 得到了动态 ownership 的好处，却没有为每个 page 引入重量级同步。

---

## 12. V8 的方案同时保留了一定的数据局部性

如果使用最朴素的全局动态队列：

```cpp
i = next.fetch_add(1);
```

不同 worker 的访问有可能频繁交错。

而当前方案中，一旦 worker 获得一个切入点：

```cpp
for (size_t i = start; ...; ++i)
```

它会尽量连续处理后面的 work items。

因此理想情况下更接近：

```text
S0: P0  P1  P2  P3
S1: P4  P5  P6  P7
S2: P8  P9  P10 P11
S3: P12 P13 P14 P15
```

而不是刻意形成：

```text
S0: P0 P4 P8  P12
S1: P1 P5 P9  P13
S2: P2 P6 P10 P14
S3: P3 P7 P11 P15
```

当然，V8 并没有保证严格的 NUMA 或 cache locality。

但算法的形态至少有一个明显倾向：

> **动态切分大区间，但在区间内部连续消费。**

所以它并不是最大化细粒度抢占，而是在：

```text
负载均衡
    +
较粗粒度连续处理
```

之间做折中。

---

## 13. `IndexGenerator` 和 `TryAcquire()` 分别解决什么问题？

这两个组件非常容易被看成重复设计。

实际上它们负责的是两个完全不同的问题。

### `IndexGenerator`

回答：

> **“新来的 worker 应该从哪里切进去？”**

它通过不断二分已有区间，让新的 worker 尽量进入当前较大的尚未完成区域，而不是全部从数组头开始竞争。

### `ParallelWorkItem::TryAcquire()`

回答：

> **“这个具体 page 最终由谁处理？”**

它提供真正的唯一 ownership。

二者组合起来是：

```text
             IndexGenerator
                   │
                   ▼
           找一个 starting point
                   │
                   ▼
      ┌────────────────────────┐
      │ 连续向后 TryAcquire()  │
      └────────────────────────┘
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
    acquire 成功            acquire 失败
       │                       │
 ScavengePage(page)       遇到其他 worker
       │                       │
       └──继续向后              └──停止当前 range
```

所以这个设计不是一个传统意义上的：

```text
global task queue
```

更像是：

```text
heuristic range splitting
        +
atomic ownership claiming
```

---

## 14. 为什么说这不是严格意义上的 “preemptive”？

如果用操作系统调度术语，**preemptive scheduling** 通常意味着：

> 一个正在运行的任务可以在尚未完成时被中断，CPU 被转交给另一个任务。

这里并没有发生这样的事情。

一旦某个 worker 成功：

```cpp
TryAcquire(page)
```

然后进入：

```cpp
ScavengePage(page)
```

其他 worker 不会从它手里“抢走”这个已经开始执行的 page。

所以更准确的术语是：

- dynamic work claiming；
- dynamic ownership；
- lazy partitioning；
- cooperative parallel work distribution。

如果要和静态方案做对比，更好的说法是：

```text
static / in-advance assignment
            vs.
dynamic claiming
```

而不是：

```text
non-preemptive
    vs.
preemptive
```

这一区分虽然只是术语，但有助于准确理解源码：

> **动态的是“尚未处理任务的归属”，而不是“正在执行任务的 CPU 所有权”。**

---

## 15. 一个完整的思维实验

假设有 16 个 pages，其真实工作量如下：

```text
Page: P0 P1 P2 P3 P4 P5 P6 P7 P8 P9 P10 P11 P12 P13 P14 P15
Cost:  1  1  1  1 20  1  1  1  1  1   1   1  15   1   1   1
```

### 静态四等分

```text
S0: P0-P3      cost = 4
S1: P4-P7      cost = 23
S2: P8-P11     cost = 4
S3: P12-P15    cost = 18
```

理论完成时间受：

```text
max(4, 23, 4, 18) = 23
```

控制。

大量 worker 会提前空闲。

### 动态认领

假设 S0 先从 0 开始，S1 从 8 开始，随后 S2 从 4 开始，S3 从 12 开始。

初始状态：

```text
0--------4--------8--------12-------16
S0       S2       S1       S3
```

S0 很快处理完 P0-P3 后，可以继续寻找其他尚未完成的区间。

与此同时，真正昂贵的 P4 和 P12 分别只拖慢 S2、S3 的当前进度，而不会永久锁住它们后面所有尚未开始的 pages。

最终边界根据实际执行速度形成。

这就是在线动态策略相对于静态 partition 最根本的优势：

> **静态 partition 根据“任务数量”猜测未来；动态 claiming 根据“真实完成速度”不断修正未来。**

---

## 16. 为什么这种设计特别适合 Garbage Collector？

把前面的讨论抽象一下，我们会发现 V8 面对的是一个非常典型的 GC workload：

### 工作单位可枚举

GC 开始时可以知道：

```text
哪些 old-space pages 有 old-to-new remembered sets
```

### 但工作单位成本不可预测

每个 page 的 remembered-set 密度、对象存活情况、forwarding 状态、promotion 情况都不同。

### 并发度也是动态资源

Job system 最终给多少 worker，会受到运行时条件影响。

### 工作执行还会产生更多工作

old-to-new slot 可以发现 copied/promoted objects。

### 尾延迟比平均吞吐更重要

因为最后一个 worker 决定 GC phase 何时真正完成。

这几项条件组合在一起，几乎天然指向：

```text
dynamic load balancing
```

而不是：

```text
static ownership
```

---

## 17. 为什么 V8 不直接上更复杂的 work stealing deque？

另一个方向是使用经典的 per-worker deque：

```text
Worker A local deque
Worker B local deque
Worker C local deque
...
```

worker 空闲时从别人的 deque steal。

这种方案在 fork-join runtime、task scheduler 和图遍历中非常常见。

但对这里的 page-level work 来说，它可能有些过度设计。

因为：

1. page work 本身在 GC 开始时已经能枚举出来；
2. 每个 page 只需要保证被处理一次；
3. 任务之间没有复杂依赖；
4. 只需要解决不规则成本与动态并发度；
5. V8 后面已经有 copied/promoted object worklist 体系。

所以：

```text
IndexGenerator
    +
ParallelWorkItem
```

已经足够提供良好的动态分区能力。

这是一个很典型的工程取舍：

> **不是寻找理论上最通用的调度器，而是为当前 workload 找到足够强、足够便宜的调度原语。**

---

## 18. 从这段代码能学到什么并发设计原则？

这段看起来只有十几行的代码，其实包含几个非常值得复用的设计原则。

### Principle 1：不要把“任务数量平均”误认为“工作量平均”

对于 irregular workload：

```text
N 个 task / M 个 worker
```

并不意味着：

```text
每个 worker N/M 个 task
```

就是平衡的。

真正应该平衡的是：

```text
execution cost
```

但 execution cost 往往只有运行之后才知道。

---

### Principle 2：当预测成本很高或不可靠时，让执行本身成为反馈

与其构造复杂 cost model：

```text
predict → partition → execute
```

不如：

```text
execute → faster worker claims more work
```

这是 online scheduling 的核心价值。

---

### Principle 3：动态负载均衡并不意味着必须细粒度抢任务

完全动态的 global queue 不是唯一选择。

V8 展示了一个非常实用的中间方案：

```text
动态选择起点
    +
连续处理一段任务
    +
碰到 ownership 边界再停止
```

这样既获得动态性，也避免每个 task 都经过重量级 scheduler。

---

### Principle 4：并发任务的 ownership 应该尽量晚绑定

如果实际 worker 数量也是动态的，那么：

```text
提前绑定 task → worker
```

会增加系统刚性。

更好的原则可能是：

> **只有当一个 worker 真正准备执行某项工作时，才决定 ownership。**

这正是 `TryAcquire()` 所做的事情。

---

### Principle 5：对 Stop-The-World 系统，要特别警惕 straggler

并行 GC 的性能不是：

```text
average(worker_time)
```

而更接近：

```text
max(worker_time)
```

因此，减少最后一个 straggler 的工作量，往往值得付出一些轻量的调度成本。

---

## 19. 回到最初的问题

现在再来看：

```cpp
void ScavengerCollector::JobTask::ConcurrentScavengePages(
    Scavenger* scavenger) {
  while (remaining_memory_chunks_.load(std::memory_order_relaxed) > 0) {
    std::optional<size_t> index = generator_.GetNext();
    if (!index) return;

    for (size_t i = *index; i < old_to_new_chunks_.size(); ++i) {
      auto& work_item = old_to_new_chunks_[i];

      if (!work_item.first.TryAcquire()) {
        break;
      }

      scavenger->ScavengePage(work_item.second);

      if (remaining_memory_chunks_.fetch_sub(
              1, std::memory_order_relaxed) <= 1) {
        return;
      }
    }
  }
}
```

它真正表达的并不是：

> “多个 scavenger 随机抢 page。”

而是：

```text
                old_to_new_chunks_

0----------------------------------------------------N
│
└── 第一个 worker 从 0 开始连续处理
                    │
                    └── 新 worker 从中间切入
             │
             └── 更多 worker 继续二分已有区间

每个 worker：
    从自己的 starting point 向后推进
                   │
                   ├── TryAcquire 成功 → 继续处理
                   │
                   └── TryAcquire 失败 → 已撞到其他 worker 的区域
```

最终得到的是：

> **动态形成、近似连续、无需预估 page 成本的工作分区。**

这是一种非常适合 GC 的 lazy partitioning。

---

## 20. Conclusion

如果必须把整篇文章压缩成一句话：

> **V8 没有提前把 old-to-new pages 平均分配给各个 Scavenger，是因为 page 数量不是工作量，而 Scavenge 的真正成本只有在运行时才能显现；动态 claiming 让更快的 worker 自然承担更多 work，从而减少 Stop-The-World GC 中最昂贵的东西——尾部负载不均衡。**

但 V8 也没有走到另一个极端，为每个 page 建立一个高频竞争的中央任务队列。

它通过：

```text
IndexGenerator
        +
ParallelWorkItem::TryAcquire()
        +
contiguous forward processing
```

实现了一种折中的调度方式：

```text
静态 partition 的低调度成本
          +
动态调度的负载均衡能力
```

而且它还有一个更深层的设计意味：

> **不要在信息不足时过早决定 ownership。**

GC 开始时，V8 知道哪些 pages 需要处理，却不知道：

- 哪个 page 最重；
- 哪个 worker 会先得到 CPU；
- 实际能够获得多少并发度；
- 哪些 slots 会触发 copy 或 promotion；
- 后续 copied/promoted work 会如何增长。

既然这些信息只有执行时才逐渐显现，那么最自然的方案，就是让任务边界也在执行时逐渐形成。

这就是这十几行代码最值得学习的地方。

它解决的表面问题是：

```text
How should V8 concurrently scavenge old-to-new pages?
```

背后的通用问题却是：

```text
When work is irregular and concurrency is dynamic,
when should ownership be decided?
```

V8 给出的答案是：

> **As late as possible — cheaply.**

---

## References

本文讨论基于 V8 Heap/Scavenger 相关源码。源码会持续演进，具体字段名和实现细节可能随版本调整，但本文讨论的调度结构在写作时的 V8 LKGR 中仍然存在。

1. **V8 `src/heap/scavenger.cc`**  
   https://chromium.googlesource.com/v8/v8.git/+/refs/heads/lkgr/src/heap/scavenger.cc

2. **V8 `src/heap/index-generator.cc`**  
   https://chromium.googlesource.com/v8/v8/+/ba560f5d8e251eb38261631ac76b8c92b2784eee/src/heap/index-generator.cc

3. **V8 `src/heap/parallel-work-item.h`**  
   https://chromium.googlesource.com/v8/v8/+/refs/heads/12.5.119/src/heap/parallel-work-item.h
