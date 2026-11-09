# Chromium V8 源码研究与调试实践

本仓库基于 Google V8 JavaScript 引擎开源项目，用于个人源码阅读、调试实验与机制研究。

- **研究版本：** V8 12.0.267.10（发布于 2023 年 12 月，Chromium M120 中搭载）
- **研究时间：** 2026.06—至今（[提交记录](https://github.com/WU-SUNFLOWER/v8/commits/my-v8-12.0.267.10-study/)）

我的主要研究方法包括：
  - 静态阅读 V8 源码
  - 构造 JavaScript 测试代码、在其中添加打印操作，使用 `d8.exe` 运行并观察输出
  - 在 Windows 平台使用 VS Code 调试器对 V8 源码进行动态调试追踪
    - 环境配置方法：[https://zhuanlan.zhihu.com/p/2052382942765257775](https://zhuanlan.zhihu.com/p/2052382942765257775)
  - 根据静态阅读和动态调试的结论，为 V8 源码添加批注
  - 使用 ChatGPT 辅助，将自己的理解心得整理成专题笔记（见 [`docs`](docs/)）
    - 部分专题笔记参考了更新版本的 V8 主线源码，具体以各笔记中的版本说明为准。

本仓库中的所有源码批注和文档笔记，仅代表个人研究、学习和实验验证所得到的理解。

## 1. 现有主要研究内容

### 1.1. JavaScript 对象模型与属性访问

研究 JSObject、Map/Hidden Class、属性转换、Inline Cache 和原型链失效机制。

- 相关源码批注：[`src/objects/`](src/objects/)、[`src/ic/`](src/objects/)
- 实验脚本：[`learn_v8/map/`](learn_v8/map/)、[`learn_v8/prototype/`](learn_v8/prototype/)
- 研究笔记：[`docs/object/`](docs/object/)

### 1.2. 虚拟机堆、GC 与线程协作

研究 V8 虚拟机堆、Scavenge GC、增量/并发标记、写屏障以及 LocalHeap/Safepoint 等机制。

- 相关源码批注：[`src/heap/`](src/heap/)
- 研究笔记：[`docs/heap/`](docs/heap/)、[`docs/gc/`](docs/gc/)
- 实验脚本：[`learn_v8/gc/`](learn_v8/gc)

## 2. 调试工具扩展

为便于源码研究和调试，现阶段我为 V8 补充了若干 Runtime Intrinsics。

Runtime Intrinsics 使得我们可以在 JavaScript 代码中"插桩"调用 V8 C++ 层的内部代码，从而打印、获取或修改 V8 内部的某些状态。

调用自定义的 Runtime Intrinsics 进行调试实验，要求在 `d8.exe` 的启动参数中添加 `--allow-natives-syntax`。

这些 Runtime Intrinsics 接口，这些接口仅用于本地源码研究和调试，不属于面向普通业务 JavaScript 程序的公开 API。

- 相关源码：[`src/runtime/runtime-test.cc`](src/runtime/runtime-test.cc)
- 主要新增：
  - `GetCurrentFunction`：获取当前栈帧所对应的 JS 函数对象
  - `PrintCurrentContext`：打印当前栈帧所绑定的 Context 对象
  - `DebugPrintProtoChain`：打印指定 JS 对象的原型链
  - `PrintSharedFunctionInfo`: 打印指定 JS 函数对象绑定的 SFI 元信息
  - `SetDebugPrintEnabled`：临时启用或禁用 V8 的内部调试打印功能
    - 控制已接入该开关的内部调试打印路径，包括 `%DebugPrint()` 及部分 CSA 调试输出。
  - `SetDebuggerBreakpointEnabled`：临时启用或禁用调试器断点
    - 需配合调试器的条件断点使用：`g_current_isolate_->debugger_breakpoint_enabled_ == true`
