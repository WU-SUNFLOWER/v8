# Introduction to safepoint in V8

> 一份面向 V8 源码初学者的学习笔记：理解 `LocalHeap::Safepoint()` 的动机、调用时机、使用限制，以及它与 GC 和 Parking 的关系。
>
> **阅读说明**：本文以 V8 `main` 分支的源码接口为参考，核对时间为 **2026-11-01**。V8 内部实现可能随版本变化；文中标注为“示意代码”的片段用于解释机制，**不是可以直接复制到 V8 中编译的完整代码**。

## TL;DR：先记住四句话

1. **Safepoint 是线程与 GC 的协作点**：运行中的线程在这里检查并响应需要其配合的请求。
2. **不需要在每次读写或分配堆对象前调用** `LocalHeap::Safepoint()`；关键是让持续运行的堆访问线程**定期有机会**到达安全点。
3. **长时间不访问 V8 堆时，应考虑 Parking**：线程处于 `Parked` 状态便不能访问堆，但也不需要为了暂停 GC 而不断主动检查安全点。
4. **调用 Safepoint 并不等于主动发起一次 GC**：通常没有待处理请求就直接返回；不过，如果主线程已经收到集合请求，慢路径可能负责处理该请求并执行 GC。

---

## 一、为什么 V8 需要 Safepoint？

### 1.1 GC 和其他线程需要协调

现代 V8 的工作不只发生在执行 JavaScript 的主线程上。后台线程可能参与编译、堆对象处理等工作；与此同时，GC 也有并发阶段和需要暂停相关堆访问线程的阶段。

当 GC 需要一个稳定的堆视图、检查线程持有的根引用，或进行其他要求相关线程暂停的操作时，**不能让仍在访问堆的线程毫无约束地继续运行**。

设想以下过程：

```text
主线程 / GC                         后台线程
    |                                  |
    | 请求需要相关线程暂停的 GC         | 正在运行并访问 V8 堆
    |--------------------------------->|
    |                                  | 运行到 Safepoint()
    |                                  | 检查到暂停请求
    | <--------- 后台线程配合暂停 -------|
    |                                  | 等待
    | 执行需要安全点保护的 GC 工作       |
    |--------------------------------->| 收到恢复信号
    |                                  | 继续运行
```

如果后台线程长时间不响应请求，GC 就可能一直等待它到达可安全暂停的位置，导致停顿时间变长。

> **注意**：并非所有 GC 阶段都要求所有线程停止。例如，并发标记允许一部分回收工作与程序执行并行进行。这里讨论的是那些**确实需要协调或暂停堆访问线程**的阶段。

### 1.2 `LocalHeap`：记录线程是否能够访问堆

V8 通过 `LocalHeap` 跟踪相关线程的堆访问状态。其头文件对两种重要状态的描述可以归纳为：

| 状态 | 能否访问 V8 堆？ | GC 如何与之协调？ |
| --- | --- | --- |
| `Running` | 可以，但仍须遵守相应线程安全约束 | 线程需要定期检查安全点请求，并在必要时配合暂停 |
| `Parked` | **不可以** | 线程当前不访问堆，GC 无须等待它执行一次主动的 `Safepoint()` 调用 |

这里有个非常重要的区别：**`Parked` 并不表示操作系统线程已经睡眠**。它可以继续执行不访问 V8 堆的 C++ 计算或等待外部资源，只是向 GC 表明自己暂时不会触碰堆。

### 1.3 `Safepoint()` 如何完成检查？

下面摘取 `src/heap/local-heap.h` 中的核心逻辑，省略与本节无关的调试检查：

```cpp
void Safepoint() {
  DCHECK(AllowSafepoints::IsAllowed());

  // 省略部分编译选项下的额外检查。
  ThreadState current = state_.load_relaxed();

  if (V8_UNLIKELY(current.IsRunningWithSlowPathFlag())) {
    SafepointSlowPath();
  }
}
```

可以分成两条路径理解：

- **快路径**：没有需要处理的标志，调用很快返回，继续执行当前任务。
- **慢路径**：检测到相关请求，转入 `SafepointSlowPath()`；具体行为取决于线程身份和请求类型。

所以安全点不是“调用一次就停一次”，而是一个**低成本的、按需生效的协作检查点**。

---

## 二、哪些操作前需要考虑调用 `Safepoint()`？

### 2.1 先纠正“操作前必须调用”的理解

严格说，V8 **没有一个规则要求“执行某种堆操作前，必须先显式调用一次 `Safepoint()`”**。

真正的问题是：

> **这段代码会不会让一个处于 `Running` 状态、可能访问 V8 堆的线程，长时间都没有机会响应 GC 请求？**

如果答案是“会”，就应该检查是否需要在适当的位置增加 Safepoint，或者在不访问堆时改用 Parking。还要先确认调用链中是否**已经**包含安全点检查或其他 GC 协作机制。

### 2.2 常见场景速查

| 场景 | 建议 | 原因 |
| --- | --- | --- |
| 后台线程长时间循环遍历堆对象 | **定期提供安全点** | 避免线程长时间占据 `Running` 状态而不响应 GC |
| 后台线程连续分配大量堆对象 | **确保路径具有安全点/GC 协作机制** | 分配路径可能已有处理，通常不必逐次手写 `Safepoint()` |
| 后台编译或其他后台任务持续访问堆 | **定期提供安全点** | 需要及时响应主线程发出的暂停请求 |
| 长时间进行纯 CPU 运算，完全不访问堆 | **优先考虑 Parking** | 没必要一直以 `Running` 身份阻碍 GC |
| 等待互斥锁、条件变量等可能长时间阻塞的操作 | **考虑在不访问堆的等待阶段 Parking** | 阻塞期间无法主动调用 `Safepoint()` |
| 单次读取或修改对象字段 | **通常不需要逐次显式调用** | Safepoint 不是每次堆访问的许可检查 |
| 每次调用对象分配器 | **不能一概要求提前调用** | 具体分配器可能自行协调 GC；应分析调用路径 |

**“定期”没有统一的固定次数**。调用位置要综合考虑循环耗时、能否安全暂停、已有检查点和性能成本，不能把示例中的检查间隔当成 V8 规范。

---

## 三、具体例子

以下代码主要说明**何时检查安全点或进入 Parking**；`ProcessOneObject()`、`AllocateOneObject()` 等函数均为虚构的占位函数。真正修改 V8 时应遵守所在模块的 Handle、GC、线程和锁约束。

### 例子 1：后台线程长时间遍历堆对象

假设后台线程必须处理大量 V8 对象：

```cpp
// 示意代码：并非完整的 V8 可编译实现。
void ProcessManyObjects(LocalHeap* local_heap, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    if (i % 1000 == 0) {
      local_heap->Safepoint();
    }

    // 示例函数必须以 GC 安全、线程允许的方式访问对象。
    ProcessOneObject(i);
  }
}
```

**为什么？** 假如 GC 在处理过程中请求暂停，线程能在下一次安全点检查时发现请求，而不必等整个大循环结束。

**容易忽略的细节**：如果 GC 可能移动对象，不能因为调用了 `Safepoint()` 就继续盲目使用跨安全点保存的裸对象指针。应该根据具体 V8 版本和场景使用正确的 Handle / 根引用管理方案，必要时在安全点后重新取得对象引用。

### 例子 2：后台线程不断分配对象

```cpp
// 示意代码：具体分配器及其内部慢路径以实际源码为准。
void AllocateManyObjects(LocalHeap* local_heap, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    if (i % 1000 == 0) {
      local_heap->Safepoint();
    }

    AllocateOneObject(local_heap);
  }
}
```

连续分配可能带来内存压力，同时线程也需要响应来自其他位置的 GC 请求，因此**要确保长循环存在协作机会**。

但这并不意味着 `AllocateOneObject()` 每次调用前都必须额外调用 `Safepoint()`：V8 的一些分配路径会处理分配失败、GC 请求和重试等情况。是否需要外层显式检查，必须结合 `src/heap/heap-allocator.cc`、`src/heap/local-heap.cc` 等实际调用链判断。

### 例子 3：后台编译任务在“访问堆”和“纯计算”之间切换

有些后台任务的一部分需要读取堆对象，另一部分只使用已经取出的本地数据进行计算。可以从概念上这样分段：

```cpp
// 示意代码：省略了编译任务的真实数据结构与访问约束。
void CompileInBackground(LocalHeap* local_heap) {
  local_heap->Safepoint();
  ReadCompilationMetadataFromHeap();  // 此阶段允许访问堆

  local_heap->ExecuteWhileParked([&] {
    OptimizeUsingNativeDataOnly();    // 此阶段绝不访问 V8 堆
  });

  local_heap->Safepoint();
  PublishCompilationResultToHeap();   // 恢复 Running 后才访问堆
}
```

其中最值得关注的是 `ExecuteWhileParked()`：在纯计算阶段，线程可以继续用 CPU 干活，但无需保持允许访问堆的状态。如果需要 GC，处于 `Parked` 状态的线程不会因迟迟不调用 `Safepoint()` 而拖住它。

**注意**：实际后台编译实现可能为了避免线程安全问题而完全不在某些阶段访问 JavaScript 堆；以上仅用于说明“访问堆与纯计算应采用不同协作方式”，不代表 V8 某条编译管线的真实代码。

### 例子 4：等待互斥锁等阻塞操作

假设需要等一个外部资源，整个等待及处理阶段都**不访问 V8 堆**：

```cpp
// 示意代码：在 Parked 区间内只访问普通的非 V8 堆数据。
local_heap->ExecuteWhileParked([&] {
  WaitForExternalResource();
  ProcessNativeDataOnly();
});

// 返回后才恢复访问 V8 堆。
UseV8HeapAgain();
```

如果线程在 `Running` 状态下长时间阻塞，它就无法主动执行 `Safepoint()`；若同时收到需要它暂停的 GC 请求，可能使 GC 等待。Parking 则可以避免这一问题。

互斥锁场景还要特别检查**锁顺序与死锁风险**：不可简单地认为“获取锁时 Parked，拿到锁后立即 Unpark”总是安全。若 GC 线程也依赖该锁，错误的持锁与恢复顺序可能产生死锁。应遵守该模块已有的锁和 Parking 约定。

### 例子 5：并不是每次读写堆对象之前都要检查

下面这种写法通常没有必要：

```cpp
// 反例：不要机械地在每次普通堆访问前增加检查。
local_heap->Safepoint();
ReadObjectField();

local_heap->Safepoint();
WriteObjectField();
```

因为 `Safepoint()` **不是读写堆的授权器**；对象的并发读写安全、写屏障、GC 引用有效性等还需要另外的机制保证。

应当从**整个工作区间**考虑“有没有及时响应请求的机会”，而不是从每条读写语句考虑“是不是要先调用一下”。

---

## 四、什么时候不能随便调用 `Safepoint()`？

### 4.1 位于禁止安全点的作用域内

源码中 `LocalHeap::Safepoint()` 一开始就有：

```cpp
DCHECK(AllowSafepoints::IsAllowed());
```

在 `src/common/assert-scope.h` 中可以找到实际的 `DisallowSafepoints` / `AllowSafepoints` 作用域类型；不要将它们误写成不存在的 `DisallowSafepointsScope`。

```cpp
// 示意代码：名称参考当前源码，但业务函数是占位函数。
{
  DisallowSafepoints no_safepoints;
  UpdateInvariantSensitiveStructure();

  // 这里不应调用 local_heap->Safepoint();
}

// 离开禁止安全点的区域，并满足其他约束后再检查。
local_heap->Safepoint();
```

这种限制通常意味着当前代码在维护必须保持一致的内部状态，不能随意插入可能导致线程等待、让 GC 观察到中间状态的协作点。

### 4.2 持有不适合跨安全点等待的锁

如果线程持有某把锁进入安全点并等待 GC，而 GC 恰好也需要这把锁，就可能形成循环等待。

因此，**是否能在持锁期间调用 `Safepoint()` 要由具体锁协议决定**，不能只看它是不是处于循环中。

### 4.3 跨安全点继续使用可能失效的引用

安全点可能使线程等待某个 GC 阶段完成。若 GC 移动了对象，跨安全点缓存的裸指针或内部地址就可能失效。

实际代码需要使用符合当前模块约束的引用管理方式，例如适当的 Handle 或其他已经正确登记的 GC 根；不要把“到达安全点”误当成“保护了所有 C++ 局部指针”。

### 4.4 线程已经处于 `Parked` 状态

在 Parked 区间内，线程**不能访问 V8 堆**，也不应把手动调用 `Safepoint()` 当成维持 Parking 的手段。它应该通过相应接口恢复 `Running`，然后才可按约束访问堆。

> **添加安全点前的检查清单**
>
> - 当前确实是应由这个 `LocalHeap` 协调的线程吗？
> - 当前线程状态与调用约束是否正确？
> - `AllowSafepoints::IsAllowed()` 是否成立？
> - 有没有持有不允许在此处等待的锁？
> - 是否有跨安全点可能失效的裸指针或内部地址？
> - 调用链是否已包含检查点或 Parking？

---

## 五、`Safepoint()` 是检测协作点，不是 GC 触发器

这是最容易混淆的地方，值得单独记下来。

`Safepoint()` 的职责首先是**查看当前线程有没有需要处理的慢路径请求**，而不是告诉 V8：“现在请发起一次 GC。”

用简化伪代码表示：

```cpp
void LocalHeap::Safepoint() {
  if (HasPendingSafepointOrCollectionRequest()) {
    SafepointSlowPath();
  }
}
```

然而，“不是 GC 触发器”不应被理解为“它的执行路径绝对不会做 GC”。

根据 `src/heap/local-heap.cc` 中的 `SafepointSlowPath()`，**不同线程的处理方式不同**：

| 线程与请求 | 典型慢路径行为 |
| --- | --- |
| 后台线程收到 Safepoint 请求 | 配合暂停，等待安全点解除 |
| 主线程收到 Safepoint 请求 | 配合安全点等待 |
| 主线程收到 Collection 请求 | 可能进入 `heap_->PerformRequestedGC(this)`，处理**已经提出的** GC 请求 |
| 没有相关请求 | 不进入慢路径，直接继续执行 |

其中的关键区别是：

- **发起 GC 请求**：请求方认为有必要让某个线程执行 GC 或进入安全点。
- **检查并响应请求**：`Safepoint()` 给当前线程一个处理该请求的机会。
- **执行 GC**：依赖收到的请求、当前线程身份和具体慢路径；不是 `Safepoint()` 每次都主动发生的事情。

所以更严谨的一句话是：

> **`LocalHeap::Safepoint()` 的核心是检测并响应协作请求；它本身不意味着新发起 GC，但已有的 Collection 请求可能在其慢路径中得到处理。**

---

## 六、从源码入手，如何继续学习？

建议按“接口 → 线程状态转换 → GC 发起方 → 具体调用点”这个顺序阅读。

1. [`src/heap/local-heap.h`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/heap/local-heap.h)：先看类注释、`Safepoint()`、`ThreadState`、`ExecuteWhileParked()`。
2. [`src/heap/local-heap.cc`](https://github.com/v8/v8/blob/main/src/heap/local-heap.cc)：重点看 `SafepointSlowPath()`、`SleepInSafepoint()`、`ParkSlowPath()`、`UnparkSlowPath()`。
3. [`src/heap/safepoint.cc`](https://github.com/v8/v8/blob/main/src/heap/safepoint.cc)：关注如何设置暂停请求、等待 Running 线程进入安全点、解除等待。
4. [`src/common/assert-scope.h`](https://github.com/v8/v8/blob/main/src/common/assert-scope.h)：确认 `DisallowSafepoints` / `AllowSafepoints` 的定义。
5. [`src/heap/heap-allocator.cc`](https://github.com/v8/v8/blob/main/src/heap/heap-allocator.cc)：结合真实分配路径理解“分配、GC 请求与安全点”之间的关系。

在 V8 源码目录可以使用 `rg` 搜索相关调用点：

```bash
# 查看显式的 Safepoint() 调用点
rg -n '\bSafepoint\(\)' src/

# 查看 Parking 的使用方式
rg -n 'ExecuteWhileParked|ExecuteBackgroundThreadWhileParked' src/

# 查看慢路径和禁止安全点的作用域
rg -n 'SafepointSlowPath|DisallowSafepoints' src/
```

每找到一个调用点，可以按下面四个问题进行代码阅读：

1. **谁在调用？** 主线程还是后台线程？
2. **当前做什么？** 访问堆、纯计算，还是阻塞等待？
3. **为什么放在这里？** 循环边界、长任务之间，还是某个状态转换前后？
4. **可能有什么约束？** 是否持锁，是否禁止安全点，是否保留了可能失效的引用？

### 延伸阅读

- [V8 官方：Concurrent marking in V8](https://v8.dev/blog/concurrent-marking)——理解并发标记为何需要同步和写屏障。
- [V8 官方：Trash talk: the Orinoco garbage collector](https://v8.dev/blog/trash-talk)——从整体上理解 V8 垃圾回收器。
- [V8 官方：Background compilation](https://v8.dev/blog/background-compilation)——了解后台编译中的堆访问与线程安全问题；该文章描述的是其发表时的实现，细节不一定与当前源码完全一致。

---

## 七、复习卡片：一分钟回顾

| 问题 | 一句话答案 |
| --- | --- |
| 为什么需要 Safepoint？ | 需要让仍在运行并可访问堆的线程及时配合某些 GC 阶段。 |
| `Running` 与 `Parked` 最大区别？ | 前者可访问堆但需响应协作请求；后者不能访问堆，因此不必持续主动检查安全点。 |
| 是否每次读写或分配堆对象前都调用？ | **不是。** 要从长期运行的工作区间判断是否提供了足够的检查机会。 |
| 长时间纯计算时怎么办？ | 只要完全不访问 V8 堆，可考虑 `ExecuteWhileParked()`。 |
| 什么时候不能随便调用？ | 禁止安全点的作用域、危险持锁区间，以及引用安全性无法保证的位置。 |
| 每次调用都会触发 GC 吗？ | **不会。** 通常是检查请求；主线程的已有 Collection 请求可能在慢路径中被执行。 |

**最后记住：`Safepoint()` 不是“访问堆之前的许可检查”，而是“运行中的线程向 GC 提供的协作机会”。**
