# AGENTS.md

本文件面向在此仓库中工作的代码代理与协作者，目标是帮助快速理解 V8 仓库的工作方式，并在改动时遵循一致的边界、构建流程与验证标准。

## 1. 项目定位

- 项目名称：V8 JavaScript Engine。
- 主要语言：C++。
- 辅助语言：Python、JavaScript / TypeScript、Torque。
- 核心用途：实现 ECMAScript，并向嵌入式宿主提供稳定的 C++ API。
- 常见工作类型：引擎实现、编译器与运行时优化、GC/Heap、Wasm、Inspector、测试基础设施、开发工具。

## 2. 仓库结构

优先按目录边界理解改动影响：

- `src/`：引擎核心实现。大多数运行时、编译器、对象模型、GC、Wasm、`d8` 壳程序都在这里。
- `include/`：对外公开头文件和 API 文档。这里的变更通常意味着公共 API 变化，风险高于 `src/` 内部实现。
- `test/`：主要测试目录，包含 `mjsunit`、`cctest`、`unittests`、`test262`、`inspector`、`wasm-*` 等。
- `tools/`：开发、构建、测试、调试、性能分析和网页工具。
- `samples/`：嵌入示例，适合用来理解平台初始化、Isolate 生命周期和 API 用法。
- `infra/`：构建与测试基础设施配置，多平台 builder 配置也在这里。
- `third_party/`：第三方依赖。除非任务明确要求，否则不要主动修改。

## 3. 常见子系统

遇到以下目录时，先确认是否需要联动修改测试、生成逻辑或脚本：

- `src/compiler/`：TurboFan 等编译器相关逻辑。
- `src/maglev/`：Maglev 编译器。
- `src/heap/`：垃圾回收、内存页、空间管理、safepoint 等。
- `src/objects/`：对象布局、内建对象定义，常与 `.tq` 文件联动。
- `src/builtins/`：大量内建逻辑由 Torque 描述。
- `src/wasm/`：WebAssembly 支持。
- `src/inspector/`：调试协议与 inspector 相关功能。
- `src/d8/`：独立 shell，可用于本地快速验证行为。

## 4. 构建原则

本仓库日常开发优先使用 GN + Ninja 工作流，不要自行引入新的构建入口。

推荐入口：

- 生成/管理构建配置：`tools/dev/v8gen.py`
- 本地便捷构建与测试：`tools/dev/gm.py`

常用示例：

```bash
python tools/dev/gm.py x64.debug d8
python tools/dev/gm.py x64.release check
python tools/dev/gm.py out/foo unittests
```

说明：

- `gm.py` 会封装常见的 `gn` / `ninja` / 测试运行流程。
- 默认常见测试集合包括 `cctest`、`debugger`、`intl`、`message`、`mjsunit`、`unittests`。
- 根 `.gn` 指定了构建根配置，并默认关闭 Rust 依赖。

## 5. 测试选择

改动后不要只说“建议测试”，应尽量运行与子系统直接相关的测试。

可参考以下映射：

- `src/d8/`、语言语义、运行时行为改动：优先 `mjsunit`、`message`、`debugger`
- `src/compiler/`、`src/maglev/`：优先 `cctest`、`unittests`，必要时补 `mjsunit`
- `src/heap/`：优先 `cctest`、`unittests`
- `src/wasm/`：优先 `wasm-api-tests`、`wasm-js`、`wasm-spec-tests`
- `src/inspector/`：优先 `inspector`
- 公共 API 或嵌入相关改动：优先 `cctest`、`unittests`，必要时参考 `samples/`
- 标准兼容性相关改动：视影响范围补 `test262`

如果无法全量运行，至少说明：

- 实际运行了哪些测试
- 没有运行哪些关键测试
- 未运行的原因是什么

## 6. 提交前检查

仓库根 `PRESUBMIT.py` 已定义多类检查，提交前应特别注意：

- C++ lint
- Torque 格式检查
- JS 格式检查
- 版权头、尾随空格、空行约束
- status file 检查
- GCMole 模式检查
- `DEPS` / `#include` 依赖边界检查

这意味着：

- 新增或修改 `.tq`、`.js`、`.mjs`、`.cc`、`.h` 文件时，要保持与仓库既有风格一致。
- 新增 `#include` 时，不仅要看能否编译，还要确认没有违反目录依赖规则。
- 修改 `DEPS` 文件时，要意识到这会影响更大范围的 include 合法性检查。

## 7. 高风险改动区

以下改动默认视为高风险，需要更谨慎地补充说明与验证：

- `include/` 下的公共 API 变更
- `src/objects/` 与 `src/builtins/` 的对象模型或 Torque 变更
- `src/heap/` 的 GC、安全点、空间管理改动
- `src/compiler/`、`src/maglev/` 的优化与 lowering 改动
- `src/wasm/` 的解码、执行、C API 改动
- `DEPS` 规则与跨目录 include 调整
- `test262` 适配、inspector protocol 兼容性相关改动
- 跨平台分支、平台专用代码、构建参数改动

遇到这些情况时，优先提供：

- 影响面
- 风险点
- 已运行测试
- 未覆盖的验证空白

## 8. 修改建议

编写或修改代码时遵循以下约定：

- 优先做最小必要改动，避免无关重构。
- 先确认改动属于公共 API、内部实现、测试还是工具脚本，再决定验证范围。
- 修改 `.tq` 文件时，检查是否需要同步调整相关 C++、对象定义或测试。
- 修改测试时，优先贴近现有测试风格，不要引入与当前目录不一致的新测试框架。
- 修改工具脚本时，注意是否会影响 Windows、Linux 和 CI 环境。
- 不要主动修改 `third_party/`，除非任务明确要求。

## 9. 文档与示例

理解背景时，优先参考以下位置：

- `README.md`：项目简介
- `include/APIDesign.md`：公共 API 设计背景
- `samples/`：嵌入用法示例
- `tools/README.md`：本地工具与网页工具说明
- `test/*/README*`：特定测试套件说明

## 10. 代理工作输出要求

如果你是自动化代码代理，完成任务时建议在说明中包含：

- 修改了哪些目录和文件
- 为什么在这些位置改
- 运行了哪些构建或测试命令
- 若未运行测试，明确说明原因和风险
- 是否涉及公共 API、Torque、DEPS、Wasm、Heap、Compiler 等高风险区域

## 11. 推荐工作流

1. 先识别受影响子系统和目录边界。
2. 阅读相邻实现与现有测试，避免凭猜测修改。
3. 使用 `gm.py` 或已有 GN 输出目录进行最小范围构建。
4. 运行与改动直接相关的测试。
5. 检查是否触发 presubmit 风险点，尤其是格式、依赖边界和高风险子系统。
6. 在最终说明中明确交代改动范围、验证结果和剩余风险。
