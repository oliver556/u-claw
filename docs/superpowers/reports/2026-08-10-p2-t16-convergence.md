# P2-T16 第二阶段自动化会合报告

## 结论

- 基线：`codex/integration-p2-t10-local@1e19eab509886ed6caf000c07d08045a481a6ba8`
- 会合分支：`codex/p2-t16-phase2-convergence`
- 代码与自动化状态：第二阶段实现缺口清零，默认门禁全绿。
- 需求证据：`39/39` 有唯一 `P2-Txx` 归属和代码/自动化证据，详见 [2026-08-10-p2-t16-requirements-map.md](./2026-08-10-p2-t16-requirements-map.md)。
- 真实环境状态：未执行真实 Windows、物理 U 盘、真实账号或真实外部服务验收；`38/39` 项保留到 `P3-T08`。`REL-006` 为已批准“不迁移”，无需真机延期。

## 环境

- macOS Darwin 25.4.0，arm64
- Node.js `24.15.0`
- npm `11.12.1`
- Go `1.26.0 darwin/arm64`
- 依赖安装：`npm ci`，退出 `0`，新增 `378` packages；使用仓库 lockfile。

## 本次闭合

### 默认并行 E2E 稳定性

Provider 390px 断言根因不是持久布局溢出。Ant Design Tooltip portal 离场动画短暂保留桌面坐标，测试在动画窗口读取 `document.documentElement.scrollWidth`，造成并行时序失败。

- RED：默认 `5 workers`、目标用例 `--repeat-each=30`，`9 failed / 21 passed`。
- 修复：保留响应式断言；改用 `expect.poll` 等待 portal 离场和布局稳定。未固定 worker 数，未删除断言。
- GREEN：相同压力配置 `30/30`。

完整套件压力运行又暴露 chat 定位歧义：工具与权限内容出现后，`getByText("Fixture ")` 同时匹配 5 个元素。

- 修复：限定最后一条 `.assistant-message` 内 `.message-content`，精确匹配 `Fixture`。
- 压测：默认 `5 workers`、目标链路 `--repeat-each=30`，`90/90`。
- 默认完整 E2E 最终候选连续三次：`44 passed (18.3s)`、`44 passed (19.0s)`、`44 passed (17.7s)`。

全量 unit 并行运行还暴露附件测试在 capability negotiation 完成前点击禁用按钮：按钮已挂载，但 `attachmentsSupported` 尚未就绪，点击被浏览器语义忽略。

- RED：`ChatWorkspace.test.tsx` 的 `clears successful attachments...` 在全量并行中失败，1 秒内找不到 `report.txt`。
- 修复：等待“添加附件”按钮进入 enabled 状态后点击，不增加全局 timeout，不修改生产行为。
- GREEN：目标用例通过；frontend 完整套件连续三次 `152/152`；最终 `npm test` 全绿。

### 生产目录与供应链边界

- SkillHub 生产启动改用 `https://api.skillhub.cn`，不再注入 fixture client。
- 免费搜索固定 `labels=pricing_type:!paid`。
- 下载限制为受信 API/COS host；禁止凭据、非 HTTPS、非预期 redirect；限制响应、ZIP、文件数、单文件和解压总大小；拒绝危险路径、symlink；校验文件清单和 SHA-256。
- ZIP 允许安全显式 directory entry，但只投影文件；download 必须绑定 search/detail 已确认的 version 与 namespace，响应身份漂移立即拒绝。
- SkillHub listing、ZIP 和最终 bundle 统一拒绝大小写等价路径、完整 Win32 设备别名（含 `CONIN$`/`CONOUT$`、superscript COM/LPT 及扩展名前空格绕过）、非法/控制字符、ADS、尾随点/空格及 file/directory ancestor conflict，防止 `skill.md` 覆盖已校验的 `SKILL.md`。
- canonical `SKILL.md` 强制 `name/description`；`slug/version` 可选。缺失时采用已验证 API 身份，冲突时拒绝。
- SkillHub 未提供可验证 permissions schema；不伪造权限精度，安装统一走高风险确认。
- 真实只读 smoke：`xiaoshan-ai@4.0.10`，ZIP `13,580 bytes`，`9 files`，入口 `SKILL.md`。
- Plugin 生产启动改用配置化 live client。`UCLAW_PLUGIN_REGISTRY_URL` 缺失时返回 typed `UNAVAILABLE`，不再注入 fixture。
- Plugin registry 缺权威远端契约与可信签名元数据；live 数据固定 `repositoryVerified=false`。允许只读 catalog/detail；install/update 在 bundle 请求前 fail-closed。UI 显示“插件仓库未验证”，不误标为 Fixture。

### MCP production adapter

- Shared client 新增独立 `McpConfigurationService`；OpenClaw Adapter 通过 `config.get` 的 valid/hash 与 `config.patch(baseHash)` CAS 写目标 `mcp.servers[id]`。
- configure/remove/start/stop 均落真实 Gateway config；stdio 映射 command/args/env，HTTP 映射 url/headers。认证配置缺 secret 时在 RPC 前返回 typed `INVALID_ARGUMENT`，不写空 header。
- Electron 生产 runtime 组合 Gateway 配置服务与 `createMcpProtocolProbe`。HTTP/streamable HTTP 可执行真实 MCP initialize/list probe并投影工具、资源、prompt 计数。
- Node stdio 使用受控 `process.execPath` 并由 child 强制 `ELECTRON_RUN_AS_NODE=1`；用户 env 不能覆盖该值。npx/python/uvx 缺少锁定 executable 映射时明确返回 `UNAVAILABLE`；真实 stdio/Windows 工具暴露仍由 `P3-T08` 验收。

### Secret scan

- 新增 `npm run test:secrets`。
- 扫描 Git tracked/index 中 UTF-8 文本；检测 PEM、AWS/GitHub/OpenAI/Slack token 和敏感字段赋值。
- 命中只输出 `path:line RULE`，不回显 secret。
- scanner 单测 `9/9`；覆盖 modern `github_pat_`；批量读取 Git stage-0 index blob，避免 staged secret 被不同 worktree 内容遮蔽；修复 placeholder substring 误放行；8 个测试 fixture 改为明确非 secret 值。

## Fresh 门禁

以下命令均在本分支运行；Node 命令使用 `24.15.0`。

| 门禁 | 结果 |
|---|---|
| `npm ci` | 退出 `0`；378 packages |
| `npm run build` | 退出 `0` |
| `npm run typecheck` | 退出 `0`；4 workspaces |
| `npm test` | 退出 `0`；root/packaging 121、contract 16、shared 245、adapter 159、desktop 462、frontend 152；合计 1155 |
| `npm run test:contract` | `16/16` |
| `npm run test:integration` | `17/17` |
| `npm run test:e2e`，默认 5 workers，连续三次 | `44/44 (18.3s)`、`44/44 (19.0s)`、`44/44 (17.7s)` |
| `node --test tests/packaging/*.test.mjs tests/windows/*.contract.test.mjs` | `26/26` |
| `npm run test:portable-launcher` | `15/15` |
| `npm run test:launcher-benchmark` | `50/50` |
| `npm run test:secrets` | 退出 `0` |
| 两个 Go module：`go test -count=1 ./...` | 均退出 `0` |
| 两个 Go module：`go test -race -count=1 ./...` | 均退出 `0` |
| 两个 Go module：`go vet ./...` | 均退出 `0` |
| 两个 Go module：`GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c ...` | 均退出 `0` |
| 两个 Go module：`GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ...` | 均退出 `0` |
| SkillHub live smoke | 退出 `0`；真实 API/COS 下载与 bundle 校验通过 |
| `git diff --cached --check` | 退出 `0` |

Go modules：`product/launcher`、`product/benchmarks/launcher/go`。交叉编译只证明 Windows amd64 可编译，不等于 Windows 真机运行通过。

## UNAVAILABLE / fail-closed 审计

扫描 production desktop/frontend/shared/adapter 路径后，剩余类别：

1. 配置缺失：Plugin registry URL、release feed/signing trust root、原生 bridge 未注入。
2. 外部 capability 缺失：Gateway 缺少必要 RPC、MCP stdio 缺少锁定 executable 或真实服务未接时，对应 adapter/probe 返回 typed `UNAVAILABLE`，不伪造成功。
3. 明确安全边界：无一致性租约时拒绝 backup/restore/factory reset；未验证 Plugin registry 允许只读 catalog/detail，但禁止 download/install/update；并发操作上限、runtime terminal failure、未知 Doctor repair action 时拒绝继续。
4. 正常运行态：离线、模型不可用、USB 缺失、连接断开、dispatcher disposed。

生产 wiring 已核对：`startElectronMain` 把 Electron `shell` 传入受控文件打开/定位服务；把 Managed Gateway stop/start 绑定一致性 coordinator；把 `client.diagnostics` 传入 Doctor adapter，并只注册 `gateway-restart` 受控 repair；把 `client.mcp` 的真实 Gateway 配置操作与 Electron MCP protocol probe 组合为 production runtime。上述是已实现的生产 adapter 与安全降级，不是由高级控制台代偿的空洞。

高级控制台仅保留显式诊断入口；功能路径不会静默降级到控制台。Plugin registry 因缺权威契约保持只读且 fail-closed，属于真实服务未接边界，不伪造已验收实现。

## P3-T08 真实环境延期

| 类别 | 延期验收 |
|---|---|
| Windows | Win10/11、缩放/暗色/无白闪、系统信息、文件锁、路径替换、安装/卸载、断电与回滚、Doctor/repair |
| 物理 U 盘 | 两台机器连续性、拔盘、盘符变化、数据/记忆/技能/插件、备份恢复、宿主残留 |
| 真实账号 | Telegram、QQ Bot、飞书、企业微信、个人微信扫码登录与消息收发 |
| 真实服务 | Provider、自定义 OpenAI-compatible、Ollama/LM Studio、代理/NO_PROXY、MCP、OpenClaw runtime、正式 release feed/证书、真实 Plugin registry |
| SkillHub | 已完成单个公开免费包 smoke；仍需 Windows/U 盘上的搜索、安装、更新、卸载和 OpenClaw 调用验收 |

详细逐项延期见 39 项映射。不得把 macOS 自动化、mock/fixture、交叉编译或单次公开 API smoke 记作上述真实环境通过。

## 冲突风险

- `product/desktop/src/main.ts`：生产 capability wiring 汇合点，和后续启动流程改动冲突风险中。
- `product/package-lock.json`、`product/desktop/package.json`：新增 `jszip`，依赖分支并行改动时冲突风险中。
- E2E 两处为局部等待/定位修复，冲突风险低。
- 报告与 secret scanner 为新增文件，冲突风险低。
