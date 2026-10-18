# The basic mental model of V8 job task scheduling mechanism

> **阅读目标**：建立一个足够实用的 V8 JobTask 调度心智模型，而不是逐行推演锁、条件变量和线程池实现。以后阅读 GC、并行编译等源码时，能够分辨「业务工作怎样拆分」「谁决定并发需求」「谁负责调度线程」「如何等待整个阶段完成」。
>
> **讨论范围**：以 V8 的 `Platform` / `JobTask` 公共接口，以及 `src/libplatform/default-job.{h,cc}` 中的默认实现为例。不同 V8 版本及 Embedder 的调度实现可能有差异；文末列出可直接追踪的源码入口。

## 1. 先建立全景：业务层描述工作，调度层组织执行

V8 的垃圾回收（GC）、编译等流程，常会遇到可以拆成多个独立工作单元的阶段。与其为每个工作单元分别创建一个线程，不如把一整组可并行处理的工作封装成一个 **Job**，交由平台调度。

这里有四个角色：

| 角色 | 主要职责 | 关键源码入口 |
| --- | --- | --- |
| **`JobTask`** | 业务层提供可并行执行的工作逻辑，并告知当前最大并发需求 | `JobTask::Run()`、`JobTask::GetMaxConcurrency()` |
| **`JobHandle`** | 调用方持有的控制入口：通知并发度增加、`Join()`、取消任务等 | `JobHandle::NotifyConcurrencyIncrease()`、`JobHandle::Join()` |
| **`DefaultJobState`** | 默认调度实现的状态管理中心：跟踪执行名额、补充或释放 Worker、协调收尾 | `DefaultJobState::NotifyConcurrencyIncrease()`、`DidRunTask()`、`Join()` |
| **`DefaultJobWorker` / `JobDelegate`** | 前者在后台线程执行 `Run()`；后者向执行中的任务提供与调度器协作的接口 | `DefaultJobWorker::Run()`、`JobDelegate::ShouldYield()` |

可以把它们想成下面的关系：

```text
  V8 业务层（GC / Compile 等）
      │
      ├── 定义 JobTask
      │     ├── Run()：如何领取并处理工作单元
      │     └── GetMaxConcurrency()：当前需要多大并发能力
      │
      └── 通过 Platform 创建 / 提交 Job，取得 JobHandle
                                  │
                                  ▼
                    DefaultJobState（调度状态）
                      ├── 追踪活跃执行名额
                      ├── 计算还需提交多少 Worker
                      └── 协调执行、退出与 Join
                                  │
                    ┌─────────────┴────────────┐
                    ▼                          ▼
              后台 Worker                 Join 调用线程
              执行 Run()              可能等待，也可能执行 Run()
```

**一句话记忆：`JobTask` 决定“做什么、能并行多少”，`JobState` 决定“安排谁来做”，`Join()` 负责“参与并等待收尾”。**

需要区分 **V8 主线程** 与 **调用 `Join()` 的线程**：如果 `Join()` 是在 JavaScript 所在的主线程上调用的，该主线程就可能加入执行；但接口并不要求 `Join()` 必须由 JS 主线程调用。`JobTask` 也不一定只用于纯计算密集型任务。

## 2. `JobTask` 不是一个工作项，而是一套可被反复调用的工作入口

`JobTask` 最重要的两个接口是：

```cpp
class JobTask {
 public:
  virtual void Run(JobDelegate* delegate) = 0;
  virtual size_t GetMaxConcurrency(size_t worker_count) const = 0;
};
```

一个 `JobTask` 可以代表一批工作，而不是恰好一个工作项。不同线程可以**并发调用同一个 `JobTask` 的 `Run()`**，同一个线程也可能多次调用 `Run()`。因此，业务层需要自行提供线程安全的工作领取机制，例如共享队列、原子索引或分片数据结构。

以下是说明职责的**伪代码**，并非某个 V8 GC JobTask 的原样实现：

```cpp
void MyJobTask::Run(JobDelegate* delegate) {
  while (!delegate->ShouldYield()) {
    auto item = TryClaimNextWorkItem();  // 线程安全地领取工作
    if (!item) return;

    Process(item);
    MarkFinished(item);                // 真正完成后更新业务状态
  }
}

size_t MyJobTask::GetMaxConcurrency(size_t worker_count) const {
  return EstimateUsefulParallelism();  // 由业务层实现
}
```

因此，**一次 `Run()` 返回，不等于整个 Job 已经完成**。它可能只处理了自己领到的那部分工作，调度器随后仍会决定是否继续执行。

**参阅：** [`JobTask` 接口定义](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/include/v8-platform.h)；`DefaultJobWorker::Run()`。

## 3. “最大并发度”不是“剩余工作量”本身

`GetMaxConcurrency(worker_count)` 的返回值，描述的是**当前最多值得安排多少个线程同时执行 `Run()`**，而不是还剩多少字节、对象或指令需要处理。

例如，同样有 10,000 个待处理对象：

- 如果只构成 **1 个不可再拆分的工作单元**，有效最大并发度可能只有 1。
- 如果能拆成 **8 个相互独立的工作单元**，有效最大并发度可能是 8。

因此：

```text
剩余工作量 ≠ 最大并发度
最大并发度 ≈ 目前能有效并行处理的工作单元数量
```

V8 接口注释建议，计算最大并发度时应考虑**所有尚未完成的工作单元，包括已经被 Worker 领取、但仍在处理中的工作**。这对完成判定尤其重要：不能因为队列被取空，就把“仍有线程正在计算”误判为“所有工作都完成了”。

此外，`worker_count` 表示当前分配给 Job 的线程数。具体业务实现可以使用它辅助判断返回值。调度层实际采用的并发上限还会受到平台可用 Worker 名额的约束：

```cpp
// DefaultJobState::CappedMaxConcurrency() 的关键逻辑
return std::min(job_task_->GetMaxConcurrency(worker_count),
                num_worker_threads_);
```

**参阅：** `JobTask::GetMaxConcurrency()` 的接口注释；`DefaultJobState::CappedMaxConcurrency()`。

## 4. `JobState` 是调度状态管理器，而不是业务任务的完成计数器

把 `DefaultJobState` 比作调度“遥控器”是有用的，但它本身**不理解某个 GC 阶段还剩多少对象**：这一业务语义留给 `JobTask`。

理解它的三个计数/状态就够用了：

| 字段 | 直观含义 | 重要提醒 |
| --- | --- | --- |
| `active_workers_` | 已占用的 Job 执行名额 | 不保证每个名额此刻都在执行 `Run()`；`Join()` 会先为调用线程预留一个名额 |
| `pending_tasks_` | 已提交到平台、尚未开始为该 Job 执行的 Worker 任务数 | **提交**不等于**正在运行** |
| `num_worker_threads_` | 此 Job 可用的 Worker 名额上限 | 它与业务需求共同限制实际调度并发度 |

其中最需要避免的误解是：

```text
active_workers_ 不恒等于 GetMaxConcurrency()
active_workers_ 也不必然等于“此刻正在 CPU 上计算的线程数量”
```

当业务层需要 8 个执行者，但当前只有 3 个名额被占用，其他任务可能仍在等待线程池调度；当并发需求下降，已有 Worker 也需要在合适的协作点退出。调度的目标是**尽可能合理地匹配需求、避免不必要的过量并发**，而不是时时刻刻维持一个精确等式。

**参阅：** `default-job.h` 中 `DefaultJobState` 的成员定义；`DefaultJobState::CanRunFirstTask()`。

## 5. 并发需求是动态的，Worker 数量也要动态调整

业务执行过程中，可并行工作单元数量可能增多，也可能减少。例如处理某些对象时又发现一批新工作，或随着工作完成并行需求逐渐下降。

默认调度器主要通过两个方向适应这种变化。

**需求增加：请求更多 Worker。** 业务方可通过 `JobHandle::NotifyConcurrencyIncrease()` 或执行中的 `JobDelegate::NotifyConcurrencyIncrease()` 主动告诉调度器“有更多工作可并行处理”。对应的 `DefaultJobState::NotifyConcurrencyIncrease()` 会重新查询并发上限，并参考 `active_workers_ + pending_tasks_` 决定还要提交多少 Worker 任务。

**需求减少：让已有 Worker 退出。** 后台 Worker 调用一轮 `job_task_->Run()` 后，进入 `DefaultJobState::DidRunTask()`，重新评估并发度：若不再需要该执行者，就减少 `active_workers_`，并通过 `worker_released_condition_` 发出通知；否则它可能继续执行下一轮 `Run()`。

```text
业务工作量 / 可并行性变化
       │
       ├── 增长：NotifyConcurrencyIncrease()
       │           └── 调度层视需要提交更多 Worker
       │
       └── 下降：Worker 执行一轮 Run() 后调用 DidRunTask()
                   └── 调度层视需要释放 Worker 名额
```

`JobDelegate::ShouldYield()` 提供另一个**协作式**退出机制：业务代码应适时检查是否需要尽快从当前 `Run()` 返回。但不要将它理解为“并发度每次降低都会立即强制中断 Worker”；在默认实现中，并发度的收缩也依赖 Worker 正常走到调度检查点。

**参阅：** `DefaultJobState::NotifyConcurrencyIncrease()`、`DefaultJobState::DidRunTask()`、`DefaultJobWorker::Run()`、`JobDelegate::ShouldYield()`。

## 6. `Join()` 不是单纯等待：调用线程也会加入工作

这是这套设计最有辨识度的地方。普通的线程 `join` 容易让人联想到“当前线程睡眠，等别人完成”；**V8 的 `JobHandle::Join()` 则可以让调用者参与执行同一个 `JobTask`**。

以默认实现的 `DefaultJobState::Join()` 为例，它大致经历以下步骤：

1. 将 Job 优先级提升到 `kUserBlocking`，并为当前调用线程预留一个执行名额。
2. 检查是否有足够的并发名额；如果加入后会超过当前最大并发度，则等待某个后台 Worker 释放名额。
3. 视需要补充尚未提交的 Worker 任务。
4. 当前线程直接调用 `job_task_->Run(&delegate)` 参与执行；一轮返回后，再检查是否继续工作或结束。

关键片段（保留结构，略去无关代码）：

```cpp
// Join() 内部的关键判断
while (active_workers_ > max_concurrency && active_workers_ > 1) {
  worker_released_condition_.Wait(&mutex_);
  max_concurrency = CappedMaxConcurrency(active_workers_ - 1);
}

// 取得参与机会之后：
while (true) {
  job_task_->Run(&delegate);   // Join 调用线程亲自干活
  base::MutexGuard guard(&mutex_);
  if (WaitForParticipationOpportunity() == 0) return;
}
```

请特别留意等待条件：**不是“并发度已被满足就等待”，而是“当前已经占用的名额多于允许的并发度，且还有其他 Worker 时才等待”**。`Join()` 开始时已经给自己预留了名额，因此这里是防止它和已有 Worker 一起超额执行。

比如原有 3 个后台 Worker：如果 Job 当前允许 4 路并行，那么调用 `Join()` 的线程可能直接成为第 4 个执行者；如果只允许 3 路并行，它就需要等待一个后台名额释放。

**参阅：** `DefaultJobHandle::Join()` → `DefaultJobState::Join()`，尤其是内部的 `WaitForParticipationOpportunity()` 和 `job_task_->Run(&delegate)`。

## 7. 主线程究竟如何知道“所有人一起干完了”？

这是理解 `Join()` 最重要的收尾问题。默认实现**不依赖某个 Worker 广播一个“Job 完成”事件**，而是结合两个条件：

1. **业务完成判断**：`JobTask::GetMaxConcurrency()` 最终返回 **0**，表示不再有需要执行的工作（包括不能遗漏正在处理中的工作）。
2. **执行者退出判断**：其他后台 Worker 已释放执行名额，只剩调用 `Join()` 的线程自身，即 `active_workers_ == 1`。

后台 Worker 在 `DidRunTask()` 中释放名额时，会减少 `active_workers_` 并调用 `worker_released_condition_.NotifyOne()`。如果 Join 线程正在条件变量上等待，它会被唤醒，重新取得锁并检查条件，而不是持续忙等。

因此可以用下面的时间线理解：

```text
多个线程共同调用 JobTask::Run()
                │
                ▼
业务层认为所有工作已完成
GetMaxConcurrency() → 0
                │
                ▼
后台 Worker 陆续完成 Run() 并退出
DidRunTask(): --active_workers_，NotifyOne()
                │
                ▼
Join 线程每次被唤醒后重新检查
最终看到 max_concurrency == 0 && active_workers_ == 1
                │
                ▼
Join 将 active_workers_ 置为 0，标记收尾状态
                │
                ▼
Join() 返回，调用线程继续执行后续流程
```

**“没有剩余工作”与“后台执行者已全部退出”是不同的事情。** 把两者都确认后再返回，才能让调用方把 `Join()` 当成这一并行阶段的完成同步点。

另外，`Join()` 的 API 对业务层还有一条重要约定：**开始 Join 后，一旦最大并发度降为 0，就不应再次增加。** 否则“Job 已结束”这一判断可能失效。

**参阅：** `DefaultJobState::Join()` 中的 `WaitForParticipationOpportunity()`；`DefaultJobState::DidRunTask()`；`JobHandle::Join()` 的接口注释。

## 8. 一个贯穿始终的执行过程

把上述机制拼在一起，可以形成下面这条主线：

```text
[业务层] 准备一批可并行处理的工作单元
    ↓
实现 JobTask::Run() 和 GetMaxConcurrency()
    ↓
Platform::PostJob() 提交 Job，取得 JobHandle
    ↓
[调度层] 根据并发需求提交后台 Worker 任务
    ↓
[执行层] 多个 Worker 运行 JobTask::Run()
    ↓
工作推进：并发需求动态变化
    ├── 增加：NotifyConcurrencyIncrease()
    └── 减少：DidRunTask() 决定是否释放 Worker
    ↓
[调用线程] 有需要时调用 JobHandle::Join()
    ├── 有参与名额：自己也执行 Run()
    └── 暂无参与名额：等待 Worker 释放
    ↓
GetMaxConcurrency() 归零 + 其他 Worker 退出
    ↓
Join() 返回，并行阶段结束
```

> 补充：`PostJob()` 在当前接口实现中会在创建 Job 后触发一次并发度通知，以启动调度；`CreateJob()` 则可先创建句柄，之后再由通知或 Join 触发执行。读源码时注意两者区别。

## 9. 回到 GC / Compile 源码，真正该追什么？

有了这套心智模型，继续阅读业务代码时不必先研究 `pending_tasks_` 的每一次加减、条件变量的每次唤醒或线程池的全部实现。优先回答四个问题：

1. **工作如何拆分？** 找具体 `JobTask` 的 `Run()`：它从哪里领取工作单元，如何保证线程安全？
2. **并发需求如何计算？** 找 `GetMaxConcurrency()`：工作单位是什么？是否包含已经领取但尚未处理完的工作？
3. **新工作何时被发现？** 找 `NotifyConcurrencyIncrease()`：什么事件让更多 Worker 值得参与？
4. **阶段在哪里汇合？** 找创建 Job、持有 `JobHandle` 和调用 `Join()` 的位置：谁需要等这批工作完成，后续流程依赖什么结果？

如果这四个问题能回答清楚，即使暂时不熟悉 `DefaultJobState` 的每个并发细节，也已经足以理解大部分业务层并行处理的结构。

## 10. 复习速记

- **`JobTask` 定义工作**：`Run()` 执行工作，`GetMaxConcurrency()` 报告有效的最大并发需求。
- **并发度不等于剩余计算量**：关键是还有多少工作单元能够有效并行；完成判定必须考虑正在处理中的工作。
- **`JobState` 管理执行资源**：结合活跃名额、待调度 Worker 和平台上限动态调整并发。
- **Worker 协作执行**：`Run()` 可以并发、反复调用；`DidRunTask()` 决定继续或退出。
- **`Join()` 既参与又等待**：有名额就加入计算，无名额就等待；最终在工作归零且其他 Worker 退出后返回。

**最终的心智模型：业务层定义 *work* 和 *useful parallelism*；调度层安排 *workers*；`Join()` 负责 *contribute and synchronize*。**

---

## 源码索引与参考资料

以下链接均指向 V8 官方源码仓库的 `main` 分支；文章关注的是机制，不依赖某一行的固定行号。源码随版本演进，阅读自己的 checkout 时应以对应版本为准。

1. [`include/v8-platform.h`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/include/v8-platform.h)：`JobTask`、`JobDelegate`、`JobHandle`、`Platform::PostJob()`、`Platform::CreateJob()` 的接口及契约说明。
2. [`src/libplatform/default-job.h`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/libplatform/default-job.h)：`DefaultJobState` 的字段、`DefaultJobWorker::Run()`、`JobDelegate::ShouldYield()`。
3. [`src/libplatform/default-job.cc`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/libplatform/default-job.cc)：`DefaultJobState::NotifyConcurrencyIncrease()`、`CanRunFirstTask()`、`DidRunTask()`、`CappedMaxConcurrency()`、`Join()`。
4. [`src/libplatform/default-platform.cc`](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/libplatform/default-platform.cc)：默认 `Platform` 的创建和 Worker 调度入口。
