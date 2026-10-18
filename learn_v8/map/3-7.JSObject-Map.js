// ==========================================================================================
// JSObject 教学用例：配合 d8 调试演示
// 覆盖：属性存储 -> 元素存储 -> 创建与迁移 -> 属性/元素访问与定义 -> 原型与扩展性
//
// 用法：
//   1）直接运行：d8 --allow-natives-syntax 3-7.JSObject-Map.js
//   2）调试断点：在代码中标注的「断点 N」处设置断点，观察对应变量在内存中的
//               map、properties_or_hash、elements（可配合 %DebugPrint）
//   3）C++ 断点：在 V8 源码中设置断点，如 JSObject::MigrateToMap、TransitionElementsKind、
//               NormalizeProperties，再通过本脚本触发对应路径
// ==========================================================================================

(function demo() {
  "use strict";

  // ---------------------------------------------------------------------------
  // 一、属性存储（properties_or_hash：fast vs slow）
  // 对应教学计划：§3 properties_or_hash、§8 NormalizeProperties / MigrateToMap
  // ---------------------------------------------------------------------------
  function demoPropertyStorage() {
    // 1. 少量属性 -> 快速模式，in-object 或 property_array
    %DebugPrint("Hello fastObject");
    const fastObj = { a: 1, b: 2, c: 3 };
    %DebugPrint("bye fastObj");
    // 断点 1：观察 fastObj 的 map、properties_or_hash （EmptyFixedArray 或 Smi）
    fastObj.d = 4;
    fastObj.e = 5;
    // 断点 2：属性增多后可能部分进入 property array（由 Map 的 inobject_pr）

    // 2. 大量属性或频繁 delete -> 可能转化为字典模式（slow properties）
    const manyProps = {};
    for (let i = 0; i < 30; i++) manyProps["p" + i] = 1;
    // 断点 3：观察 manyProps 的 map.is_dictionary_map、property_dictionary

    // 3. 通过 delete 促使转为 slow（V8 启发式）
    const deleted = { x: 1, y: 2, z: 3 };
    delete deleted.y;
    // 断点 4：部分引擎在 delete 后可能 normalize 为 dictionary
  }

  // ---------------------------------------------------------------------------
  // 二、元素存储（elements：Fast vs Slow、ElementsKind 迁移）
  // 对应教学计划：§4 elements、§9 TransitionElementsKind / NormalizeElements
  // ---------------------------------------------------------------------------
  function demoElementsStorage() {
    // 1. PACKED_SMI_ELEMENTS -> 仅 Smi
    const packedSmi = [10, 20, 30];
    // 断点 5：elements 为 FixedArray，map.elements_kind = PACKED_SMI_ELEMENTS

    // 2. 写入 double -> 迁移到 PACKED_DOUBLE_ELEMENTS
    packedSmi[1] - 2.5;
    // 断点 6：elements 可能变为 FixedDoubleArray、elements_kind 升级

    // 3. 写入对象 -> 迁移到 PACKED_ELEMENTS
    packedSmi[2] = { foo: 1 };
    // 断点 7：elements_kind = PACKED_ELEMENTS，FixedArray 存 HeapObject

    // 4. 空洞（hole） -> HOLEY_* 系列
    const holey = [1, 2, 3];
    holey[10] = 99;
    // 断点 8：中间为 hole，elements_kind 为 HOLEY_ELEMENTS 等

    // 5. 稀疏或大索引 -> 可能转为 DICTIONARY_ELEMENTS（NumberDictionary）
    const sparse = [];
    sparse[0] = 1;
    sparse[10000] = 2;
    // 断点 9：可能走 dictionary elements（视引擎启发而定）
  }

  function MapUpdater() {
    function Point() {
        this.x = 1;
    }
    let p1 = new Point();
    let p2 = new Point();
    %DebugPrint(p1);
    %DebugPrint(p2);
    p2.x = 1.5;
    %DebugPrint(p1);
    %DebugPrint(p2);
    p1.x;
    %DebugPrint(p1);
  }

  // ---------------------------------------------------------------------------
  // 三、创建与迁移（对象创建方式、Map 与 迁移）
  // 对应教学计划：§6 创建、§5 MigrateToMap、§16 AllocateStorageForMap
  // ---------------------------------------------------------------------------
  function demoCreationAndMigration() {
    // 1. new Object() / {} -> 走 JSObject::New 或 AllocateJSObjectFromMap
    const o1 = {};
    const o2 = new Object();

    // 2. Object.create(proto) -> 指定原型的创建，不同 initial map
    const proto = { inherited: 42 };
    const child = Object.create(proto);
    child.own = 1;
    // 断点 10：child 的 map.prototype === proto：观察创建时的 map 与迁移

    // 3. 动态添加属性 -> Map transition、可能 MigrateToMap
    const evolving = {};
    evolving.a = 1;  // 第一次添加：transition 到新 Map
    evolving.b = 2;  // 再次 transition
    evolving.c = 3;
    // 断点 11：evolving 的 map 有 3 个 in-object/field、descriptor 顺序
  }

  // ---------------------------------------------------------------------------
  // 四、属性/元素访问与定义（读、写、定义、删除）
  // 对应教学计划：§7 快速属性访问、§10 DefineOwnProperty / CreateDataProperty
  // ---------------------------------------------------------------------------
  function demoAccessAndDefinition() {
    const obj = { name: "V8", count: 0 };

    // 1. 命名属性：读、写
    const n = obj.name;
    obj.count = 10;

    // 2. 元素：下标读、写
    const arr = [1, 2, 3];
    arr[1] = 20;
    const v = arr[2];

    // 3. Object.defineProperty：显式描述符，走 DefineOwnProperty
    Object.defineProperty(obj, "id", {
        value: 100,
        writable: false,
        enumerable: true,
        configurable: false
    });
    // 断点 12：obj 的 map 增加 "id" 描述符，attributes 非默认

    // 4. 删除属性
    delete obj.count;
    // 断点 13：可能触发 map 变化或（多次 delete）normalize

    // 5. 元素删除
    delete arr[1];
    // 断点 14：arr[1] 变为 hole、elements kind 可能变为 holey
  }

  // ---------------------------------------------------------------------------
  // 六：嵌入与 API（访问器，与 C++ API 对应的模式）
  // 对应教学计划：§11 访问器与拦截器、§15 Embedder 字段
  // 说明：d8 中无真实 embedder 槽位；此处用 defineProperty 的 getter/setter
  //      模拟"从 API 侧定义行为"的模式（实现上对应 AccessorInfo）
  // ---------------------------------------------------------------------------
  function demoEbedderAndAPI() {
    const apiLike = {};
    let _value = 0;
    Object.defineProperty(apiLike, "value", {
        get() { return _value; },
        set(v) { _value = v; },
        enumerable: true,
        configurable: true
    });
    apiLike.value = 42;
    const read = apiLike.value;  // 42
    // 断点 18：apiLike 的 descriptor 为 accessor，value 槽为 AccessorPair

    // 2. d8 调试提示：在 d8 REPL 或断点后执行（需 --allow-natives-syntax）
    //    %DebugPrint(plain) -> 打印对象 map、properties、elements
    //    %HasFastProperties(plain) -> 是否快速属性
    const plain = { a: 1, b: 2 };
  }

  function JSObjectProperty() {
    const obj = {};
    obj.a = 1;
    obj.b = 2;
    obj.c = 3;
    obj.d = 4;
    obj.e = 5;  // 很可能从这里开始溢出到 PropertyArray
    obj.f = 6;
    obj.g = 7;
    obj.h = 8;

    %DebugPrint(obj);

    const obj1 = {a:1, b:2, c:3, d:4, e:5, f:6, g:7, h:8};


    %DebugPrint(obj1);
  }

  // 
  // 串联执行：按教学顺序跑一遍，便于在关键处设置断点
  demoPropertyStorage();
  //   demoElementsStorage();
  //   MapUpdater();
  //   demoCreationAndMigration();
  //   demoAccessAndDefinition();
  //   demoEbedderAndAPI();
  //   JSObjectProperty();
})();