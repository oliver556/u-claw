# OpenClaw 会话回答完成后侧栏持续转圈问题

## 1. 问题现象

聊天回答已经完整显示，但左侧会话仍持续显示转圈。

可能同时出现：

- 左侧会话一直显示运行中。
- 输入框区域仍显示停止/取消状态。
- 用户误以为模型仍在运行或继续计费。
- 切换会话、刷新页面或重启后状态恢复。

## 2. 排查结论

这是 OpenClaw `2026.7.1-2` 原版 Control UI 的会话终态同步漏洞。

已对比：

- 归档原版：`u-claw-app`
- 当前开发版：`u-claw-app-dev`
- 当前实际运行包

以下关键函数逻辑逐段 SHA-256 完全一致：

- `Mg()`
- `hc()`
- `vc()`
- `wr()`
- `Xn()`

U-Claw 当前补丁没有修改这些状态处理逻辑。

该问题不代表：

- 模型仍在生成。
- 请求仍在持续。
- 仍在继续计费。
- Gateway 卡死。
- U 盘持续读写。

本次现场后端状态已经确认：

```txt
status: done
abortedLastRun: false
stopReason: stop
hasActiveRun: null
```

回答实际运行约 11.3 秒，后端已正常结束。

## 3. 服务端终态顺序

服务端处理顺序为：

```txt
1. 发送 chat state=final
2. 清理服务端 active run
3. 异步持久化 session.status=done
4. 发送 sessions.changed
```

因此，前端收到 `chat state=final` 时，服务端的 session 状态可能仍短暂显示为：

```txt
status: running
hasActiveRun: true
```

## 4. 前端第一条终态处理链

聊天终态进入前端后的调用链：

```txt
Mg()
→ gc()
→ hc()
→ sessions.reconcileRunTerminal()
→ wr()
```

职责：

```txt
Mg()：处理 chat final、aborted、error
gc()：清理 chatRunId、chatStream 和本地运行状态
hc()：构造 session 终态更新参数
wr()：更新侧栏 session row
```

`wr()` 对外暴露为：

```txt
reconcileRunTerminal
```

## 5. 第一处逻辑缺口

`wr()` 为防止旧任务终态误伤新任务，存在以下保护条件：

```js
if (
  !sessionKeyMatches ||
  (row.hasActiveRun === true || isActive(row)) &&
  (!runId || !row.activeRunIds?.includes(runId))
) {
  return row;
}
```

意思是：

```txt
侧栏仍认为会话正在运行
+
activeRunIds 中没有当前终态事件的 runId
→ 拒绝清理 hasActiveRun
→ 侧栏继续转圈
```

该保护本身有必要。

如果完全删除，会造成旧任务的 `final` 清掉新任务的运行状态。

真正问题是：保护条件拒绝更新后，没有可靠地回到 Gateway 获取权威状态。

## 6. 第二处逻辑缺口

前端约 500ms 后还有一次本地补偿：

```txt
fc()
→ bc()
→ vc()
```

`vc()` 要求：

```js
row.activeRunIds?.length === 1 &&
row.activeRunIds[0] === terminalRunId
```

如果不满足，会执行：

```js
lastLocalTerminalReconcile = null;
return false;
```

也就是：

```txt
activeRunIds 缺失、数量不是1、runId 不一致
→ 清除补偿记录
→ 永久放弃本次本地补偿
```

## 7. 第三条终态同步链

服务端持久化完成后，还会发送：

```txt
sessions.changed
```

前端处理链：

```txt
Tr() 中的 subscribeEvents()
→ Xn()
→ 合并 session row
→ status=done
→ hasActiveRun=false
→ 侧栏转圈消失
```

但服务端发送该事件时使用：

```js
{ dropIfSlow: true }
```

如果事件发生以下情况：

- 客户端处理较慢。
- WebSocket 短暂拥堵。
- 事件被丢弃。
- 事件到达但没有成功合并。
- 前端切换会话或组件生命周期产生竞争。

前端就没有最终的权威刷新。

结果：

```txt
后端已经 done
前端 session row 仍保留 running
侧栏永久转圈
```

## 8. 精准根因

完整根因：

```txt
chat final 已到达
→ 本地聊天内容正常完成
→ wr() 因 runId/activeRunIds 保护条件拒绝清理侧栏
→ vc() 500ms 补偿也因严格匹配条件放弃
→ 后续 sessions.changed 延迟、丢失或未成功合并
→ 前端没有调用 sessions.list 做最终权威校准
→ hasActiveRun 残留
```

## 9. 涉及文件

当前开发目录中的相关运行文件：

```txt
u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/chat-page-DrPkxqJK.js
u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/index-Bvtt7vVx.js
```

关键函数：

```txt
chat-page-DrPkxqJK.js
- Mg()
- gc()
- hc()
- vc()
- fc()
- bc()

index-Bvtt7vVx.js
- wr()
- Xn()
- Tr()
```

正式修复应固化到：

```txt
u-claw-app-dev/scripts/patch-openclaw.js
```

禁止直接修改：

```txt
u-claw-app
U 盘运行目录
~/Library/Caches/U-Claw
Windows 本机运行缓存
```

缓存目录只允许临时验证，不算正式修复。

## 10. 稳定修复原则

禁止使用以下简单修法：

```js
hasActiveRun = false;
status = "done";
```

不能在收到任意 `chat final` 后无条件清理运行状态。

原因：

```txt
旧任务 final 可能晚于新任务 start 到达
→ 无条件清理会误伤新任务
```

稳定方案：

```txt
收到 chat final
→ 保留现有 runId 精确 reconcile
→ 立即清理当前 chatRunId/chatStream
→ 安排 sessions.list 权威刷新
→ 如果同一个旧 run 仍显示 active，有限重试
→ 最终完全以 Gateway sessions.list 为准
```

## 11. 建议刷新时序

建议在终态事件后执行有限刷新：

```txt
约 250ms：第一次权威刷新
约 1000ms：仍是同一个旧 run 时，再刷新
约 2500ms：最后一次兜底刷新
然后停止
```

禁止无限轮询。

每次刷新前必须检查：

```txt
1. sessionKey 仍是原会话。
2. 组件仍连接 Gateway。
3. 当前没有更新的 chatRunId。
4. activeRunIds 没有变成另一个新任务。
5. 当前终态记录仍对应原 terminalRunId。
```

## 12. 建议处理伪代码

```js
function handleChatTerminal(event) {
  clearLocalChatState(event);

  const applied = sessions.reconcileRunTerminal({
    sessionKeys: resolveMatchingSessionKeys(event.sessionKey),
    runId: event.runId,
    status: resolveTerminalStatus(event),
    endedAt: Date.now(),
  });

  if (!applied || sessionStillShowsTerminalRun(event)) {
    scheduleAuthoritativeSessionRefresh({
      sessionKey: event.sessionKey,
      terminalRunId: event.runId,
      delays: [250, 1000, 2500],
    });
  }
}
```

权威刷新逻辑：

```js
async function reconcileFromGateway(target) {
  if (!isStillRelevant(target)) {
    return;
  }

  await sessions.refresh({
    force: true,
  });

  const row = findSessionRow(target.sessionKey);

  if (!row) {
    return;
  }

  if (row.status !== "running" || row.hasActiveRun === false) {
    cancelRemainingRetries(target);
    return;
  }

  if (
    Array.isArray(row.activeRunIds) &&
    row.activeRunIds.length > 0 &&
    !row.activeRunIds.includes(target.terminalRunId)
  ) {
    // 已经出现新任务，禁止被旧任务终态清理。
    cancelRemainingRetries(target);
    return;
  }

  scheduleNextBoundedRetry(target);
}
```

## 13. `vc()` 建议调整

当前行为：

```txt
activeRunIds 不匹配
→ 删除 lastLocalTerminalReconcile
→ return false
```

建议行为：

```txt
activeRunIds 不匹配
→ 不直接修改 hasActiveRun
→ 不误清新任务
→ 触发一次 sessions.list 权威刷新
→ 根据 Gateway 返回结果决定是否继续补偿
```

`wr()` 的并发保护应保留。

主要修复对象应是：

```txt
vc() 的失败分支
+
终态后的权威刷新机制
```

## 14. 输入框状态保护

输入框发送资格当前主要依赖：

```js
canSend = connected && !archived
chatSending
chatRunId
chatStream
```

侧栏转圈主要依赖：

```js
session.hasActiveRun
session.status
activeRunIds
```

稳定修复只处理 session 权威同步。

禁止修改：

```txt
canSend
chatSending
chatRunId 的正常终态清理
chatStream 的正常终态清理
消息发送队列
steer 逻辑
消息重试逻辑
```

## 15. 为什么可能影响输入框

当前 `canAbort` 在 `chatRunId` 为空时，会回退读取：

```txt
session.hasActiveRun
```

因此侧栏状态残留时，可能出现：

```txt
chatRunId 已清空
session.hasActiveRun 仍为 true
→ 前端仍认为可以停止任务
→ 输入框区域继续显示停止/取消状态
→ 用户感觉输入框无法正常发送
```

权威刷新会同时纠正：

```txt
左侧转圈
停止按钮
输入框运行状态
会话运行样式
```

不要单独硬改发送按钮或停止按钮。

## 16. 错误修法可能造成的影响

如果收到任意 `final` 就强制设置 `done`：

- 旧任务终态可能清掉新任务。
- 新任务仍在运行，但左侧不转圈。
- 停止按钮提前消失。
- 用户再次发送消息，可能进入排队或 steer。
- 会话删除、归档等操作可能在任务运行中错误开放。
- Workboard 可能把运行任务误判为空闲。
- 多个并发 `activeRunIds` 可能被一起清除。

如果把输入框状态完全绑定侧栏状态：

- 侧栏事件延迟会让输入框不可用。
- 后台任务可能阻塞当前聊天发送。
- 陈旧 session 状态可能污染新任务。
- 一个会话的状态可能影响另一个会话。

## 17. 修复后的额外开销

建议只在本地 reconcile 失败或状态仍异常时触发权威刷新。

额外开销：

```txt
最多 1～3 次本地 Gateway sessions.list 请求
不请求模型
不产生模型计费
不访问 New API
不访问视频 adapter
不访问上游模型
```

请求只发生在本地桌面端与本地 Gateway 之间，开销很小。

## 18. 验收清单

### 18.1 普通完成

```txt
发送普通文本请求
→ 回答完成
→ 左侧转圈消失
→ 输入框可以继续发送
→ 停止按钮消失
```

### 18.2 `sessions.changed` 丢失

```txt
模拟或拦截 sessions.changed
→ chat final 正常到达
→ 有限权威刷新恢复 done
→ 左侧转圈消失
```

### 18.3 持久化延迟

```txt
模拟 session 持久化超过 250ms
→ 第一次刷新可能仍为 running
→ 后续刷新获取 done
→ 不永久转圈
```

### 18.4 旧任务结束后立即启动新任务

```txt
任务 A 收到 final
→ 用户立即发送任务 B
→ activeRunIds 变为任务 B
→ 任务 A 的补偿不得清除任务 B
→ 任务 B 保持正常转圈和停止按钮
```

### 18.5 多任务状态

```txt
activeRunIds 包含多个 run
→ 只移除已经结束的 terminalRunId
→ 其他运行中的 run 保留
```

### 18.6 中止

```txt
用户停止任务
→ 状态进入 killed/aborted
→ 转圈消失
→ 输入框恢复
```

### 18.7 失败

```txt
模型调用失败
→ 状态进入 failed
→ 转圈消失
→ 错误信息正常显示
→ 输入框恢复
```

### 18.8 超时

```txt
任务超时
→ 状态正确结束
→ 转圈消失
→ 输入框恢复
```

### 18.9 Gateway 断线重连

```txt
任务结束前后 Gateway 短暂断线
→ 重连后执行 sessions.list
→ 使用权威状态覆盖前端
→ 不保留陈旧转圈
```

### 18.10 会话切换

```txt
任务运行中切换会话
→ 原会话状态保持正确
→ 当前会话输入框不被原会话污染
→ 切回后状态与 Gateway 一致
```

### 18.11 Workboard 与会话页

```txt
聊天侧栏
会话管理页
Workboard
停止按钮
输入框
```

以上位置对同一 session 的运行状态必须一致。

## 19. 回归测试重点

修复后必须确认没有破坏：

```txt
文本对话
图片生成
视频生成
工具调用
后台任务
会话切换
消息队列
消息 steer
停止任务
Gateway 重连
Mac 便携版
Windows 便携版
```

该修复只属于前端会话状态同步，不应修改：

```txt
模型配置
New API 地址
API key
视频 adapter
OpenClaw Gateway 协议
U 盘数据同步逻辑
```

## 20. 最终冻结结论

```txt
问题来源：
OpenClaw 2026.7.1-2 原版 Control UI 会话终态同步漏洞。

核心缺口：
本地 runId reconcile 失败后，500ms 补偿直接放弃；
后续只依赖可能被丢弃的 sessions.changed；
没有最终 sessions.list 权威校准。

正确修法：
保留 runId 并发保护；
终态后增加有限、可取消、基于 Gateway 的 sessions.list 权威刷新；
禁止无条件设置 hasActiveRun=false；
禁止修改输入框发送状态逻辑。

修复目标：
回答完成后，侧栏、停止按钮、输入框、会话页和 Workboard
最终都与 Gateway 权威 session 状态一致。
```