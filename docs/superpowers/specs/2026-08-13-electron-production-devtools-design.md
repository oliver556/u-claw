# Electron 生产包禁用 DevTools 设计

## 目标

仅在新版 `product/desktop` 的 Electron 生产包中禁用 DevTools。开发运行继续允许使用 DevTools，不影响当前调试和功能开发。

## 范围

- 修改 `product/desktop`。
- 主窗口和高级控制台窗口使用同一生产环境策略。
- 不修改旧版 `u-claw-app`。
- 不修改前端、IPC、网关启动、业务流程或打包结构。

## 设计

窗口创建函数接收 `devTools` 布尔值，并将其写入 Electron `BrowserWindow` 的 `webPreferences.devTools`。

Electron 启动接线使用 `app.isPackaged` 判断运行环境：

- `app.isPackaged === true`：传入 `devTools: false`。
- `app.isPackaged === false`：传入 `devTools: true`。

该值同时传给主窗口和高级控制台窗口。Electron 原生 `devTools: false` 会阻止 F12、快捷键及程序调用打开 DevTools，因此无需额外拦截键盘事件。

## 验证

- 单元测试验证主窗口按参数设置 `webPreferences.devTools`。
- 单元测试验证高级控制台窗口按参数设置 `webPreferences.devTools`。
- 类型检查通过。
- `product/desktop` 测试通过。

## 风险

改动仅影响 BrowserWindow 的 DevTools 能力。生产包发生问题时不能直接打开 DevTools；开发环境保持可用，因此不影响当前开发进度。
