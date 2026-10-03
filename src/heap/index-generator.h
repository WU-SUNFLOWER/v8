// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef V8_HEAP_INDEX_GENERATOR_H_
#define V8_HEAP_INDEX_GENERATOR_H_

#include <cstddef>
#include <queue>

#include "src/base/macros.h"
#include "src/base/optional.h"
#include "src/base/platform/mutex.h"

namespace v8 {
namespace internal {

// A thread-safe data structure that generates heuristic starting points in a
// range to process items in parallel.
// 用于得到适合多线程并发处理同一区间的起始下标位置。
// 例如取区间总长度size=8，则各个线程从GetNext()取得的起始下标依次为
// 0, 4, 2, 6, 1, 3, 5, 7。
// 相比于让每个并发线程都按0, 1, 2...的顺序遍历区间和竞争下标位置，
// 这可以显著降低同一时刻线程间竞争同一下标位置的可能性。
class V8_EXPORT_PRIVATE IndexGenerator {
 public:
  explicit IndexGenerator(size_t size);
  IndexGenerator(const IndexGenerator&) = delete;
  IndexGenerator& operator=(const IndexGenerator&) = delete;

  base::Optional<size_t> GetNext();

 private:
  base::Mutex lock_;
  bool first_use_;
  // Pending [start, end) ranges to split and hand out indices from.
  std::queue<std::pair<size_t, size_t>> ranges_to_split_;
};

}  // namespace internal
}  // namespace v8

#endif  // V8_HEAP_INDEX_GENERATOR_H_
