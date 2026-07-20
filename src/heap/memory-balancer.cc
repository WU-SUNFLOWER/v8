// Copyright 2023 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "src/heap/memory-balancer.h"

#include "src/heap/heap-inl.h"
#include "src/heap/heap.h"

namespace v8 {
namespace internal {

MemoryBalancer::MemoryBalancer(Heap* heap, base::TimeTicks startup_time)
    : heap_(heap), last_measured_at_(startup_time) {}

void MemoryBalancer::RecomputeLimits(size_t embedder_allocation_limit,
                                     base::TimeTicks time) {
  embedder_allocation_limit_ = embedder_allocation_limit;
  last_measured_memory_ = live_memory_after_gc_ =
      heap_->OldGenerationSizeOfObjects();
  last_measured_at_ = time;
  RefreshLimit();
  PostHeartbeatTask();
}

// Memory Balancer 根据应用的实际分配行为和 GC 性能，动态计算老生代
// 下一次触发 Major GC 前所允许达到的内存上限。
//
// 核心模型：
//
//   limit = live + sqrt(live * allocation_rate / (gc_speed * c))
//
// 其中：
//   - live：最近一次 Major GC 后仍然存活的老生代对象大小。
//   - allocation_rate：应用向老生代分配内存的速度。
//   - gc_speed：Major GC 回收/处理老生代内存的速度。
//   - c：内存成本与 GC CPU 成本之间的权衡系数。
//   - limit - live：下一次 Major GC 前允许使用的额外分配空间
//                   （headroom）。
//
// 0                    Live                    Limit
// |---------------------|-----------------------|
//    仍然存活的对象          可继续分配的空闲额度
// 该 limit 是动态的 GC 触发目标，并不是堆的绝对最大容量。
//
// 设计目标是在以下两种成本之间取得平衡：
//   1. 预设的 headroom 太小：
//      内存占用较低，但很快就会再次达到 limit，导致 Major GC
//      过于频繁，严重时可能发生 GC thrashing。
//
//   2. 预设的 headroom 太大：
//      Major GC 次数减少，但会保留大量暂时用不到的堆空间，
//      增加进程的内存占用。
//
// 各输入量对结果的影响：
//
//   - live 越大：一次 Major GC 通常越昂贵，因此适当增加 headroom。
//   - allocation_rate 越高：剩余空间消耗得越快，因此增加 headroom，
//     避免因高分配率而频繁触发 GC。
//   - gc_speed 越高：GC 可以更快完成，因此允许使用较小的 headroom，
//     以更频繁的 GC 换取更低的内存占用。
//   - c 越大：表示内存相对更“昂贵”，因此倾向于减小 headroom；
//     c 越小，则更重视减少 GC CPU 开销，倾向于增大 headroom。
//
// 使用平方根可以使调整更加平缓：某个输入量即使增长数倍，headroom
// 也不会按相同比例剧烈增长。例如 allocation_rate 增长 4 倍时，
// 理论上的 headroom 只增长约 2 倍。
//
// 该策略相比仅根据 live 使用固定增长比例的方案，能够更好地处理：
//
//   - 小堆、高分配率应用：主动增加可分配空间，降低 GC 频率。
//   - 大堆、低分配率应用：避免按固定比例预留过多内存，降低浪费。
//
// 最终计算出的 limit 还需要服从堆配置的最小值、最大值以及实现中的
// 其他边界条件，避免除零、数值异常或超出实际允许的堆容量。
void MemoryBalancer::RefreshLimit() {
  CHECK(major_allocation_rate_.has_value());
  CHECK(major_gc_speed_.has_value());
  const size_t computed_limit =
      live_memory_after_gc_ +
      sqrt(live_memory_after_gc_ * (major_allocation_rate_.value().rate()) /
           (major_gc_speed_.value().rate()) / v8_flags.memory_balancer_c_value);

  // 2 MB of extra space.
  // This allows the heap size to not decay to CurrentSizeOfObject()
  // and prevents GC from triggering if, after a long period of idleness,
  // a small allocation appears.
  constexpr size_t kMinHeapExtraSpace = 2 * MB;
  const size_t minimum_limit = live_memory_after_gc_ + kMinHeapExtraSpace;

  size_t new_limit = std::max<size_t>(minimum_limit, computed_limit);
  new_limit = std::min<size_t>(new_limit, heap_->max_old_generation_size());
  new_limit = std::max<size_t>(new_limit, heap_->min_old_generation_size());

  if (v8_flags.trace_memory_balancer) {
    heap_->isolate()->PrintWithTimestamp(
        "MemoryBalancer: allocation-rate=%.1lfKB/ms gc-speed=%.1lfKB/ms "
        "minium-limit=%.1lfM computed-limit=%.1lfM new-limit=%.1lfM\n",
        major_allocation_rate_.value().rate() / KB,
        major_gc_speed_.value().rate() / KB,
        static_cast<double>(minimum_limit) / MB,
        static_cast<double>(computed_limit) / MB,
        static_cast<double>(new_limit) / MB);
  }

  heap_->SetOldGenerationAndGlobalAllocationLimit(
      new_limit, new_limit + embedder_allocation_limit_);
}

void MemoryBalancer::UpdateGCSpeed(size_t major_gc_bytes,
                                   base::TimeDelta major_gc_duration) {
  if (!major_gc_speed_) {
    major_gc_speed_ = SmoothedBytesAndDuration{
        major_gc_bytes, major_gc_duration.InMillisecondsF()};
  } else {
    major_gc_speed_->Update(major_gc_bytes, major_gc_duration.InMillisecondsF(),
                            kMajorGCDecayRate);
  }
}

void MemoryBalancer::UpdateAllocationRate(
    size_t major_allocation_bytes, base::TimeDelta major_allocation_duration) {
  if (!major_allocation_rate_) {
    major_allocation_rate_ = SmoothedBytesAndDuration{
        major_allocation_bytes, major_allocation_duration.InMillisecondsF()};
  } else {
    major_allocation_rate_->Update(major_allocation_bytes,
                                   major_allocation_duration.InMillisecondsF(),
                                   kMajorAllocationDecayRate);
  }
}

void MemoryBalancer::HeartbeatUpdate() {
  heartbeat_task_started_ = false;
  auto time = base::TimeTicks::Now();
  auto memory = heap_->OldGenerationSizeOfObjects();

  const base::TimeDelta duration = time - last_measured_at_;
  const size_t allocated_bytes =
      memory > last_measured_memory_ ? memory - last_measured_memory_ : 0;
  UpdateAllocationRate(allocated_bytes, duration);

  last_measured_memory_ = memory;
  last_measured_at_ = time;
  RefreshLimit();
  PostHeartbeatTask();
}

void MemoryBalancer::PostHeartbeatTask() {
  if (heartbeat_task_started_) return;
  heartbeat_task_started_ = true;
  heap_->GetForegroundTaskRunner()->PostDelayedTask(
      std::make_unique<HeartbeatTask>(heap_->isolate(), this), 1);
}

HeartbeatTask::HeartbeatTask(Isolate* isolate, MemoryBalancer* mb)
    : CancelableTask(isolate), mb_(mb) {}

void HeartbeatTask::RunInternal() { mb_->HeartbeatUpdate(); }

}  // namespace internal
}  // namespace v8
