---
title: "Understanding V8 Garbage Collection: From Generations to Source Code"
date: 2026-10-20
description: "从 V8 源码出发，梳理 Minor/Major GC 与 Scavenge、Mark-Sweep、Mark-Compact 的关系，并分析新生代碎片、运行时开关、新生代晋升及老生代 Compaction 决策。"
tags: [V8, JavaScript, Garbage Collection, GC, 源码分析]
---

# Understanding V8 Garbage Collection: From Generations to Source Code

> **阅读定位**：本文不是 GC 算法百科，而是一份围绕 V8 真实源码组织的架构笔记。目标是弄清楚：**一次 GC 到底回收哪些对象、使用哪种算法、由谁决定，以及为什么 V8 要这样设计。**
>
> **源码范围**：2026-10-20 查阅的 [V8 主线 `refs/heads/main`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/)；以下函数名、默认 flag 值和启发式参数会随版本改变。文中的“常规配置”指启用分代、使用独立新生代空间的典型 V8 堆配置；单代模式、`sticky_mark_bits` 和特殊嵌入场景会有不同路径。

## 1. 先把概念放到正确的坐标系里

在很多文章里，Scavenge、Mark-Sweep、Mark-Compact、Minor GC、Major GC 被排成一个列表，仿佛它们是五种并列的回收器。**实际上它们属于两个维度**：

- **回收范围**：Minor GC 主要处理年轻代（Young Generation）；Major GC 则是覆盖老生代等可回收堆空间的全局回收，在常规分代堆中也处理年轻代。
- **回收算法**：Scavenge 是复制式回收；Mark-Sweep 是标记后清扫；Mark-Compact 在标记基础上通过移动存活对象来减少碎片。

对应到 V8 当前主要 Collector：

```text
                       V8 Garbage Collection
                                  |
                   +--------------+--------------+
                   |                             |
                Minor GC                      Major GC
             （年轻代 GC）                  （全局/完整 GC）
                   |                             |
          +--------+--------+                    |
          |                 |                    |
      SCAVENGER     MINOR_MARK_SWEEPER      MARK_COMPACTOR
          |                 |                    |
       Scavenge       Minor Mark-Sweep      Mark-Sweep-Compact
       Copying         Mark + Sweep        Mark + Sweep +
                                          按需 Evacuation
```

注意，**`MARK_COMPACTOR` 这个 Collector 名称并不意味着每次 Major GC 都要整理全部老生代 Page**；同样，**Mark-Sweep 也不是老生代的专属算法**，因为 V8 还实现了 Minor Mark-Sweep。

| 名词 | 属于哪个维度 | 主要含义 | V8 代码中的对应物 |
| --- | --- | --- | --- |
| Scavenge GC | 算法 / Collector | 复制年轻代存活对象，回收旧区域 | `ScavengerCollector` |
| Mark-Sweep GC | 算法 | 标记存活对象、清扫死亡对象；通常不搬迁存活对象 | `Sweeper` 及各 Collector 的标记/清扫阶段 |
| Mark-Compact GC | 算法/流程 | 标记后按需迁移存活对象，修复指针 | `MarkCompactCollector` 的整理流程 |
| Minor GC | 回收范围 | 年轻代 GC | `SCAVENGER` 或 `MINOR_MARK_SWEEPER` |
| Major GC | 回收范围 | 全局 GC，包含老生代的回收工作 | `MARK_COMPACTOR` |

### 1.1 两个最有价值的入口

`src/heap/heap.h` 中的 `Heap::YoungGenerationCollector()` 将年轻代回收器与 `v8_flags.minor_ms` 联系起来：

```cpp
// 根据源码含义整理的伪代码，而非逐行摘录
return minor_ms_enabled ? MINOR_MARK_SWEEPER : SCAVENGER;
```

`src/heap/heap.cc` 的 `Heap::SelectGarbageCollector()` 则负责**选择**：请求全局回收、Major Incremental Marking 需要完成、老生代容纳晋升对象的能力不足等情况，会让 V8 选择 `MARK_COMPACTOR`；否则，普通年轻代分配压力一般走 `YoungGenerationCollector()`。

选定之后，`Heap::PerformGarbageCollection()` 再负责**分派**到 `Heap::Scavenge()`、`Heap::MinorMarkSweep()` 或 `Heap::MarkCompact()`。因此，不要把“从 NEW_SPACE 触发了 GC”理解为“最后必定执行 Minor GC”。

> **复习锚点**：`SelectGarbageCollector()` 决定**做哪类回收**；具体 Collector 决定**怎样回收**。

## 2. 默认的 Minor GC：为什么 Scavenge 适合年轻代？

分代 GC 的基础是假设：大部分对象很快死亡，而少数对象长期存活。对于通常存活率较低的年轻代，复制式回收很有吸引力：**不需要为每个死亡对象建立空闲块，只复制仍然存活的对象**。

经典 Semi-Space 模型可以简化为：

```text
GC 前：
  使用中的半空间： [ A 活 ][ B 死 ][ C 活 ][ D 死 ]
  目标半空间：   [                  空                 ]

Scavenge：追踪存活对象，并复制/晋升

GC 后：
  新的使用空间： [ A 活 ][ C 活 ][        剩余空闲      ]
  旧的使用空间： [                 可整体复用          ]
```

V8 使用 `SemiSpaceNewSpace` 时，普通对象分配主要依赖 **Bump-Pointer**：在 Linear Allocation Buffer（LAB）中推进 `top` 指针，开销低。Scavenge 后存活对象被紧凑地复制到目标空间，或晋升到老生代，不需要像普通 Mark-Sweep 那样管理大量离散的死亡对象空洞。

但复制式 GC 也有成本：存活对象需要搬迁，指向这些对象的引用需要修复。年轻代中来自老生代的引用由 Write Barrier / Remembered Set 等机制辅助维护，避免每次 Minor GC 都完整遍历老生代。

**Scavenge 不等于 Minor GC**：Scavenge 只是 V8 常规默认的 Minor Collector。

## 3. 核心疑问一：年轻代没有 Free List，为什么还能运行 Mark-Sweep？

这是理解 V8 实现边界时最容易被忽略的地方。问题中的“没有 Free List”**只适用于经典的 Semi-Space 新生代模型**，不适用于 V8 为 Minor Mark-Sweep 准备的另一种空间布局。

### 3.1 `minor_ms` 不只切换算法，也切换空间结构

在 `Heap::SetUpSpaces()`（`src/heap/heap.cc`）中，常规分代配置的分支逻辑可以概括为：

```cpp
// 为了突出结构而改写的简化伪代码
if (minor_ms_enabled) {
  new_space = PagedNewSpace(...);
} else {
  new_space = SemiSpaceNewSpace(...);
}
```

也就是说：

| | 默认 Scavenger | 可选 Minor Mark-Sweep |
| --- | --- | --- |
| 年轻代空间布局 | `SemiSpaceNewSpace` | `PagedNewSpace` |
| 回收对象的方式 | 将存活对象复制到新位置 | 标记后清扫，通常让存活对象留在原位 |
| 离散空闲区间 | 不作为常规分配模型的核心 | 可以存在 |
| Free List | 非普通年轻代对象的主要管理方式 | **需要且确实使用** |
| 分配路径 | LAB 内 Bump-Pointer | **LAB 内 Bump-Pointer + LAB 耗尽时从 Free List 补充** |
| 典型代价 | 存活对象复制及引用更新 | 碎片化与 Free List 管理成本 |

### 3.2 真实源码：Paged New Space 可以从 Free List 分配

看 `src/heap/main-allocator.cc`：

- `PagedNewSpaceAllocatorPolicy::EnsureAllocation()` 委托页式分配策略准备 LAB；
- `PagedNewSpaceAllocatorPolicy::TryAllocatePage()` 新增 Page 后尝试 `TryAllocationFromFreeList()`；
- `PagedSpaceAllocatorPolicy::RefillLab()` 也会优先尝试扩展 LAB、从 Free List 获取连续区间，必要时等待或协助 Sweeping。

所以 **Bump-Pointer 和 Free List 不是二选一**。对象分配的快速路径仍然可以是 `top += size`；只是在 LAB 用尽时，由 Free List 为它补充下一个连续区间。

假设某个 Page 在一次 Minor Mark-Sweep 前是：

```text
[ A 活 ][ B 死 ][ C 活 ][ D 死 ][ E 死 ][ F 活 ]
```

清扫后可能成为：

```text
[ A 活 ][   free  ][ C 活 ][     free     ][ F 活 ]
                 \_________ Free List _________/
```

这显然会产生外部碎片。**V8 并不是“不怕碎片”，而是容许碎片、管理碎片，并用减少复制开销的收益与之权衡。** 当某个 Page 满足一定的存活情况和晋升条件时，Minor MS 还可以采取 Page Promotion，直接改变整个 Page 的代际归属，避免逐对象复制。晋升包含死亡对象的 Page 时，后续仍需按标记结果回收其中的无效对象。

这里应当区分两个目标：

1. **保证分配正确性**：Free List 能让分配器重用离散空闲区间。
2. **提高空间利用率**：碎片仍可能导致浪费，甚至无法满足某次较大的连续分配请求；Free List 本身不会自动消除碎片。

因此，对第一个问题最准确的回答是：**V8 不是在没有 Free List 的 Semi-Space 上硬跑 Mark-Sweep，而是用 `PagedNewSpace` 配合 Free List 改变了年轻代的分配约束。**

## 4. 核心疑问二：`minor_ms` 在 Chromium、Electron、Node.js 中默认开启了吗？

### 4.1 先区分“V8 默认值”与“最终产品有效配置”

`src/flags/flag-definitions.h` 将 `minor_ms` 定义为 `DEFINE_EXPERIMENTAL_FEATURE`。这个宏在主线中为实验功能指定 `false` 默认值，因此：

- **V8 主线默认值**：`minor_ms = false`，即默认选择 Scavenger。
- **源码支持**：Minor Mark-Sweep 仍然存在，可以在支持相应 flag 的构建中显式启用。
- **具体产品的实际行为**：还受到嵌入层、编译选项、命令行参数、运行环境以及其他 flag 蕴含关系的影响。

尤其要留意 `cppgc_young_generation`、`sticky_mark_bits` 等条件可能隐含启用 Minor MS；其中 `sticky_mark_bits` 还对应一种特殊的空间/代际表示，不能机械套用上文 `PagedNewSpace` 与 `SemiSpaceNewSpace` 的二分图。

### 4.2 如何理解 Chromium、Electron 和 Node.js？

| 运行环境 | 就普通默认配置而言 | 严谨的说法 |
| --- | --- | --- |
| Chromium / Chrome | 通常沿用默认 Scavenger | 不应仅凭 V8 源码推断任意平台、任意发布渠道的最终有效 flag |
| Electron | 通常继承其 Chromium/V8 集成配置 | 需要按 Electron 版本和启动参数核验 |
| Node.js | 官方常规配置通常使用 Scavenger | 可检查具体 Node 二进制中的 V8 选项及 GC 日志 |

**截至本文核对的 V8 主线代码，Minor Mark-Sweep 依旧被标为实验性且默认关闭。** 这并不构成对所有 Chrome / Electron / Node 版本和构建产物的逐一验证；如果分析生产环境，应以该版本的实际运行参数和 GC 日志为准。

Node.js 可先检查：

```bash
node --v8-options | grep -i minor-ms
node --trace-gc app.js
```

使用支持该选项的构建进行对照实验：

```bash
node --minor-ms --trace-gc app.js
```

`--v8-options` 帮助确认该构建暴露的选项及默认值；`--trace-gc` 帮助观察真正发生的 GC 类型。测试程序要有足够的新对象分配，否则日志中不一定能看到年轻代回收。

> **复习锚点**：`experimental` 是 V8 源码对功能成熟度的描述；“产品是否采用”是具体构建和启动配置问题。二者不能直接画等号。

## 5. 核心疑问三：Major GC 会如何处置年轻代死亡对象？

一个常见但错误的想法是：Major GC 只处理老生代，年轻代垃圾要留到下一次 Minor GC。

在典型分代配置下，**Major GC 会对包括年轻代在内的可回收对象图进行标记；死亡的年轻代对象被回收，存活对象则晋升到老生代，最后新生代的已用大小归零。**

### 5.1 从 `MarkCompactCollector::CollectGarbage()` 看全流程

在 `src/heap/mark-compact.cc` 中，主要流程是：

```text
MarkLiveObjects()
       |
       v
处理弱引用 / 清理不可达引用
       |
       v
Sweep()
       |
       v
Evacuate()
       |
       v
Finish()
```

这里的 `Sweep()` 和 `Evacuate()` 不是两个互斥的 Collector，而是同一次 Major GC 的不同阶段；某些清扫工作可以在并发线程上延续。

例如：

```text
Root ---> Old A ---> Young B（可达）

                 Young C（不可达）
```

Major Marking 会把 A、B 标成存活；C 不会因为“还很年轻”就得到豁免。后续通过复制存活对象、清扫或整页处理等路径回收内存。

### 5.2 `EvacuatePrologue()` 和 `EvacuateEpilogue()` 是两处关键证据

`MarkCompactCollector::EvacuatePrologue()` 会把 **`live_bytes() > 0`** 的年轻代 Page 加入后续 Evacuation 处理名单。也就是说，完全没有存活对象的 Page 没有必要逐对象搬迁。

之后的 Evacuator 区分三种主要模式：

| Evacuation Mode | 含义 | 处理方式 |
| --- | --- | --- |
| `kObjectsNewToOld` | 年轻代对象晋升到老生代 | 只搬迁被标记的存活对象，死亡对象留在可回收源区 |
| `kPageNewToOld` | 年轻代整个 Page 晋升 | 调整 Page 归属；死亡对象占的空间仍需在老生代清扫 |
| `kObjectsOldToOld` | 老生代对象整理 | 将候选 Page 上的存活对象搬到其他位置 |

在 `MarkCompactCollector::EvacuateEpilogue()` 中还有一条尤其直观的断言：

```cpp
DCHECK_EQ(0, heap_->new_space()->Size());
```

这说明：**在该常规实现路径里，Major GC 的 Evacuation 完成后，V8 预期年轻代已经没有已分配对象。** 新生代空间本身不等于被销毁，它仍可供后续年轻代分配使用。

年轻代大对象空间 `NEW_LO_SPACE` 也有相应处理：存活的大对象可通过 Page Promotion 进入老生代大对象空间；死亡对象对应的空间可以释放。

### 5.3 Minor MS 模式下也一样吗？

整体目标一样，但细节不同。

`PagedNewSpace` 下，`MarkCompactCollector::StartSweepNewSpace()` 会优先识别 `live_bytes() == 0` 的空 Page：按当前容量策略释放，或保留为空 Page；非空 Page 则留待 Evacuation / Promotion。它并不是“做一次普通的 Minor Sweep，再让存活对象继续留在年轻代”。

还要注意：**禁止老生代 Compaction，不等于禁止年轻代对象的晋升。** 即便没有任何老生代 Page 被选为 Evacuation Candidate，Major GC 仍必须保证年轻代对象的正确处置。

## 6. 核心疑问四：Major GC 到底如何决定要不要 Compact？

这部分最重要的时间顺序是：

> **先选候选 Page，再进行本轮标记，最后在 Evacuation 阶段真正搬迁。**
>
> 不是“等本轮 Sweep 完毕，再临时决定是否 Compact”。

V8 需要提前知道哪些老生代 Page 将被整理，以便在标记和写屏障相关阶段维护后续修复指针所需的信息。

### 6.1 第一关：本轮是否允许整理？

入口是 `MarkCompactCollector::StartCompaction()`，它会检查：

- `--compact` 是否启用，或当前是否处于不允许整理的特殊状态；
- 是否允许常规 GC 的整理，或是否进入节省内存、压力测试等特殊模式；
- 栈扫描、受固定限制的对象以及 Code Space 的约束。

当前主线部分相关默认 flag 为：

```text
compact                       = true
compaction_on_regular_gcs     = true
compact_on_every_full_gc      = false
```

因此，**V8 默认允许每次常规 Major GC 评估 Compaction，但并不要求每次都整理。**

### 6.2 第二关：哪些 Page 值得整理？

核心是 `MarkCompactCollector::CollectEvacuationCandidates()`，它先排除不能移动或不能分配的 Page，再应用碎片和搬迁预算相关启发式。

标准路径大致可写成以下伪代码：

```cpp
// 伪代码：说明判定逻辑，不代表完整源码
for (Page* page : pages) {
  size_t free_bytes = page->area_size() - page->allocated_bytes();
  if (free_bytes >= fragmentation_threshold) {
    candidates.push_back(page);
  }
}

sort(candidates, by_allocated_bytes_ascending);
select_candidates_under_evacuation_budget();
```

**这里是一个很容易读错的源码细节：候选选择发生在本轮 Marking 开始附近，依据的是当时的 `allocated_bytes()` 等已有空间统计，而不是等本轮 Mark 完再使用本轮最终的 `live_bytes()` 重新选页。** 源码中的局部变量名 `LiveBytesPagePair` 也不应掩盖实际读取的字段。

排序后会优先考虑已有空闲比例更高、预计需搬迁字节数更少的 Page。这样可能以较小的搬迁工作量释放更多完整 Page。

### 6.3 第三关：预估收益能否抵过搬迁成本？

在正常启发式下，V8 限制累计需要搬迁的对象字节数，还会评估候选 Page 整理后能否释放完整 Page。

用容量为 `A` 的 Page 作为简化模型：

```text
预计需要的新 Page 数 = ceil(候选 Page 已分配字节总量 / A)
预计可释放 Page 数  = 候选 Page 数 - 预计需要的新 Page 数
```

如果预计连一个完整 Page 也释放不了，并且没有开启强制整理选项，V8 可以放弃当前这组候选 Page，以避免“刚整理完又不得不扩容”的低收益循环。

要注意，这是一项**启发式估计**，而非最终一定释放这些 Page 的承诺。真正搬迁时还可能遇到无法移动的对象、空间约束或其他导致 Evacuation 放弃的条件。

### 6.4 第四关：GC 当前偏向延迟，还是偏向内存占用？

`ComputeEvacuationHeuristics()` 会根据 GC 模式设置碎片目标和搬迁字节预算。**截至本文查阅的 V8 主线默认参数**如下：

| 模式 | 碎片比例阈值（作为启发式目标） | 搬迁字节预算 |
| --- | ---: | ---: |
| 常规 Major GC | 初始 70%，具备历史速度样本后可动态调整 | 4 MiB |
| `ShouldOptimizeForMemoryUsage()` | 20% | 6 MiB |
| `ShouldReduceMemory()` | 20% | 12 MiB |

常规模式还会参考历史的 `CompactionSpeedInBytesPerMillisecond()`，估算整理一个 Page 的时间成本，适当调整碎片阈值。即使 Page 存在一些空闲区域，搬动很多对象却只能收回很少内存，也未必值得整理。

所以，**Compact 的选择本质上是一项“预计可回收空间 vs. 搬迁成本与暂停风险”的权衡**，并非一个孤立的“碎片率超过 X%”判断。

### 6.5 候选选择与执行之间的时序

```text
Major GC 开始（原子式 / 增量式）
       |
       v
StartCompaction()
       | 允许整理？
       v
CollectEvacuationCandidates()
       | 根据已有 Page 空闲情况与预算提前选页
       v
StartMarking() / MarkLiveObjects()
       | 处理存活对象、弱引用等
       v
Sweep()
       | 部分扫除可并发延续
       v
Evacuate()
       | 搬迁被选中 Page 的存活对象 + 年轻代晋升
       | 修复指针与相关元数据
       v
Finish()
```

对于原子式回收，可以沿着 `MarkCompactCollector::Prepare()` 找到 Compaction 候选选择与 Marking 初始化的先后顺序；对增量式回收，则进一步查看 `IncrementalMarking::StartMarkingMajor()`。

> **复习锚点**：`MARK_COMPACTOR` 是 Major GC 的 Collector 类型；`compacting_` 与候选 Page 集合才更接近“这一轮是否真的需要移动老生代对象”的答案。

## 7. 把四个问题放回同一张架构图

```text
对象分配（年轻代）
      |
      +--> 默认：SemiSpaceNewSpace
      |          LAB / Bump-Pointer
      |          |
      |          +--> Minor GC = Scavenge
      |                     复制存活对象 / 晋升 / 整块回收
      |
      +--> --minor-ms：PagedNewSpace（实验性）
                 LAB / Bump-Pointer + Free List
                 |
                 +--> Minor GC = Minor Mark-Sweep
                            标记 / 清扫 / 可选整页晋升

        老生代压力 / 全局 GC 请求 / Major 标记完成等
                             |
                             v
                       Major GC
                    MarkCompactCollector
                             |
             +---------------+----------------+
             |                                |
     全局标记并处理年轻代                  选择老生代候选 Page
     死亡对象回收、存活对象晋升            不一定选中任何 Page
             |                                |
             +---------------+----------------+
                             |
                    Sweep / Evacuate
                             |
                   视需要修复搬迁后引用
```

由此可以得到三个比记忆术语更有价值的认识：

1. **空间布局与 Collector 要配套设计。** Scavenge 和 Minor Mark-Sweep 的差异，不只是 `switch` 到了另一个算法，背后还有 `SemiSpaceNewSpace` 与 `PagedNewSpace` 的区别。
2. **回收范围与对象移动是正交维度。** Major GC 会处理年轻代，即使没有老生代整理；Minor Mark-Sweep 也可以在不逐个搬迁存活对象的情况下完成回收。
3. **V8 的 Compaction 是成本模型驱动的选择性工作。** 提前筛选 Evacuation Candidate，以有限的搬迁成本换取 Page 回收收益，是默认策略的核心。

## 8. 源码阅读路线与实验命令

建议按照“调度 → 空间布局 → 分配器 → 回收实现 → 整理决策”的顺序读，而不是直接钻进 `mark-compact.cc` 的所有细节。

| 阅读顺序 | 文件 / 入口 | 要回答的问题 |
| --- | --- | --- |
| 1 | `heap.h`：`YoungGenerationCollector()` | 为什么 Minor GC 有两种实现？ |
| 2 | `heap.cc`：`SelectGarbageCollector()`、`PerformGarbageCollection()` | 一次 GC 如何选型、如何分派？ |
| 3 | `heap.cc`：`SetUpSpaces()` | `minor_ms` 怎样改变年轻代布局？ |
| 4 | `main-allocator.cc`：`PagedNewSpaceAllocatorPolicy` | LAB 与 Free List 如何协作？ |
| 5 | `scavenger.cc`、`minor-mark-sweep.cc` | 两种年轻代回收器分别怎样清理对象？ |
| 6 | `mark-compact.cc`：`CollectGarbage()`、`EvacuatePrologue()`、`EvacuateEpilogue()` | Major GC 怎样包含年轻代？ |
| 7 | `mark-compact.cc`：`StartCompaction()`、`CollectEvacuationCandidates()` | 为什么只整理一部分 Page？ |
| 8 | `flag-definitions.h` | 哪些行为是默认的，哪些是实验性的？ |

在支持相应选项的 `d8` 上，可用下列命令观察：

```bash
# 默认 Collector 行为
d8 --trace-gc test.js

# 实验性年轻代 Mark-Sweep（仅用于研究/测试）
d8 --minor-ms --trace-gc test.js

# 观察老生代候选页、碎片与迁移信息
d8 --trace-gc --trace-fragmentation \
   --trace-fragmentation-verbose --trace-evacuation test.js

# 验证“不整理老生代”与“仍执行 Major GC”并不矛盾
d8 --no-compact --trace-gc test.js
```

不同版本或构建可能不包含某些诊断 flag；先查看 `d8 --help`、`d8 --v8-options` 或对应 Node.js 的 `--v8-options`。尤其不要因为输出了一条 `Mark-Compact` 日志，就推断本轮必定发生了大量 Old-to-Old 搬迁：日志名称通常描述 Collector 类型，而不是完整的 Page 迁移明细。

## 9. 一页复习卡

| 问题 | 记住这一句话 | 关键源码 |
| --- | --- | --- |
| Scavenge、Mark-Sweep、Mark-Compact 与 Minor/Major 的关系？ | 前三个是算法/流程，后两个是回收范围；V8 用 Collector 将它们组合起来。 | `Heap::YoungGenerationCollector()` |
| 为什么年轻代能运行 Mark-Sweep？ | 因为 Minor MS 使用 `PagedNewSpace`，并通过 Free List 管理清扫后的离散空闲区间。 | `Heap::SetUpSpaces()`、`PagedNewSpaceAllocatorPolicy` |
| `minor_ms` 默认开了吗？ | V8 主线仍为实验性、默认 `false`；产品最终行为需检查实际构建。 | `flag-definitions.h` |
| Major GC 会跳过年轻代吗？ | 不会；常规分代堆中的 Major GC 会回收年轻代死亡对象并晋升存活对象。 | `EvacuatePrologue()`、`EvacuateEpilogue()` |
| 老生代每次 Major GC 都 Compact 吗？ | 不一定；先根据已有碎片统计、搬迁预算和预计释放 Page 数选候选页。 | `StartCompaction()`、`CollectEvacuationCandidates()` |
| 何时决定 Compact？ | 通常在本轮 Marking 开始时确定候选页，之后才实际搬迁。 | `Prepare()`、`StartMarkingMajor()` |

最后可以用一句话记住整篇文章的主线：

> **Minor/Major 决定“回收谁”，Scavenge/Mark-Sweep/Mark-Compact 决定“怎么回收”；空间结构决定算法能否高效落地，Evacuation 及其启发式决定移动对象值不值得。**

---

## 参考源码与资料

以下链接使用 V8 主线地址，方便跳转和检索；如需在数月或数年后复现同样行为，建议在本地 `git rev-parse HEAD` 记录所使用的提交哈希，再将链接替换为相应的固定 commit permalink。

1. [V8：`src/heap/heap.h`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/heap/heap.h) — `YoungGenerationCollector()` 与 Collector 分类。
2. [V8：`src/heap/heap.cc`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/heap/heap.cc) — `SelectGarbageCollector()`、`PerformGarbageCollection()`、`SetUpSpaces()`。
3. [V8：`src/heap/main-allocator.cc`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/heap/main-allocator.cc) — `PagedNewSpaceAllocatorPolicy`、LAB 与 Free List。
4. [V8：`src/heap/scavenger.cc`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/heap/scavenger.cc) — Scavenge 实现。
5. [V8：`src/heap/minor-mark-sweep.cc`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/heap/minor-mark-sweep.cc) — Minor Mark-Sweep 实现。
6. [V8：`src/heap/mark-compact.cc`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/heap/mark-compact.cc) — Major GC、Evacuation、Compaction 候选选择。
7. [V8：`src/flags/flag-definitions.h`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/flags/flag-definitions.h) — `minor_ms`、`compact`、碎片与迁移预算 flags。
8. [V8：Garbage Collection in V8](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/docs/heap/garbage-collection.md) — 官方架构说明。
9. [V8：Heap Compaction in V8](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/docs/heap/compaction.md) — 官方整理流程说明。
