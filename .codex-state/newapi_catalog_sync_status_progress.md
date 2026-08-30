### Goal
修复 NewAPI 模型同步误报空目录，并确保 seedance 视频模型不进入文字模型候选。

### Plan
- [x] 定位同步模型返回消息与 catalog merge 判定
- [x] 修复 seedance 能力分类与本地旧 metadata 迁移
- [x] 空 catalog 时保留本地 NewAPI 模型目录
- [x] 补充 JS/Go 防回归验证
- [x] 运行核心与 UI 验证

### Current status
- Current step: 已提交并重启验证
- Last completed: Gateway health 返回 `{"ok":true,"status":"live"}`，本机配置只剩 `newapi`
- Next action: 用户在模型页点“同步模型”复验提示与候选列表

### Notes
- `refreshCloudModelCatalog()` 现在区分 `syncedModelCount` 与 `modelCount`。
- NewAPI 本次返回空但本地已有模型时，提示保留本地模型，不再误报“未返回可用模型”。
- `seedance-*` 会按 video 模型规范化为 `input: ["text", "image"]`。
- 本机重启后确认：11 个 NewAPI 模型保留，两个 `seedance` video 模型 metadata 已修正，默认 video 仍为空。
