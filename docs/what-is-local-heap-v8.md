你问到了 V8 源码里一个很容易让初学者困惑的概念：`LocalHeap` 虽然名字里有 `Heap`，但它并不是我们通常理解的那个存放 JavaScript 对象的堆。

先给你一个最重要的结论：

> `Heap` 负责管理 JavaScript 对象所在的堆内存，而 `LocalHeap` 主要负责管理某个线程如何安全地访问这块堆内存。

你可以把它们理解为：

- `Heap`：管理 JS 对象存储空间的“大管家”。
- `LocalHeap`：每个访问堆的线程所使用的“小助手”，负责协调对象分配、GC（垃圾回收）和线程状态。

这里的 `Local` 可以先理解为 Thread-local（线程局部的），而不是“局部的一块 JS 堆内存”。

下面结合你上传的 `local-heap.h` 源码来理解。

## 一、为什么 V8 需要 LocalHeap？

我们先考虑一个问题：

假设 V8 只有一个线程，那么事情比较简单。

1. JavaScript 代码创建对象。
2. V8 在 `Heap` 中为对象分配内存。
3. 内存不足时，V8 执行垃圾回收（GC）。

但是，现代 V8 内部并不只有一个线程。

除了执行 JavaScript 的主线程，V8 还可能使用后台线程完成编译、优化等工作。这些线程在某些情况下也需要访问堆中的对象，或者在堆中分配对象。

于是就出现了一个问题：

假如 GC 准备回收内存，而后台线程正在访问堆中的对象，怎么办？

GC 可能会移动或回收对象。如果不协调线程的访问，就可能发生错误。

所以 V8 引入了 `LocalHeap` 这样的机制，帮助 GC 跟踪和协调正在访问堆的线程。

简化的结构示意图

示意图仅表达概念：多个 LocalHeap 可以关联到同一个 Heap，它们本身不是三块独立的对象堆。

## 二、LocalHeap 最重要的功能：配合 GC

你上传的 `local-heap.h` 文件，第 32～40 行其实就已经说明了这个类最主要的设计目的：

> LocalHeap 用于让 GC 跟踪所有能够访问堆的线程，以便在垃圾回收前协调它们暂停访问。

`LocalHeap` 有两个非常重要的状态。

Running（运行状态）

表示这个线程被允许访问堆内存。

但是线程必须在合适的时候检查 GC 是否要求它暂停，以便 GC 可以安全进行。

Parked（停放状态）

表示线程暂时不访问 V8 的堆。

既然它不访问堆，GC 就不需要等待这个线程停下正在进行的堆操作。注意，Parked 不代表操作系统线程一定停止执行，它仍然可以做其他工作。

举个例子：

假设后台线程 A 正在通过自己的 `LocalHeap` 访问对象，此时主线程准备执行一次需要所有相关线程停止堆访问的 GC。

一次简化的 GC 协调过程

1. 主线程准备执行 GC，请求相关线程到达安全点。
2. 后台线程 A 在执行过程中调用 `LocalHeap::Safepoint()`，发现有暂停请求。
3. 后台线程 A 暂停访问堆，等待 GC。
4. GC 在满足安全条件后执行需要暂停线程的回收工作。
5. GC 完成相应工作后，后台线程 A 恢复堆访问。

这就对应了你源码中的：

```
void Safepoint() {
  DCHECK(AllowSafepoints::IsAllowed());
  ThreadState current = state_.load_relaxed();

  if (V8_UNLIKELY(current.IsRunningWithSlowPathFlag())) {
    SafepointSlowPath();
  }
}
```

初学阶段，你暂时不需要研究这里的原子操作和 `SlowPath` 细节。

只需要知道：

`Safepoint()` 是线程主动检查 GC 是否需要它配合暂停的一个入口。

另外，这里说的“暂停线程”，并不代表每一种 GC 都必须暂停所有线程。V8 也有并发执行的 GC 工作。

## 三、LocalHeap 除了配合 GC，还能做什么？

再看你上传的源码，有几个成员非常值得留意。

### 1. 关联真正的 Heap

```
Heap* heap_;
```

这是 `LocalHeap` 中非常关键的成员变量。

它保存了指向 `Heap` 的指针。

这说明 `LocalHeap` 并不是自己重新建立了一个独立的 JavaScript 堆，而是关联到一个已经存在的 `Heap`。

你还可以找到：

```
Heap* heap() const { return heap_; }
```

### 2. 帮助分配对象

你的源码中还有：

```
ConcurrentAllocator* old_space_allocator();
```

以及：

```
AllocationResult AllocateRaw(
    int size_in_bytes,
    AllocationType allocation,
    ...
);
```

它们说明 `LocalHeap` 不仅负责线程和 GC 的协调，还提供了与对象内存分配相关的能力。

例如，后台线程需要在老生代（Old Space）中分配对象时，可以使用相应的分配器。

这里有一个细节：

LocalHeap 可以管理线程使用的局部分配区域，但这些区域依然属于实际的 Heap，并不是另外一套独立的 JS 堆。

你可以将其理解为：仓库中的货物由总仓库管理，但是每名工作人员可以使用自己的工作区来加快操作。

### 3. 管理对象引用和写屏障

你还会看到：

```
std::unique_ptr<LocalHandles> handles_;
std::unique_ptr<PersistentHandles> persistent_handles_;
std::unique_ptr<MarkingBarrier> marking_barrier_;
```

这些成员大致对应：

| 成员                  | 初学阶段可以这样理解                   |
| ------------------- | ---------------------------- |
| `LocalHandles`      | 帮助当前线程安全地持有和使用 V8 对象的引用      |
| `PersistentHandles` | 管理需要跨越普通局部 Handle 生命周期的引用    |
| `MarkingBarrier`    | 当程序修改对象引用时，帮助 GC 保持正确的对象标记信息 |

暂时不需要深究这些类的实现。等你学习 V8 的 Handle 和垃圾回收算法时，再回来研究会更容易。

## 四、最后对比一下 Heap 和 LocalHeap

| 比较              | Heap             | LocalHeap              |
| --------------- | ---------------- | ---------------------- |
| 本质              | 堆内存的管理者          | 线程访问堆时使用的辅助管理对象        |
| 主要管理什么          | 对象内存、分配空间、GC 等   | 线程状态、局部分配、对象引用和 GC 协调  |
| 是否管理 JS 对象所在的内存 | 是                | 借助 Heap 分配，不拥有独立的 JS 堆 |
| 是否与线程关联         | 通常关联到 Isolate    | 与访问堆的线程关联              |
| 两者的关系           | 可以关联多个 LocalHeap | 持有指向 Heap 的指针          |

## 五、刚开始研究 V8，应该如何理解这段源码？

我建议你现在先建立下面三个认识：

1. `Heap` 才是研究 V8 对象内存布局的主要入口。 比如新生代、老生代、大对象空间，以及垃圾回收的实现。
2. `LocalHeap` 是研究 V8 多线程访问堆和 GC 协调的一个入口。 它解决了多线程环境下如何安全访问堆的问题。
3. `LocalHeap` 的名字容易误导人。 它更接近一个线程专属的堆访问上下文，而不是一个独立的堆。

如果你想继续沿着当前这份源码学习，我建议优先关注三个位置：

- `LocalHeap::Safepoint()`：理解 GC 怎么要求线程暂停。
- `LocalHeap::Park()` / `Unpark()`：理解线程什么时候可以访问堆。
- `Heap* heap_`：理解 LocalHeap 与真正的堆之间的关联。

等你理解了这三个位置，整个类的设计思路就会清晰很多。

另外，我对照了 [V8 官方最新分支的 local-heap.h](https://chromium.googlesource.com/v8/v8.git/+/refs/heads/main/src/heap/local-heap.h)。当前版本的部分分配器实现与这份文件已有差异，但 LocalHeap 的核心职责仍然相同。

[image](https://www.google.com/s2/favicons?domain=https://chromium.googlesource.com\&sz=32)

Git at Google

+1



最后用一句话记住：`Heap` 解决“对象存在哪里”，`LocalHeap` 主要解决“线程怎样安全地使用这些对象所在的堆”。