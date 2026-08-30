# Bavi-box 视频 Adapter 按秒计费改造方案

## 1. 文档状态

本文记录后续改造方案。

当前尚未实施，不代表现有代码已经支持安全、通用的按秒计费。

目标：

```text
保持现有请求链路不变：

OpenClaw
→ 本机 adapter
→ New API
→ 服务器 adapter
→ 即梦或其他企业视频 API
```

改造后：

```text
所有视频模型统一使用 seconds 作为计费时长。
本机 adapter 负责确定计费秒数。
New API 根据 seconds 计费。
服务器 adapter 负责把 seconds 转换成不同上游需要的字段。
新增视频 API 时，尽量只增加模型 profile，不再修改主计费逻辑。
```

---

## 2. 当前代码实际行为

当前主要代码：

```text
u-claw-app-dev/src/video-adapter.js
```

OpenClaw xAI 视频 provider 当前行为：

```text
默认 duration = 8
允许 durationSeconds = 1～15
发送字段名为 duration
```

本机 adapter 会执行：

```text
duration → seconds
```

但当前即梦模型 profile 同时固定：

```js
defaults: {
  frames: 241
}
```

即梦当前映射规则：

```text
seconds <= 5 → frames = 121
seconds > 5  → frames = 241
```

其中：

```text
121 frames ≈ 5 秒
241 frames ≈ 10 秒
```

但因为 profile 已经提前写入：

```text
frames = 241
```

后面的 `secondsToJimengFrames()` 通常不会重新计算。

当前可能出现：

```text
OpenClaw 发送 duration=8
→ 本机 adapter 发送 seconds=8、frames=241
→ New API 按8秒计费
→ 服务器 adapter 使用 frames=241
→ 即梦实际生成10秒
```

结果：

```text
New API 扣8秒费用
火山引擎产生10秒成本
计费时长与实际生成时长不一致
```

如果请求携带：

```text
seconds=15、frames=241
```

还可能出现：

```text
New API 按15秒扣费
即梦实际只生成10秒
用户被多扣费
```

---

## 3. 当前 Adapter 是否支持未来按秒视频 API

结论：

```text
部分支持，但不具备通用、安全的按秒计费能力。
需要进行一次时长策略改造。
```

当前 profile 已有：

```text
aliases
defaults
bodyType
upstreamModel
fileFields
```

这些配置可以处理简单字段重命名和请求格式，但缺少：

```text
模型支持的最小时长
模型支持的最大时长
模型支持的离散时长
时长步长
默认时长
计费时长规范化
上游时长字段转换
非法时长处理
seconds 与 frames 一致性校验
防止伪造低计费时长
实际生成时长审计
```

只有满足以下全部条件的新 API，当前 adapter 才可能直接工作：

```text
上游直接接受 seconds
支持任意整数秒
请求兼容 OpenAI /v1/videos
New API 能原样转发 seconds
不需要额外时长转换
```

以下类型目前不能安全适配：

```text
使用 duration
使用 duration_ms
使用 frames / num_frames
只支持5秒、10秒等离散档位
不同分辨率有不同时长限制
文生视频和图生视频时长范围不同
按固定模型 SKU 决定时长
需要根据返回结果结算实际时长
```

---

## 4. 改造核心原则

必须区分三个概念：

```text
requestedSeconds：用户请求秒数
billableSeconds：New API 应计费秒数
upstreamDuration：发送给上游 API 的时长参数
```

标准处理链：

```text
用户请求 durationSeconds
→ adapter 读取并校验
→ 根据模型 durationPolicy 规范化
→ 得到 billableSeconds
→ 向 New API 发送 seconds=billableSeconds
→ 服务器 adapter 再次校验
→ 转换成上游字段
→ 请求实际视频 API
```

硬性约束：

```text
New API 收到的 seconds 必须等于实际生成规格对应的秒数。
服务器 adapter 不得信任客户端传入的 frames。
frames、duration_ms 等上游字段必须由服务器 adapter 根据 seconds 重新计算。
```

---

## 5. 建议增加 Duration Policy

每个模型 profile 增加：

```js
durationPolicy
durationMapping
```

### 5.1 支持任意秒数的 API

```js
{
  durationPolicy: {
    mode: 'range',
    defaultSeconds: 10,
    minSeconds: 1,
    maxSeconds: 60,
    stepSeconds: 1
  },
  durationMapping: {
    upstreamField: 'duration',
    multiplier: 1
  }
}
```

处理结果：

```text
用户请求17秒
→ billableSeconds=17
→ New API seconds=17
→ 上游 duration=17
```

### 5.2 使用毫秒的 API

```js
{
  durationPolicy: {
    mode: 'range',
    defaultSeconds: 10,
    minSeconds: 1,
    maxSeconds: 120,
    stepSeconds: 1
  },
  durationMapping: {
    upstreamField: 'duration_ms',
    multiplier: 1000
  }
}
```

处理结果：

```text
用户请求17秒
→ New API seconds=17
→ 上游 duration_ms=17000
```

### 5.3 固定时长 API

```js
{
  durationPolicy: {
    mode: 'fixed',
    seconds: 10
  }
}
```

处理结果：

```text
New API seconds=10
上游固定生成10秒
```

如果客户端传入其他秒数：

```text
禁止继续使用客户端秒数计费。
应该拒绝请求，或者明确覆盖成10秒。
不得发送 seconds=5，但实际生成10秒。
```

### 5.4 离散时长 API

即梦当前适合：

```js
{
  durationPolicy: {
    mode: 'discrete',
    defaultSeconds: 10,
    allowedSeconds: [5, 10]
  },
  durationMapping: {
    upstreamField: 'frames',
    values: {
      5: 121,
      10: 241
    }
  }
}
```

处理结果：

```text
5秒  → New API seconds=5  → 即梦 frames=121
10秒 → New API seconds=10 → 即梦 frames=241
```

---

## 6. 即梦模型建议

火山引擎按照秒数收费，不代表即梦接口一定支持任意整数秒。

按照当前 adapter 和即梦参数，当前已知规格是：

```text
5秒
10秒
```

因此当前即梦不建议伪装成支持1～15任意秒数。

推荐使用明确模型 SKU：

```text
jimeng-video-3-720p-5s
jimeng-video-3-720p-10s
jimeng-video-3-1080p-5s
jimeng-video-3-1080p-10s
```

为了兼容旧配置：

```text
jimeng-video-3-720p
```

可以继续保留，但明确作为：

```text
jimeng-video-3-720p-10s
```

的兼容别名。

这样可以避免 OpenClaw 默认发送 `duration=8` 时产生歧义。

如果保留单一模型并允许传入5/10秒，则遇到：

```text
6秒
8秒
9秒
```

必须明确处理策略。

推荐优先级：

```text
1. 拒绝不支持的秒数，并返回支持值 [5, 10]
2. 不建议静默向上取整
3. 不允许按请求8秒计费、实际生成10秒
```

---

## 7. 防止计费绕过

当前必须防止这种请求：

```json
{
  "model": "jimeng-video-3-720p",
  "seconds": 5,
  "frames": 241
}
```

危险结果：

```text
New API 按5秒计费
即梦根据241帧生成10秒
```

正确处理：

```text
本机 adapter 不向 New API 发送 frames。
New API 只看到标准字段 seconds。
服务器 adapter 忽略或删除外部传入的 frames。
服务器 adapter 根据已校验的 seconds 重新计算 frames。
```

服务器规则：

```js
delete request.frames;

const frames = durationPolicy.toUpstreamFrames(
  normalizedSeconds
);
```

任何上游专用字段都不能作为计费依据：

```text
frames
duration_ms
num_frames
length
clip_duration
```

统一计费依据只能是：

```text
seconds
```

---

## 8. New API 计费配置

当前渠道类型：

```text
OpenAI
```

当前请求端点：

```text
POST /v1/videos
```

该类型可以进入 New API 视频任务计费逻辑。

计费大致为：

```text
最终费用
= 模型每秒价格
× seconds
× 分辨率倍率
× 分组倍率
```

模型价格必须填写单秒价格。

示例：

```text
计划10秒视频总价：2.8
```

应填写：

```text
单秒价格：0.28
```

不能填写：

```text
2.8
```

否则可能计算为：

```text
2.8 × 10 = 28
```

验证 New API 消费日志，应看到：

```text
seconds: 5
```

或者：

```text
seconds: 10
```

也可以检查响应头：

```text
X-New-Api-Other-Ratios
```

预期包含：

```json
{
  "seconds": 10,
  "size": 1
}
```

---

## 9. 是否根据视频返回结果计费

不建议把最终 MP4 的实际媒体时长作为主要计费依据。

原因：

```text
任务是异步生成
New API 通常在请求阶段预扣费用
视频文件实际时长可能是10.041秒、9.958秒等小数
不同编码器可能产生微小偏差
上游返回不一定包含可靠时长
下载文件后再解析会增加延迟和失败点
```

推荐：

```text
按照规范化后的 billableSeconds 计费。
```

上游返回的实际时长仅用于：

```text
日志
审计
成本核对
异常告警
```

如果未来某个供应商必须按照返回的实际秒数结算，则需要另外设计：

```text
预扣
任务完成后结算
多退少补
失败退款
```

这不属于当前简单按秒计费范围。

---

## 10. 建议代码结构

增加统一函数：

```js
function normalizeVideoDuration(requestedSeconds, profile) {
  // 返回：
  // requestedSeconds
  // billableSeconds
  // normalized
  // supportedSeconds
}
```

增加上游映射函数：

```js
function mapDurationToUpstream(billableSeconds, profile) {
  // range:
  //   seconds → duration
  //
  // milliseconds:
  //   seconds → duration_ms
  //
  // discrete frames:
  //   5 → 121
  //   10 → 241
}
```

本机 adapter：

```text
读取 duration / durationSeconds / seconds
→ normalizeVideoDuration()
→ 删除 duration、durationSeconds、frames
→ 设置 seconds=billableSeconds
→ 发送给 New API
```

服务器 adapter：

```text
读取 New API 转发的 seconds
→ normalizeVideoDuration()
→ 校验模型及时长
→ 删除客户端上游字段
→ mapDurationToUpstream()
→ 请求实际供应商
```

---

## 11. 需要修改的文件

主要源码：

```text
u-claw-app-dev/src/video-adapter.js
```

新增测试，文件名按项目测试约定确定，例如：

```text
u-claw-app-dev/test/video-adapter-duration.test.js
```

如果增加新的模型 ID，还需要同步：

```text
u-claw-app-dev/resources/default-openclaw.json
u-claw-app-dev/scripts/sync-openclaw-config.js
```

如果 OpenClaw 原版 provider 的默认时长影响模型选择，优先使用模型 profile 或明确模型 ID 解决。

只有 adapter 无法解决时，才允许通过：

```text
u-claw-app-dev/scripts/patch-openclaw.js
```

增加最小 OpenClaw 补丁。

不得直接手改打包后的 `node_modules` 作为正式修复。

服务器部署文件也必须同步更新：

```text
/opt/uclaw-video-adapter/video-adapter.js
```

服务器文件必须来自仓库正式源码或明确的部署产物，不能形成两个独立版本。

---

## 12. 对现有系统可能造成的影响

### 12.1 计费变化

改造后：

```text
原来按8秒扣费、实际生成10秒的请求
会改成按实际规格10秒扣费
```

因此消费日志和用户扣费可能发生变化。

这是修正，不是额外收费，但上线前必须核对价格。

### 12.2 旧请求兼容

旧客户端可能发送：

```text
duration=8
frames=241
```

新服务器如果严格校验，可能返回参数错误。

需要保留旧模型别名，或者安排客户端和服务器同步升级。

### 12.3 模型名称变化

增加：

```text
-5s
-10s
```

模型后，必须同步：

```text
OpenClaw 模型列表
New API 模型列表
New API 渠道模型映射
New API 模型价格
桌面配置模板
主播版配置
便携版配置
```

### 12.4 上线顺序

本机 adapter 和服务器 adapter 使用同一套时长规则。

不能只更新一端。

否则可能出现：

```text
本机按5秒计费
服务器仍按10秒生成
```

或者：

```text
本机发送新模型
服务器不认识新模型
```

### 12.5 打包影响

改造完成后，桌面 dev 验证通过，仍需重新：

```text
同步配置
构建桌面版
构建主播便携版
写入 U 盘
验证 Mac
验证 Windows
```

本次改造不需要改变以下链路配置：

```text
providers.xai.baseUrl
providers.xai.apiKey
New API baseUrl
本机 adapter 端口
服务器 adapter 公网地址
```

---

## 13. 必须增加的测试

### 13.1 即梦5秒

```text
输入 duration=5
预期 New API 收到 seconds=5
预期本机 adapter 不发送 frames
预期服务器 adapter 生成 frames=121
```

### 13.2 即梦10秒

```text
输入 duration=10
预期 New API 收到 seconds=10
预期服务器 adapter 生成 frames=241
```

### 13.3 非法离散时长

```text
输入 duration=8
预期返回明确错误
预期错误包含 supportedSeconds=[5,10]
不得继续计费和生成
```

### 13.4 防止伪造帧数

```text
输入 seconds=5、frames=241
预期服务器忽略 frames=241
预期重新计算 frames=121
```

### 13.5 任意秒数企业 API

```text
模型支持1～60秒
输入 duration=17
预期 New API 收到 seconds=17
预期上游收到 duration=17
```

### 13.6 毫秒接口

```text
输入 duration=17
预期 New API 收到 seconds=17
预期上游收到 duration_ms=17000
```

### 13.7 越界请求

```text
模型最大60秒
输入 duration=61
预期拒绝
不得静默生成60秒并按照61秒计费
```

### 13.8 默认时长

```text
请求未显式指定时长
预期使用模型自己的 defaultSeconds
不得使用全局 DEFAULT_SECONDS=15 覆盖所有模型
```

---

## 14. 验收标准

改造完成必须满足：

```text
1. New API 日志中的 seconds 与实际生成规格一致。
2. 即梦5秒使用121帧。
3. 即梦10秒使用241帧。
4. 客户端无法通过伪造 frames 降低计费。
5. 不支持的时长返回明确错误。
6. 新增任意秒数 API 时，只需增加 profile 和供应商请求映射。
7. 文本、图片请求链路不受影响。
8. 视频任务创建、轮询、下载、展示正常。
9. 本机 dev 验证正常。
10. 服务器 adapter 验证正常。
11. Mac 打包验证正常。
12. Windows 便携版验证正常。
```

---

## 15. 最终结论

当前 adapter 已具备模型 profile 和字段别名基础，但时长处理仍然是即梦专用写法。

当前主要问题：

```text
New API 按 seconds 计费
即梦根据固定 frames 生成
seconds 与 frames 没有强绑定
```

推荐进行一次统一改造：

```text
durationPolicy
+ durationMapping
+ billableSeconds
+ 服务器二次校验
+ 禁止客户端控制 frames
```

改造后：

```text
即梦使用5秒/10秒离散计费。
支持任意秒数的企业 API 使用 range 策略。
使用毫秒或帧数的 API 由服务器 adapter 转换。
New API 始终只按照规范化后的 seconds 计费。
```

后续新增视频模型时：

```text
增加模型 profile
配置支持秒数
配置上游字段映射
配置 New API 每秒价格
执行统一测试
```

不再修改整条视频请求链路。