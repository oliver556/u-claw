# 视频 Adapter 稳定链路、后台管理与部署说明

更新时间：2026-08-30

状态：

```txt
P0 已上线：New API -> video-adapter.yiyong.me -> Flash/Seedance 已打通。
P1 已补：内置后台登录保护、多上游配置、多模型映射、保存热加载、保存前备份。
仍未补：多协议真实适配、token hash 存储、后台配置恢复、配置变更审计。
```

## 0. 最终结论

```txt
1. adapter 部署在香港前置优化机，不部署在 New API 本体机。
2. 对外客户入口只有 api.yiyong.me，不让客户访问 adapter 域名。
3. New API 渠道访问 video-adapter.yiyong.me，adapter 再访问上游。
4. adapter 只部署一个服务，不按模型、不按上游拆多个服务。
5. 多模型、多上游只拆代码和配置：providers + models + request handlers。
6. New API 模型广场保留 5s、10s 这种固定 SKU，方便展示、计费、客户端选择。
7. 固定秒数必须在 adapter 强制覆盖，不能相信客户端传入的 seconds。
8. New API 渠道模型映射留空，否则 adapter 分不清 5s 和 10s。
9. 真实链路已通；后台已支持新增/编辑上游和模型；后续按新上游协议补对应 request handler。
```

部署在前置优化机的原因：

```txt
客户都是大陆网络。
前置机大陆可访问，本体机大陆不可访问。
adapter 需要被 New API 稳定访问，也需要后续管理页可访问。
所以 adapter 放在前置机最合适。
```

不用多个 adapter 的原因：

```txt
多服务会让部署、端口、域名、证书、日志、配置都变乱。
正确结构是单 adapter 服务，内部按 provider/model 分发。
后续接很多家视频上游，也只增加 provider 和 model 配置。
```

## 1. 目标

客户和龙虾客户端只访问：

```txt
https://api.yiyong.me
New API 用户 key
```

客户不访问 adapter 域名，不持有上游 Flash key。

视频链路：

```txt
龙虾 / U-Claw 客户端
  -> api.yiyong.me（New API，模型广场、计费、额度、日志）
    -> video-adapter.yiyong.me（前置优化机，内部 adapter）
      -> https://flash.duoyuanx.net/v1/videos（上游 Seedance）
```

## 2. 机器与域名

前置优化机：

```txt
IP: 64.90.19.251
SSH: root@64.90.19.251 -p 24851
```

adapter 域名：

```txt
video-adapter.yiyong.me A 64.90.19.251
```

New API 本体机只在渠道里访问 adapter，不对客户暴露 adapter。

## 3. 模型与计费边界

New API 模型广场暴露：

```txt
seedance-1.5-pro-1080p-5s   按次计费
seedance-1.5-pro-1080p-10s  按次计费
```

上游真实模型只有：

```txt
doubao-seedance-1-5-pro_1080p
```

固定秒数在 adapter 里强制：

```txt
seedance-1.5-pro-1080p-5s
  -> model=doubao-seedance-1-5-pro_1080p
  -> seconds=5

seedance-1.5-pro-1080p-10s
  -> model=doubao-seedance-1-5-pro_1080p
  -> seconds=10
```

New API 负责“卖什么”和扣费。adapter 负责“怎么正确交付”。不要让用户传入的 `seconds` 决定真实上游秒数。

计费规则：

```txt
New API 里视频模型按次计费字段，实际会被 seconds 参与计算。
上游当前单价：0.637 / 秒。
```

因此 New API 模型价格建议：

```txt
seedance-1.5-pro-1080p-5s   单价填 0.637
seedance-1.5-pro-1080p-10s  单价填 0.637
```

实际扣费：

```txt
5s  = 0.637 * 5  = 3.185
10s = 0.637 * 10 = 6.37
```

不要把 5s 模型直接填成 `3.185`，否则 New API 可能再次乘 seconds，导致重复扣费。

## 4. New API 渠道配置

渠道类型：

```txt
OpenAI
```

API 地址：

```txt
https://video-adapter.yiyong.me
```

不要填 `/v1`，New API 会自己拼 `/v1/videos`。

API 密钥：

```txt
adapter 生成的 uclaw_va_xxx 内部 token
```

模型：

```txt
seedance-1.5-pro-1080p-5s
seedance-1.5-pro-1080p-10s
```

模型映射：

```txt
留空
```

原因：New API 如果把两个 SKU 都映射成 `doubao-seedance-1-5-pro_1080p`，adapter 就无法区分 5s 和 10s。

New API 自带渠道测试面板没有 `/v1/videos` 端点类型。不要用自动检测判断视频渠道是否可用。视频验证以 `curl /v1/videos` 和任务日志为准。

当前你在 New API 里要保持：

```txt
渠道类型：OpenAI
渠道 API 地址：https://video-adapter.yiyong.me
渠道密钥：填 adapter token，不填 Flash 上游 key
渠道模型：seedance-1.5-pro-1080p-5s, seedance-1.5-pro-1080p-10s
模型映射：留空
模型广场：显示 5s、10s 两个 SKU
计费：两个 SKU 都按次填 0.637
```

当前你不要做：

```txt
不要把渠道 API 地址填成 https://flash.duoyuanx.net
不要把渠道 API 地址加 /v1
不要把 New API 渠道模型映射到 doubao-seedance-1-5-pro_1080p
不要把 Flash 上游 key 发给客户端
不要让龙虾客户端直连 video-adapter.yiyong.me
```

## 5. Adapter 配置文件

远端路径：

```txt
/opt/uclaw-video-adapter/config.json
```

格式：

```json
{
  "providers": {
    "flash": {
      "baseUrl": "https://flash.duoyuanx.net",
      "apiKey": "sk-..."
    }
  },
  "security": {
    "adminToken": "uclaw_admin_...",
    "adapterTokens": [
      "uclaw_va_..."
    ]
  },
  "models": {
    "seedance-1.5-pro-1080p-5s": {
      "provider": "flash",
      "upstreamModel": "doubao-seedance-1-5-pro_1080p",
      "seconds": "5",
      "size": "4:3",
      "enabled": true
    },
    "seedance-1.5-pro-1080p-10s": {
      "provider": "flash",
      "upstreamModel": "doubao-seedance-1-5-pro_1080p",
      "seconds": "10",
      "size": "4:3",
      "enabled": true
    }
  }
}
```

真实 key 不进 Git。

未来 P1 配置结构继续使用同一个文件，不引入数据库：

```json
{
  "providers": {
    "flash": {
      "type": "flash-multipart",
      "baseUrl": "https://flash.duoyuanx.net",
      "apiKey": "sk-...",
      "enabled": true
    },
    "kling": {
      "type": "openai-json",
      "baseUrl": "https://example-provider/v1",
      "apiKey": "sk-...",
      "enabled": false
    }
  },
  "models": {
    "seedance-1.5-pro-1080p-5s": {
      "provider": "flash",
      "upstreamModel": "doubao-seedance-1-5-pro_1080p",
      "fixedParams": {
        "seconds": "5",
        "size": "4:3"
      },
      "enabled": true
    }
  },
  "security": {
    "adminTokenHash": "sha256:...",
    "adapterTokens": [
      {
        "name": "new-api-prod",
        "tokenHash": "sha256:...",
        "createdAt": "2026-08-29T00:00:00.000Z",
        "enabled": true
      }
    ]
  }
}
```

当前先明文保存 token。后续必须改成 hash 存储，页面只在生成时显示一次 token。

## 6. Adapter 服务

代码入口：

```txt
u-claw-app-dev/src/server-video-adapter.js
```

远端部署目录：

```txt
/opt/uclaw-video-adapter
```

容器名：

```txt
uclaw-video-adapter
```

监听：

```txt
127.0.0.1:18808
```

OpenResty / Nginx 对外代理：

```txt
https://video-adapter.yiyong.me -> http://127.0.0.1:18808
```

线上当前文件：

```txt
/opt/uclaw-video-adapter/server.js
/opt/uclaw-video-adapter/config.json
/opt/uclaw-video-adapter/package.json
```

当前容器启动命令等价于：

```bash
docker run -d \
  --name uclaw-video-adapter \
  --restart unless-stopped \
  -p 127.0.0.1:18808:18808 \
  -v /opt/uclaw-video-adapter:/app \
  -w /app \
  -e HOST=0.0.0.0 \
  -e PORT=18808 \
  -e UCLAW_VIDEO_ADAPTER_CONFIG=/app/config.json \
  node:22-alpine \
  node server.js
```

查询容器：

```bash
ssh -p 24851 root@64.90.19.251 \
  'docker ps --filter name=uclaw-video-adapter --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
```

## 7. 访问与测试

健康检查：

```bash
curl -sS https://video-adapter.yiyong.me/health
```

管理页：

```txt
https://video-adapter.yiyong.me/admin
```

管理页需要 `adminToken`。生产建议通过 Nginx 只允许管理员 IP 访问 `/admin`。

New API 渠道测试请求：

```bash
curl -sS https://api.yiyong.me/v1/videos \
  -H 'Authorization: Bearer <new-api-user-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "seedance-1.5-pro-1080p-5s",
    "prompt": "测试视频，一只猫在雨天窗边轻轻点头",
    "size": "4:3"
  }'
```

adapter 直测：

```bash
curl -sS https://video-adapter.yiyong.me/v1/videos \
  -H 'Authorization: Bearer <adapter-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "seedance-1.5-pro-1080p-5s",
    "prompt": "测试视频，一只猫在雨天窗边轻轻点头",
    "seconds": "999"
  }'
```

即使请求传了 `seconds=999`，adapter 也必须发给上游 `seconds=5`。

已验证事实：

```txt
2026-08-29：5s 任务创建成功，并返回 completed + mp4 URL。
2026-08-29：10s 请求已打到上游，但上游余额不足，返回 insufficient_user_quota。
```

10s 验证需要先充值上游余额。

New API 端到端判断标准：

```txt
curl https://api.yiyong.me/v1/videos 返回 task_id/status，说明客户端入口通。
New API 使用日志有扣费记录，说明计费通。
adapter 日志里能看到请求打到上游，说明内部渠道通。
上游返回 completed + mp4 URL，说明真实生成通。
```

New API 后台“渠道测试”不支持视频时，不代表失败。以真实 `/v1/videos` 请求为准。

## 8. 后台管理现状

不上开源 B2B 后台。adapter 后台只做内置轻量管理页。

原因：

```txt
adapter 后台不是业务系统。
不需要 CRM/ERP/多租户权限体系。
不引入前端构建、数据库、复杂登录栈。
降低部署和维护复杂度。
```

后台入口：

```txt
GET /admin
GET /admin/config
POST /admin/provider
POST /admin/model
POST /admin/config
POST /admin/generate-token
POST /admin/test
```

登录规则：

```txt
/admin 打开后先显示登录页。
输入 admin token 后，页面用 x-admin-token 访问后台接口。
/admin/config 未带正确 token 返回 401。
```

页面布局：

```txt
顶部：当前环境、adapter 版本、配置更新时间、健康状态
左侧：Providers / Models / Security / Tests / Backups
右侧：当前页面表格和编辑抽屉
```

Providers 页面当前支持：

```txt
字段：
  name
  type
  baseUrl
  apiKey
  enabled

操作：
  新增 provider
  编辑 provider
  禁用 provider
  保存后热加载
```

Provider type 初始支持：

```txt
flash-multipart
openai-json
openai-multipart
custom-json
```

Models 页面当前支持：

```txt
字段：
  sku
  provider
  upstreamModel
  seconds
  size
  enabled

操作：
  新增模型映射
  编辑模型映射
  禁用模型
  保存后热加载
```

Seedance 示例：

```json
{
  "sku": "seedance-1.5-pro-1080p-5s",
  "provider": "flash",
  "upstreamModel": "doubao-seedance-1-5-pro_1080p",
  "fixedParams": {
    "seconds": "5",
    "size": "4:3"
  },
  "enabled": true
}
```

Security 页面：

```txt
生成 adapter token
保存 adapter token
查看 token 数量
当前 admin token 只读，不在页面显示
```

Tests 页面：

```txt
选择 SKU
输入 prompt
提交 /v1/videos
显示 task_id、状态、上游请求摘要、错误详情
支持轮询任务
```

Backups 页面：

```txt
保存配置前自动备份到 backups 目录。
页面暂不支持点击恢复。
```

## 9. 热更新逻辑

后台页面保存配置后必须热更新，不需要重启 Docker。

流程：

```txt
POST /admin/provider 或 POST /admin/model
  -> 读取旧 config
  -> 校验新 config
  -> 备份旧 config
  -> 原子写入 config.json
  -> reload 内存 config
  -> 返回新版本号和摘要
```

原子写：

```txt
写 /opt/uclaw-video-adapter/config.json.tmp
fsync
rename config.json.tmp -> config.json
```

每次保存前备份：

```txt
/opt/uclaw-video-adapter/backups/config-YYYYMMDD-HHMMSS.json
```

配置校验：

```txt
provider.name 非空且唯一
provider.type 在允许列表内
provider.baseUrl 必须是 http/https
provider.apiKey 保存时可为空，但测试时必须存在
model.sku 非空且唯一
model.provider 必须存在
model.upstreamModel 非空
fixedParams.seconds 必须是正数字符串
enabled 必须是 boolean
```

可热更新：

```txt
provider baseUrl
provider apiKey
provider enabled
model upstreamModel
model fixedParams
model enabled
adapter token
admin token
```

不可热更新：

```txt
HOST
PORT
Docker 镜像
配置文件路径
Nginx allowlist
TLS 证书
```

当前是单容器单 Node 进程，保存后内存 reload 足够。未来多副本时改成每次请求前检查 `config.json` mtime，或加内部 reload broadcast。

## 10. 多上游分发逻辑

adapter 不按模型启动多个服务。永远一个服务：

```txt
New API -> single video-adapter -> provider registry -> upstream
```

请求处理：

```txt
1. 校验 adapter token
2. 读取 body.model 作为 SKU
3. models[SKU] 找到 provider 和 fixedParams
4. providers[provider] 找到 baseUrl、apiKey、type
5. 按 provider.type 构造上游请求
6. 强制覆盖 fixedParams
7. 请求上游
8. 归一化 create/status 响应
```

关键原则：

```txt
New API 管模型广场、用户权限、额度、计费、日志。
adapter 管上游协议、模型映射、固定参数、防绕过。
客户端只访问 api.yiyong.me。
```

新增上游只加 provider 和 model 配置，不新增 adapter 服务。

## 11. 更新

本地构建后，推送单文件：

```bash
scp -P 24851 u-claw-app-dev/src/server-video-adapter.js \
  root@64.90.19.251:/opt/uclaw-video-adapter/server.js
```

重启：

```bash
ssh -p 24851 root@64.90.19.251 'docker restart uclaw-video-adapter && docker logs --tail=80 uclaw-video-adapter'
```

更新配置不需要重启。管理页保存后会热加载 `config.json`。

日常新增模型不需要发版：

```txt
1. 打开 /admin
2. 新增或编辑 provider
3. 新增或编辑 model SKU
4. 保存
5. adapter 自动备份旧 config
6. adapter 原子写新 config
7. adapter reload 内存配置
8. 用 Tests 页面或 curl 验证
```

只有改 adapter 代码逻辑时，才需要重新上传 `server.js` 并重启容器。

如果改了 Docker 启动参数：

```bash
ssh -p 24851 root@64.90.19.251 \
  'docker rm -f uclaw-video-adapter && docker run ...'
```

如果只改 Nginx：

```bash
ssh -p 24851 root@64.90.19.251 \
  'nginx -t && systemctl reload nginx'
```

## 12. 回滚

部署前备份：

```bash
ssh -p 24851 root@64.90.19.251 \
  'cp /opt/uclaw-video-adapter/server.js /opt/uclaw-video-adapter/server.js.bak.$(date +%Y%m%d%H%M%S)'
```

回滚：

```bash
ssh -p 24851 root@64.90.19.251 \
  'cp /opt/uclaw-video-adapter/server.js.bak.<timestamp> /opt/uclaw-video-adapter/server.js && docker restart uclaw-video-adapter'
```

配置回滚：

```bash
ssh -p 24851 root@64.90.19.251 \
  'cp /opt/uclaw-video-adapter/backups/config-<timestamp>.json /opt/uclaw-video-adapter/config.json'
```

配置文件回滚后，P0 需要重启容器；P1 后台恢复配置后会自动热加载。

## 13. 安全要求

必须满足：

```txt
客户只访问 api.yiyong.me
adapter token 只填在 New API 渠道
Flash 上游 key 只存在 adapter config
/admin 不对公网裸奔
adapter 域名建议只 allow New API 本体机 IP
```

本轮因为密码已经出现在会话里，部署后建议：

```txt
更换 root 密码
改 SSH key 登录
禁用密码登录
```

后续必须补齐：

```txt
admin token hash 存储
adapter token hash 存储
token 只生成时显示一次
后台配置恢复
配置变更审计日志
Nginx allowlist 保留
```

## 14. 当前已知问题

```txt
1. 当前真实请求只实现 flash-multipart。
2. openai-json、openai-multipart、custom-json 现在只能保存配置，不能真实请求。
3. admin token 和 adapter token 当前仍是明文存储。
4. 后台备份页只展示规则，暂不能点选恢复。
5. 10s 上游余额不足，待充值后复测。
```

## 15. 完成标准

当前完成标准：

```txt
[x] /admin 未登录先显示登录页
[x] provider 可新增、编辑、禁用
[x] model SKU 可新增、编辑、禁用
[x] 保存配置热更新，无需 Docker restart
[x] 保存前自动备份旧 config
[x] 配置校验失败不覆盖旧 config
[x] adapter token 可生成
[x] Flash/Seedance 5s 真实任务成功
[ ] Flash/Seedance 10s 真实任务成功
[ ] New API 使用日志扣费正确
[x] 客户端仍只访问 api.yiyong.me
```
