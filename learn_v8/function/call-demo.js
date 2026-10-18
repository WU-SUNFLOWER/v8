function foo() {
    function bar() {
        %DebugPrintSimply("Hello World");
    }
    bar();
}

foo();