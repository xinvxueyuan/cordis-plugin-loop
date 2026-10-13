# @xinvxueyuan/cordis-plugin-loop

[English](#english) | 中文

DeepSeek Harness（DSH）插件：实现 `/loop` 指令 —— **立刻跑一轮**，随后按固定节奏（墙钟 cron + 抖动）或自定节奏（模型用 `loop_next` 续拍 / `loop_stop` 结束）继续，直到 7 天过期、用户停止、或被安全网叫停。

本插件复用宿主已有的 `@deepseek-ai/dsh-schedule`（持久提醒服务）承载每一条 loop：一行任务的**标题与正文**是 loop 的全部可变状态，因此 `loop_next`、`/loop stop` 与遗漏安全网都只需 `ctx.schedule.update` 就地替换同一条记录，会话内 loop 记录数在**正常路径**下恒为 1（唯一的例外是替换时旧记录删除被存储层拒绝——那时两条并存并如实告知，见[自定节奏](#自定节奏)）。

- 包名：`@xinvxueyuan/cordis-plugin-loop`
- 版本：`0.1.0`
- 依赖：`@deepseek-ai/cordis`（必需 `tools`）；`@deepseek-ai/dsh-schedule`、`@deepseek-ai/dsh-commands` 为**可选**同伴依赖

---

## 目录

- [安装与装配](#安装与装配)
- [语法](#语法)
- [节奏归一与抖动](#节奏归一与抖动)
- [loop 记录格式](#loop-记录格式)
- [固定节奏](#固定节奏)
- [自定节奏](#自定节奏)
- [遗漏安全网](#遗漏安全网)
- [停止与状态](#停止与状态)
- [默认任务文件](#默认任务文件)
- [拒绝面](#拒绝面)
- [配置](#配置)
- [与原文的偏差与边界](#与原文的偏差与边界)
- [开发](#开发)

---

## 安装与装配

```yaml
plugins:
  '@xinvxueyuan/cordis-plugin-loop': {}
```

`ctx.schedule` 缺失时插件**惰性**：不注册命令与工具，只写一条警告日志；插件 fiber 仍然 ACTIVE，绝不因为缺少可选服务而让整个 profile 起不来。

命令行表面需要 `ctx.commands`（`@deepseek-ai/dsh-commands`）。缺少它时工具照常注册，并额外写一条警告说明命令面缺失。

**两个运行期依赖（都是宿主的包）**：注入到会话里的每一轮由 `createUserMessage`（`@deepseek-ai/dsh-llm`）铸造；配置校验用 `@deepseek-ai/schemastery`（`src/config.ts` 运行期 import）。任何 DSH 安装都带这两个包（`schemastery` 同时是 `dsh-tools`/`dsh-schedule` 的依赖，`dsh-llm` 是 `dsh-schedule` 的 peer），所以不需要在 profile 里额外装配，运行期由宿主安装树解析。

`package.json` 把两者声明为**可选 peer**（`peerDependencies` + `peerDependenciesMeta.optional: true`，与本仓对 `dsh-schedule`/`dsh-commands` 的写法一致）：这样依赖关系是机器可读的，又不会在旧版 DSH 上**阻塞安装**（必需 peer 会）。

**产物的 `.d.ts` 也引用这两个包**，所以**隔离消费方的类型检查需要宿主已装它们**：`lib/index.d.ts` 有 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`，`lib/config.d.ts` 有 `import z from '@deepseek-ai/schemastery'`。隔离环境实测会报 `lib/index.d.ts … TS2307: Cannot find module '@deepseek-ai/dsh-llm'` 与 `lib/config.d.ts … TS2307: Cannot find module '@deepseek-ai/schemastery'`——这是声明缺失的表现，在本仓已通过上面的可选 peer + devDependency 表达清楚；只要宿主的 `node_modules` 可解析，消费方类型检查即通过。

---

## 语法

六种调用形式，保留字**仅在整段输入精确匹配时**生效：

| 形式 | 示例 | 行为 |
|---|---|---|
| 裸 `/loop` | `/loop` | 用默认任务文件，固定节奏 10m |
| `/loop <interval>` | `/loop 10m` | 用默认任务文件，固定节奏 10m |
| `/loop <task>` | `/loop 盯住构建队列` | **自定节奏**：初始待唤醒 = `safetyCheckSeconds` |
| `/loop <interval> <task>` | `/loop 10m 盯住构建队列` | 固定节奏 + 指定任务 |
| `/loop <task> every <interval>` | `/loop 盯住构建队列 every 10 minutes` | 同上（后缀写法） |
| `/loop status\|stop [<短id>\|all]` | `/loop status`、`/loop stop 1f0f9a3c-7d2b-4a56-9f41-0c3b7a2e5d18`、`/loop stop all` | 只读状态 / 删除记录 |

保留字规则（`status`、`stop` 大小写不敏感）：

- `status` 只在**整段输入**是 `status` 时是保留字；`status report` 是任务。
- `stop` 只在整段输入是 `stop`，或后跟 `all` / 单个标识符（`^[a-z0-9][a-z0-9:.-]*$`）时是保留字；`stop the world` 是任务。
- interval 只在**第一个 token** 完整匹配 `<数值> <单位>`（允许 `10m`、`10 m`、`10 min`、`10 minutes`、`1.5h`、`.5h`）时才被当作 interval；`every` 单独一个词是任务。

interval 单位：`s`/`sec`/`secs`/`second`/`seconds`、`m`/`min`/`mins`/`minute`/`minutes`、`h`/`hr`/`hrs`/`hour`/`hours`、`d`/`day`/`days`。

明确错误：`0m`/`30s` → `interval must be at least 1 minute`；`>31d` → `interval must be at most 31 days`；空任务且无默认任务文件 → 列出两处候选路径；inline 任务超过 `maxTaskBytes` → 指出上限并建议改用任务文件。

---

## 节奏归一与抖动

**归一规则：取最近的可用档位，平局向上。** 可用档位是一条升序阶梯：

- 分钟档：`1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30`（分钟）
- 小时档：`1, 2, 3, 4, 6, 8, 12`（小时）
- 日档：`1, 2, 3, …, 31`（天）

所以 `7m→6m`、`8m→10m`（平局向上）、`11m→12m`（平局向上）、`13m→12m`、`17m→15m`、`31m→30m`、`45m→1h`（平局向上）、`18h→1d`（平局向上）。归一后的周期也可能**略短于**请求（例如 `31m→30m`），这是"最近档位"的必然结果，确认文本会打印实际节奏。

**抖动**：`cap = floor(min(10% × 归一后周期, 900s) / 60)` 分钟；实际偏移 `o = floor(u × (cap + 1))`，`u` 由稳定指纹 `sha256(sessionId ‖ 归一周期 ‖ 任务)[0..4] / 2^32` 派生，因此 `o ∈ [0, cap]` 且**同输入恒同值**。`cap = 0` 时 `o = 0`，并在确认文本如实写明原因（见下表两行 "Jitter: 0" 的区别）。

抖动**真实生效在表达式的相位上**，不是只写进 header：`o > 0` 时分钟字段由星号步进改为显式列表。

下表是**逐档真值表**（请求区间 → 归一档位 → 存储后的规范表达式 → cap）。区间边界取相邻档位的中点，平局归上：

| 请求区间（含上界） | 归一 | 表达式（o=0，存储后规范形式） | 表达式（o>0） | cap |
|---|---|---|---|---|
| 60–89s | 1 分钟 | `* * * * *` | 不可达（cap=0） | 0 |
| 90–149s | 2 分钟 | `*/2 * * * *` | 不可达 | 0 |
| 150–209s | 3 分钟 | `*/3 * * * *` | 不可达 | 0 |
| 210–269s | 4 分钟 | `*/4 * * * *` | 不可达 | 0 |
| 270–329s | 5 分钟 | `*/5 * * * *` | 不可达 | 0 |
| 330–479s | 6 分钟 | `*/6 * * * *` | 不可达 | 0 |
| 480–659s | 10 分钟 | `*/10 * * * *` | `1-51/10 * * * *`（相位 :01/:11/…） | 1 |
| 660–809s | 12 分钟 | `*/12 * * * *` | `1-49/12 * * * *` | 1 |
| 810–1049s | 15 分钟 | `*/15 * * * *` | `1-46/15 * * * *` | 1 |
| 1050–1499s | 20 分钟 | `*/20 * * * *` | `1-41/20 * * * *` | 2 |
| 1500–2699s | 30 分钟 | `*/30 * * * *` | `1-31/30 * * * *` | 3 |
| 2700–5399s（45m–1.5h） | 1 小时 | `0 * * * *` | `o * * * *` | 6 |
| 5400–8999s（1.5–2.5h） | 2 小时 | `0 */2 * * *` | `o */2 * * *` | 12 |
| 9000–12599s（2.5–3.5h） | 3 小时 | `0 */3 * * *` | `o */3 * * *` | 15 |
| 12600–17999s（3.5–5h） | 4 小时 | `0 */4 * * *` | `o */4 * * *` | 15 |
| 18000–25199s（5–7h） | 6 小时 | `0 */6 * * *` | `o */6 * * *` | 15 |
| 25200–35999s（7–10h） | 8 小时 | `0 */8 * * *` | `o */8 * * *` | 15 |
| 36000–64799s（10–18h） | 12 小时 | `0 */12 * * *` | `o */12 * * *` | 15 |
| 64800–129599s（18h–1.5d） | 1 天（本地午夜） | `0 0 * * *` | `o 0 * * *` | 15 |
| 129600–215999s（1.5–2.5d） | 2 天 | `0 0 1-31/2 * *` | `o 0 1-31/2 * *` | 15 |
| 216000–302399s（2.5–3.5d） | 3 天 | `0 0 1-31/3 * *` | `o 0 1-31/3 * *` | 15 |
| …（每个整数天一档，边界同为中点、平局向上） | N 天 | `0 0 1-31/N * *` 或短列表（如 10 天 → `0 0 1-31/10 * *`） | `o 0 <同上> * *` | 15 |
| 2592000–2678400s（30–31d） | 30/31 天 | `0 0 1-31/30 * *`、`0 0 1 * *` | `o 0 … * *` | 15 |
| >2678400s（>31d） | **拒绝** | — | — | — |

典型断言（单测逐档覆盖）：`7m→6m`、`8m→10m`（平局）、`11m→12m`（平局）、`13m→12m`、`17m→15m`、`31m→30m`、`45m→1h`（平局）、`18h→1d`（平局）、`10d→0 0 1-31/10 * *`、`31d→0 0 1 * *`。

上表 `o` 为 `0..cap` 之间的整分钟数。`o = 0` 的两种情形在确认文本里区分：

- `Jitter: 0 (minute precision cannot express a smaller offset for this cadence; fingerprint …)` —— `cap = 0`，分精度表达不了。
- `Jitter: 0 (the fingerprint drew no offset; this cadence could carry up to N minute(s). fingerprint …)` —— `cap > 0` 但这次抽到 0。

**存储后的规范化表达式**：`dsh-schedule` 在写入时把均匀列表写成 `a-b/n`（`1,11,21,31,41,51` → `1-51/10`，`1,11,21,31` → `1-31/10`）。两者选择完全相同的分钟/日期集合，确认文本打印的是**存储后的规范形式**（`create` 的返回值），避免文档表格与落盘文本不一致。

`cron.time_zone` 永远显式传入：优先 `ctx.timeContext.timeZone`，否则取进程 IANA 时区，最后回退 `UTC`。

---

## loop 记录格式

每条 loop 是 `dsh-schedule` 的一条任务：

- `title`：`DSH /loop: <任务摘录>`（任务来自文件时是 `DSH /loop: read <路径>`），超过 120 字符截断加 `...`，便于在任务列表里区分多条 loop。
- `kind`：固定节奏是 `cron`；自定节奏是 `every`（见[自定节奏](#自定节奏)）。
- `prompt`：一行 JSON header + 正文。

header 形状（**唯一**的可解析判据）：

```
DSH_LOOP {"v":1,"owner":"<12位十六进制>","mode":"fixed|self","cadence":<秒>,"cadenceLabel":"…","fingerprint":"<16位十六进制>","jitter":<秒>,"iteration":N,"quiet":N,"omissions":N,"expiresAt":<epoch ms>,"lastRunAt":<epoch ms>,[taskFile|truncated|task]}
```

解析判据（`decodeLoopRecord`）：`prompt` 的第一行以 `DSH_LOOP ` 开头且其后是合法 JSON；**`v` 必须严格等于 1**（当前 header 修订号；缺失、`"1"`、`2`、`0`、非整数一律判为外来记录——未来修订号的字段含义不属于本版本）；`owner` 是非空字符串、`mode ∈ {fixed, self}`、`cadence`/`iteration`/`quiet`/`omissions`/`expiresAt` 是非负安全整数、`cadenceLabel`/`fingerprint` 非空；否则 `undefined`。

正文第一行是机器可读的 `round_context`，随后是这一轮的说明、任务、以及"怎么续拍 / 怎么安静 / 怎么停止"：

```
round_context: '{"loop":true,"round":2,"iteration":1,"quietStreak":0,"omissions":0,"cadence":"self-paced"}'
```

**字段语义**：`iteration` = 已经跑过的轮数（写入 header 时的值）；`quiet` = 连续被标记 quiet 的轮数；`omissions` = 已被安全网处理的遗漏次数；`expiresAt` = 本次 loop 的终点（epoch ms）；`lastRunAt` = 当前等待的起算时刻。

**边界（外来记录）**：header 缺失、JSON 损坏、`v` 不是 1、或任一字段非法的记录**不是**本插件的记录 —— `/loop status` 不列出它、`/loop stop all` 不会删除它、遗漏安全网也不碰它。判据即上面那一行，README 之外没有第二种解释。

---

## 固定节奏

1. **立刻跑一轮**：命令返回前，第一轮任务文本（`firstRoundPrompt`）已经进入会话收件箱，不需要等第一次 cron 触发。投递方式是宿主 agent 的 `followup`，它是**原型方法**（`followup(input) { this.send(input, "next-turn", true) }`），必须以接收者身份调用——本插件用 `.bind(agent)` 绑定，绝不把方法取下来裸调。
2. **原子性**：先投递第一轮、成功后才替换旧记录。若首轮投递抛错，刚创建的记录会**立即回滚删除**，命令返回失败文案（`Could not deliver the first round, so no loop was armed: <原因>`），存储回到调用前的状态：原本没有 loop → 零条；原本有 loop → 旧 loop 原样存活（id 与任务不变）。不存在「命令报失败但记录已武装」的中间态。
3. 记录是**真实 cron 表达式**且被 `canonicalizeCronExpression` 接受（集成测试断言 `canonicalizeCronExpression(expr) === expr`）。
4. 到期投递走 `dsh-schedule` 的 `[SCHEDULE REMINDER BATCH]` 框架，任务文本以 `reminders_json` 数据到达，不是指令。
5. **7 天过期**（`lifetimeDays`，默认 7）：到点后**最后跑一轮**（安全网投递一次结束说明），再删除记录。`/loop status` 打印 `expiresAt`。

`iteration` 在固定节奏下**不自增**：cron 由宿主自己触发，不重写这一行。真实轮次以 `/loop status` 打印的 `ctx.schedule.history` 回执数为准（同时披露保留窗口与条数上限，见[偏差与边界](#与原文的偏差与边界)）。

---

## 自定节奏

- 初始待唤醒 = `safetyCheckSeconds`（默认 1800 秒）。
- 记录是**周期 `every` 任务**，不是一次性任务：一次性记录被投递后会变成 `inactive`，随后 `update` 返回 `schedule_ended`、`list` 也不再返回它，模型**永远无法**重新武装它。周期记录则始终 active，`loop_next` 用 `ctx.schedule.update({ change: { kind: 'every', every_seconds } })` 就地替换同一条记录（**id 不变**，`createCalls` 不变，**正常路径下**会话内 loop 记录数恒 1 —— 替换时若旧记录删除被拒，则两条并存，见下）。
- `loop_next(seconds, reason[, quiet])`：`seconds ∈ [minNextSeconds, maxNextSeconds]`（默认 60–3600）；`quiet: true` 表示这一轮没发现需要处理的事情，`quietStreak` +1，非 quiet 轮把它归零；`omissions` 归零。
- 下一轮框架**如实**包含 `iteration` / `quietStreak` / `omissions` 与停止办法（`round_context` 行 + 散文）。
- 一个会话最多一个自定节奏 loop：新建时替换旧的。**替换以删除结果为准**：只有旧记录真的被删除（返回 `{deleted:true}`）才写 `Loop restarted (replaced N previous loop)`；若删除被拒（返回 `{deleted:false}`），改为 `Loop restarted, but N previous record(s) could not be removed and are still armed (see the log); remove them with /loop stop.` 并写一条 warn —— 此时会话里确实**并存两条记录**，绝不宣称已替换；`/loop status` 会如实列出全部记录。

---

## 遗漏安全网

在 `agent/turn-stopping`（**serial** 事件）里检测「本次投递已被 `ctx.schedule.history` 回执证实，但本轮既没有 `loop_next` 也没有 `loop_stop`」：

- **第 1 次遗漏**：把同一个记录改为 `omissionCheckSeconds`（默认 20 分钟）的等待，并把框架文本改成写明「上一轮未续拍」——`WARNING: the previous round of this loop ended without a continuation … omission 1 of 2`。
- **第 2 次遗漏**：结束 loop —— 删除记录并向会话投递最终说明（`not continued twice in a row, so it has been stopped and removed`）。
- 已续拍 / 已停止 / 没有新回执时，这一轮什么都不做（不写、不删、不打扰）。

**不影响轮次收尾**：监听器整体 `try/catch`，异常只记日志；`history` 读取失败在引擎层被吞掉并退化为"没有欠账"（不会误删 loop）。所有 loop 写入都走同一个串行队列，不会互相交错。

---

## 停止与状态

| 路径 | 行为 |
|---|---|
| `/loop status` | 列出本会话的 loop：短 id、节奏、下次触发、过期时间、真实投递数、header 里的 `iteration/quiet/omissions`、任务来源。无 loop 时明确说明 |
| `/loop stop <短id>` | 删除该记录并回报；id 不存在时明确报错并列出当前可用 id |
| `/loop stop all` / 裸 `/loop stop` | 停止本会话全部 loop 并回报条数 |
| 模型 `loop_stop(reason)` | 删除记录并回报原因；没有 loop 时是**失败调用**（`isError`），不是静默成功 |

重复停止给出明确提示（`No loop is active in this session; nothing to stop.`），不会假装成功。

短 id 是调度记录 id 去掉 `schedule-` 前缀后的原样 UUID（36 字符、含连字符），也就是 `/loop status` 每行开头显示的那个值：直接复制它即可，不必手写。

---

## 默认任务文件

优先级：`<cwd>/.dsh/loop.md` → `$DSH_HOME/loop.md`（`DSH_HOME` 未设时回退 `~/.dsh`）。

- 空文件（仅空白）**忽略**并继续尝试下一个候选。
- 超过 `maxTaskBytes`（默认 25000 字节）**按字节截断**且不切开码点，header 记 `truncated: true`。
- 两处都缺失时明确报错并列出两条候选路径。
- **真正的每轮重读**：记录里存的是**指针**（`taskFile`）+ 指令「每一轮开始前重新读取该文件，它是权威来源，可能已经变了」，不存文件内容副本；模型每轮读盘，文件改动立刻生效。

---

## 拒绝面

| 条件 | 行为 |
|---|---|
| 计划模式（`planMode.get(agent).active === true`，取自 `ctx.reflect.get('planMode', false)`） | 拒绝启动，**零记录、零 create、零 delete**，命令返回 `Plan mode is active …` |
| `config.enabled: false` | 拒绝新建，并取消本插件已有 loop；取消前把任务文本写进 `logger.warn` |
| 环境变量 `DSH_DISABLE_LOOP` | 同上（任何非 `''/0/false/off/no/n/disabled` 的取值都视为开启）；**只删除 owner 匹配的记录**，不匹配的残留需手动清除，见下 |
| `ctx.schedule` 缺失 | 插件惰性：零命令、零工具、一条警告日志，fiber 仍 ACTIVE |
| `ctx.commands` 缺失 | 工具照常注册，一条警告说明命令面缺失 |
| 子代理会话调用 `/loop`（启动/停止）| 明确拒绝 |
| 子代理会话调用 `loop_next` / `loop_stop` | 明确错误：`A subagent session has no loop of its own to continue/stop.`（即使伪造了父会话 id 也拒绝） |

**计划模式契约**：宿主 `@deepseek-ai/dsh-plan-mode` 按 **agent** 取状态——`get(agent)` 返回 `{ active }`（有待定选择时另带 `pending`），`set(agent, active)` 选择；服务本身**没有** `active` 属性。因此谓词是 `planMode.get(agentRef)?.active === true`，`agentRef` 是调用命令的那个 live agent 对象（`get` 内部走 `agent.session`）。

**服务取值方式（惰性、可选）**：插件不直接写 `ctx.get('planMode')`，而是 `optional<PlanModeLike>(ctx, 'planMode')` —— 内部是 `ctx.reflect.get('planMode', false)`（`strict = false`）并包 try/catch，取不到就返回 `undefined`。这样**没有装 plan-mode 的 profile 不会因为读服务而报错**：探测函数直接是 `undefined`，插件照常工作、不做任何拦截；装了才走上面的 `get(agent)` 谓词。`PlanModeLike` 是本插件手写的窄接口（不用宿主的类型：`@deepseek-ai/dsh-plan-mode` 只是 devDependency，把它写进 `src` 会让 `lib/index.d.ts` 引用一个消费者可能没装的包），它与宿主签名的绑定由测试侧的编译期断言负责（见下）。

拒绝位置在**任何写操作之前**：`/loop status` 仍可读，`/loop stop` 仍可停（一个已存在的 loop 必须随时可取消），但**新建**在计划模式下不触碰存储——即便 kill switch 同时开启，也是先按计划模式拒绝，不会顺手执行取消（那条路径会删记录）。

**kill switch 清理的 owner 前提**：kill switch 的取消走 `catalog()` 发现记录，但每一条都要通过 **owner 匹配**才允许删除——记录 header 里的 `owner` 前缀必须等于该 entry 所属会话的 `ownerOf(sessionId)`；不匹配的记录**只记一行 `loop: leaving <id> … alone (…): its header is not a loop record owned by that session`，不删除**（同一条规则也保护 header 损坏的外来记录与其它 writer 留下的 `DSH_LOOP` 前缀记录）。

后果必须说清楚：**会话绑定不匹配的残留 loop 不会被 `DSH_DISABLE_LOOP` 自动清除**。若这样的记录一直留着，确认文本会追加一句 `N record(s) could not be cleared automatically (owner mismatch or a failed delete) and need manual removal with /loop stop; each skipped id was logged.`（`N = 发现条数 − 实际删除条数`，因此也包括删除本身失败的记录；`N = 0` 时不出现这句）。**要清理它，需在该记录所属的会话里执行 `/loop stop`，或由维护者手动删除该 schedule 行**——kill switch 只保证「不再新建」，不保证「清空历史」。

---

## 斜杠菜单面的边界（为什么 `/loop` 没有图标与本地化文案）

这一节写给**未来的维护者与复核者**：斜杠菜单里 `/loop` 只显示一行描述、**没有图标**、**不随界面语言切换**。这不是遗漏，而是当前宿主客户端能力的边界；真正对齐需要**宿主侧的扩展点**。

机制（均已按内容锚点在宿主客户端源码中核实，不是推测）：

- 宿主客户端的 `dsh-client-ui-commands` 用**第一方硬编码表**把内置命令接到界面元素上：`BUILTINS` 是六个内置命令 → definitionId 的映射（`goal` / `plan` / `feedback` / `compact` / `permission` / `export`），`HOST_FACES` 再把内置命令映射到图标与**翻译字典键**（例如 `description.goal` = `Set or view the goal for a long-running task`）。
- 菜单行合成就是一句回退式展开：`...builtinRowFace(c, this.t) ?? { description: c.description }`（`builtinRowFace` 内部 `HOST_FACES.get(name)`，命中才有图标/本地化标签）。所以**非内置的 host 命令能拿到的只有 host 下发的 `description` 原文**——这正是本插件当前唯一能控制的部分，也就是为什么 `description` 被写成与内置同量级的短句（`Run a task now, then keep checking it on a cadence`）。
- 想从插件侧补图标/文案，三条路都不通：① `ctx.commandUi.register()` 注册的是**客户端自有命令**，贡献若与 host 命令同名会 **fail loud**——源码里是 `ui-commands: contribution /<name> collides with a host command`（客户端命令在自己的命名空间里重复也会抛 `ui-commands: duplicate contribution for /<name>`），即**明确不遮蔽**；② `ctx.commandUi.decorate()` 只改**该 host 命令被选中时的行为**——宿主决策表写明 `menu column: contribution/decorated-host → popup or action`，且 `dispatch()` 在**菜单选中**时同样先查 `decorations.get(name)`（`via: "menu"`）；它**不改行的文字与图标**；③ `input-trigger.registerSource()` 只是**往来源列表里推一行**（仅当 trigger+name 完全相同时才抛 `slash source "/<name>" is already registered`），结果是菜单里出现**两条** `/loop`，而不是把 host 那条替换掉。
- 结论：**在当前契约下**，图标与 i18n 的缺口**只能在宿主侧补**（例如让 host 描述携带可选图标/字典键，或给第三方 host 命令一个 face 扩展点）。插件侧唯一的「绕过」是**冒充某个第一方 definitionId**：`builtinCommandName` 就是一句 `Object.keys(BUILTINS).find((name) => descriptor.definitionId === BUILTINS[name])` 的相等匹配，命中即可拿到 `{ label: t(…), description: t(…), icon }`——但那会**错显别家的文案与图标**，属**错误归因而非支持路径**，本插件不走。宿主侧的扩展点已作为上游特性请求记录，不属于本插件的实现缺陷。插件侧的承诺仅限于：命令名、参数提示（`hint`）与**描述文案风格与内置命令一致**。

---

## 配置

| 键 | 默认 | 范围 | 含义 |
|---|---|---|---|
| `enabled` | `true` | boolean | 总开关；false 时拒绝新建并取消已有 loop |
| `lifetimeDays` | `7` | 1–3650 | 一次 loop 的生命周期（天） |
| `safetyCheckSeconds` | `1800` | 60–3600 | 自定节奏的初始待唤醒 |
| `omissionCheckSeconds` | `1200` | 60–3600 | 第 1 次遗漏后的安全检查等待 |
| `minNextSeconds` | `60` | 60–3600 | `loop_next` 下限 |
| `maxNextSeconds` | `3600` | 60–3600 | `loop_next` 上限 |
| `maxTaskBytes` | `25000` | 1–1000000 | **inline 任务按码点计**的上限；同时是**默认任务文件按字节计**的截断预算 |

校验失败直接抛错（不静默取默认）；`minNextSeconds > maxNextSeconds` 也拒绝。

**长度单位（两处口径不同，务必分清）**：

- **inline 任务文本按码点**（Unicode code points）：`/loop <task>` 与 `/loop <interval> <task>` 的 `task`，以及 `/loop status` 里 `task: N code points inline` 都以码点计。`String.length` 是 UTF-16 码元，一个星体字符会算 2，所以实现用 `[...text].length`；`'😀'.repeat(100)` 恰好等于 100，刚好落在 25000 的上限内。
- **默认任务文件按字节**（UTF-8 bytes）：`<cwd>/.dsh/loop.md` / `$DSH_HOME/loop.md` 超过预算时按字节截断，并退回码点边界不切开字符；header 记 `truncated: true`，框架文本要求模型自行完整读取。

两处共用一个 `maxTaskBytes` 键但单位不同，确认文本与 `/loop status` 都会显式写出单位（`code points` / `file budget: bytes`）。

---

## 与原文的偏差与边界

1. **固定节奏一律墙钟锚定 cron**：`/loop 5m` 在 :00/:05/:10… 触发，而不是"从我开始算的 5 分钟"。理由：只有墙钟 cron 能承载相位抖动；`every_seconds` 由创建时刻锚定，抖动无法生效（会变成"只写进 header 的假抖动"）。
2. **自定节奏的记录是周期 `every`，不是一次性**：一次性记录被投递后变 `inactive`、`update` 返回 `schedule_ended`、`list` 也不再返回，模型无法续拍。周期记录始终 active，`loop_next` 才能真正"替换同一条记录（id 不变、**正常路径下**数量恒 1；替换时旧记录删除被拒则两条并存并如实告知）"。代价是两条：模型不续拍时它会按**上一次的等待**再次触发；因此 `loop_next(60)` 之后如果模型连续不续拍，第 2 次遗漏可能**几乎无间隔**就被判定（两次投递只隔 60 秒）。两种情况都由遗漏安全网兜住（第 1 次补 20 分钟检查、第 2 次结束并给最终说明）。
3. **抖动口径**：`min(10% × 归一后周期, 900s)` 向下取整到整分钟，再按指纹在 `[0, cap]` 内取整分钟偏移；`cap = 0` 时归零并如实说明"分钟精度无法表达"。归一后周期可能略短于请求（如 `31m→30m`），属"最近档位"语义。
4. **日档 N≥2 用月内日列表表达**：cron 五字段无法表达"每 N 天"，`1,1+N,…` 是最优近似。当实际频率明显高于请求（偏差 >15%）时，确认文本额外打印 `Approximation: cron can only spell a day-of-month list …`；`31d` 退化为每月 1 次（`0 0 1 * *`）。
5. **固定节奏的 header `iteration` 不自增**：cron 自己触发，本插件不为装饰性计数器引入每轮持久写入与 compare-and-set 重试。真实轮次以 `/loop status` 的 `ctx.schedule.history` 回执数为准，且**披露保留上限**：`dsh-schedule` 默认只保留最近 **200 条 / 30 天窗口**（`deliveryHistoryRecords` / `deliveryHistoryDays`），更早的投递不可考，因此打印的是"窗口内 N 次"而不是精确累计值。
6. **header 用单行 JSON**（原文为人类可读一行；此处采用 JSON 以便严格解析）：格式、判据与"坏 header = 外来记录"的边界见 [loop 记录格式](#loop-记录格式)。
7. **默认任务文件是"指针 + 每轮重读"**：记录不存文件副本，只存路径与重读指令；文件超预算时截断并记 `truncated: true`，同时提示模型自己完整读。
8. **`DSH_DISABLE_LOOP` 的取值语义**：只有明确的否定拼写（`''`/`0`/`false`/`off`/`no`/`n`/`disabled`）算关闭，其它任何取值都算开启 —— kill switch 的失败方向必须是"仍然关闭"。计划模式探测是**可选**的：走 `ctx.reflect.get('planMode', false)`，取不到就不拦截（详见[拒绝面](#拒绝面)的「服务取值方式」）。

其他边界：`/loop status` 与 `stop` 只看本会话、本插件自己的记录；header 损坏的外来记录既不列出也不删除；子代理永远没有自己的 loop；固定节奏记录由 cron 自己推进，**不依赖**本进程存活到下一次触发。

---

## 开发

```bash
npm run build             # tsc -p tsconfig.build.json → lib/
npm run typecheck         # tsc --noEmit -p tsconfig.json
npm test                  # node --test（本版 117 个用例；实际数字以输出为准：假时钟 + 真实 command/tool/schedule 装配）
npm run test:integration  # node test/integration-smoke.ts（真实 1 秒级投递冒烟）
```

测试分层（**每一层的边界如实标注**）：

| 覆盖对象 | 真实度 | 位置 |
|---|---|---|
| 语法 / 节奏真值表 / 抖动 | 纯单元（假时钟） | `test/grammar.test.ts`、`test/cadence.test.ts` |
| 默认任务文件（优先级 / 空文件 / 按字节截断） | 真实文件系统（临时目录） | `test/loopfile.test.ts` |
| header 编解码 / 外来记录 / `v === 1` | 纯单元 | `test/state.test.ts` |
| 命令语义（六种形式 + 拒绝面） | 直接驱动 `src/registry.ts`，假时钟 + catalogue 形状的 double | `test/command.test.ts` |
| 命令**注册面与调用面** | **真实 `ctx.commands`（CommandRuntime）**：定义经 `normalizeDefinition` 接受，调用走 `parseCommand` + `command/run`/`command/done` 生命周期 | `test/register.test.ts` |
| 两个工具 | **真实 `ctx.tools`（ToolRuntime）**：schema 编译 + `execute` + `isError` 语义 | `test/tools.test.ts` |
| 自定节奏 / 两次遗漏 / 过期 | 引擎直调（假时钟）+ **真实 cordis 事件派发**（`ctx.emit('agent/turn-stopping')`） | `test/lifecycle.test.ts` |
| 惰性 / 计划模式 / kill switch / 时区 | **真实 `apply`**（有/无 `schedule`、有/无 `commands`） | `test/register.test.ts` |
| 记录生成与真实投递 | **真实 `@deepseek-ai/dsh-schedule` + 真实 `dsh-storage-json` 本地后端 + 真实 `dsh-tools`/`dsh-agent`**，1 秒级 one-shot 走真实 runtime 定时器 | `test/integration.test.ts`、`test/integration-smoke.ts` |

两处**刻意保留的缺口**，都留给发布前闸门：

- **真实周期投递的最短等待是 1 分钟**（`every_seconds ≥ 60`、cron 最小粒度 1 分钟），所以"周期记录被真实定时器投递 → 安全网在真实投递上判定"这条最慢的路径用**确定性 double + 真实事件派发**覆盖；真实投递本身由 1 秒级 one-shot 证明（同一 `ScheduleService`、同一条投递与回执链路）。
- **没有挂载真实的 Web 组合**（`dsh-api-session-controller` 等）：`sessionController`/`sessions` 是 stub，只实现本插件实际调用的 `resolveAgent` 与 `flush`。发布前应在真机 profile 做一次端到端手测（`/loop`、`loop_next`、`/loop stop`、kill switch）。

### 替身形状硬规则（F3）

**测试替身必须与宿主的真实形状一致**，否则「全绿」只是幻觉。本项目已经两次栽在这上面：一次是拿窄适配器当 service 用，导致 kill switch 的 catalog 查找永远失败；一次是把 agent 的**原型方法**当普通函数属性调，导致首轮投递在真机必抛而套件全绿。规则：

| 替身 | 必须的形状 | 为什么 |
|---|---|---|
| **agent** | **类实例**，`followup(input) { this.send(input, "next-turn", true) }` 与 `send` 都是**原型方法**；`caller()` 之类的「视图」用 `Object.create(agent)` 而不是对象展开 | 展开（spread）会丢掉原型方法，于是「方法被取下来裸调」这种缺陷在测试里看不见 |
| **planMode** | 实现 `get(agent)` / `set(agent, active)`。替身**类型直接取自宿主**：`type PlanModeSurface = Pick<PlanModeController, 'get' \| 'set'>`（import type 自 `@deepseek-ai/dsh-plan-mode`，已列入 devDependencies），替身写成 `interface PlanModeDouble extends PlanModeSurface { … }` 并用**显式类型标注**构造（`const double: PlanModeDouble = { … }`，不是 `satisfies`）。替身的 `get` 只返回 `{ active }`，`set` 返回 `'committed'` | 宿主没有 service 级 `active` 属性；`{ active: boolean }` 形状的替身会让恒 false 的谓词照样通过。**`pending` 是可选的**，所以替身不构造它——宿主在无待定选择时也只返回 `{ active }`；一旦宿主把 `pending` 改成必需字段、或改了 `get`/`set` 的签名，`tsc` 会立刻报错（防线实测见下） |
| **planMode（插件接缝）** | `src` 侧手写的 `PlanModeLike` 由测试侧的**编译期桥**钉住：`test/register.test.ts` 断言 `'get' extends keyof PlanModeController`、`ReturnType<PlanModeController['get']> extends 接缝状态`、`active extends boolean`、`Parameters<host get>[0] extends Parameters<接缝 get>[0]` | 接缝比宿主宽松（收 `unknown`、容许服务缺失），所以两者不是互相可赋值；每条断言各覆盖探测真正依赖的一点。宿主改签名/改名 → `tsc` 红（实测：把接缝的 `active` 改成 `string` → `error TS2322: Type 'true' is not assignable to type 'never'`）。宿主的类型**不能**引进 `src`：那是 devDependency，写进 `lib/index.d.ts` 会伤到没装它的消费者 |
| **schedule** | 真实 `ScheduleService`（集成/注册面）或实现真机形状（`catalog()` 含 `status` 与可选 `lastDelivery`、cron `scheduledAt` 由真机工厂算出）的 double | 窄替身会绕过真实发现路径与真机相位 |
| **message** | 注入的消息必须是**宿主消息**：用 `createUserMessage`（`@deepseek-ai/dsh-llm`）铸 `id`，`source.kind` 用本插件自有的 `'loop'`。替身的 `send` 校验宿主 inbox 规则：**缺 id 必须拒**，**同一待处理 id 重复注入必须抛**（宿主原文 `message "<id>" is already pending`），并提供 `settle()` 表示「这一轮已被消费、id 可复用」 | `MessageBase.id` 是宿主的必需字段，durable inbox 用它去重与定位；手搓一个没有 id 的对象字面量，第一条能进、**第二条就抛** `message "undefined" is already pending`（这正是本项目第三次栽的同类坑）。`{kind:'tool'}` 是 tool-role 的来源、且 `dsh-experimental-auto-review` 会跳过它，所以必须自报 `'loop'`（照 `dsh-schedule` 自报 `'schedule'` 的写法） |
| **失败路径** | 让替身在**真机同一点**抛错（本插件用 `host.failNextDelivery()`，错误从 `send` 内抛出；替换失败用 `double.deleteFails`，让 `delete` 返回 `{deleted:false}`） | 才能证明「投递失败 ⇒ 零 armed 记录」「替换被拒 ⇒ 不谎报 replaced」这类断言不是自说自话 |

**形状漂移防线是实测过的**，不是声明：把替身破坏两处，`npm run typecheck` 都会失败（恢复后 exit 0）——

```
# 去掉 get()
test/register.test.ts(194,9): error TS2741: Property 'get' is missing in type
  '{ gets: unknown[]; value: boolean; set(agent: unknown, next: boolean): "committed"; }'
  but required in type 'PlanModeDouble'.

# 让 get() 返回 {}
test/register.test.ts(197,5): error TS2322: Type '(agent: unknown) => {}' is not assignable
  to type '(agent: Agent) => { active: boolean; pending?: boolean | undefined; }'.
```

第二条错误信息里出现的 `{ active: boolean; pending?: boolean | undefined; }` 就是**宿主自己的签名**——这正是「替身必须与宿主真实形状一致」这条规则的机器可验证形式。

### GitHub Release 与签名

`release.yml` 只在**已存在**的 tag 上创建 Release（`gh release create --verify-tag`），tag 由维护者以 annotated + GPG 签名推送：

```bash
git tag -s v0.1.0 -m "cordis-plugin-loop 0.1.0"   # 需要配置 GPG 签名密钥
git push origin v0.1.0                            # 触发 publish.yml（staged）与 release.yml
```

随后 `npm stage publish` 进入 stage 队列，由维护者用 2FA 批准上线，`release.yml` 把 `npm pack` 的 tgz 与 `SHA256SUMS` 作为 Release 附件并附 `actions/attest-build-provenance` 来源证明；校验方式 `gh attestation verify <file> --repo xinvxueyuan/cordis-plugin-loop`。

### 发布

沿用仓库脚手架：`.github/workflows/publish.yml` 做 **staged 发布**（`npm stage publish --provenance`，OIDC 可信发布 + 人工 2FA 批准后上线；同时可发 GitHub Packages），`.github/workflows/release.yml` 生成 `npm pack` 的 tgz + `SHA256SUMS` 并附 `actions/attest-build-provenance` 来源证明。CI 只跑 `npm ci` + `npm run typecheck` + `npm test`；`npm run test:integration` 需要本机真实 runtime，因此在本地发布前手动跑。

### 发布记录：v0.1.0（2026-10-14）—— 未完成，已知阻塞见下

| 项 | 值 |
|---|---|
| tag | annotated + GPG `v0.1.0`；tag 对象 `9ae22118903dcf62bcd25c5f0031210063731623`，指向提交 `ca9cfcd72bd3fd30b3ed432a70c92bf0d2007747`；GitHub 侧 `verification.verified = true`（`reason: valid`，签名密钥 `6C6FD9B2394D19FD9CA1F247D6701FBD72B7B35A`） |
| Release | <https://github.com/xinvxueyuan/cordis-plugin-loop/releases/tag/v0.1.0>，三资产：`xinvxueyuan-cordis-plugin-loop-0.1.0.tgz`、`SHA256SUMS`、`SHA256SUMS.asc`（`.asc` 由维护者用同一把 GPG 密钥对 `SHA256SUMS` 做分离签名后附加；`release.yml` 本身只产出前两者） |
| 构建来源证明 | `actions/attest-build-provenance` 覆盖 tgz 与 SHA256SUMS；`gh attestation verify <file> --repo xinvxueyuan/cordis-plugin-loop --source-ref refs/tags/v0.1.0` 退出 0，`--source-ref refs/heads/main` 被拒（`expected SourceRepositoryRef to be refs/heads/main, got refs/tags/v0.1.0`） |
| tgz 校验 | 从 Release 下载后重算 SHA256 = `2b9ea26c288852d02f95216eb507dbbe1ce02056333b1d42f9c198acd5a76a6e`，与 `SHA256SUMS` 记录一致；`SHA256SUMS.asc` 本地 `gpg --verify` 为 Good signature |
| CI | Release run [`38431103573`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/38431103573) **success**；Publish run [`38431103637`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/38431103637) **failure** → `Stage for npm` 与 `Publish to GitHub Packages` 两个 job 因此 **skipped** |
| registry 现状 | npmjs.org：`@xinvxueyuan/cordis-plugin-loop` 为 404（**未发布、也没有 stage 队列条目**）；GitHub Packages：无该包 |

**阻塞（未解决）**：`test/loopfile.test.ts` 的两条用例——`DSH_HOME is resolved from the environment or the user home`（:91）与 `the candidate list is project first, then DSH_HOME`（:96）——断言的是 **Windows 路径语义**（期望 `C:\custom\.dsh` 与 `C:\project/.dsh/loop.md` 原样返回），在 Linux runner 上 `path.resolve` 会把 runner 的 cwd 前缀上去（实测得到 `/home/runner/work/cordis-plugin-loop/cordis-plugin-loop/C:\custom\.dsh`），于是 `npm test` 在 CI 上 115 pass / 2 fail，`publish.yml` 的 `test` job 失败、两个 `needs: test` 的发布 job 被 skip。修复方向：让这两条用例按 `path` 的平台语义构造期望值（或按平台跳过「绝对 Windows 路径原样返回」这类断言）。注意 `v0.1.0` 已随 Release 存在，**tag 不移动**，因此修复后应发**新版本号**（例如 `v0.1.1`）。

---

<a id="english"></a>
## English

`@xinvxueyuan/cordis-plugin-loop` implements DSH's `/loop`: run a task **now**, then keep it running on a fixed wall-clock cadence (cron + deterministic jitter) or a self-paced one (`loop_next` / `loop_stop`). Each loop is one durable `@deepseek-ai/dsh-schedule` task whose title and prompt carry all of its mutable state, so a continuation, a stop, and the omission safety net are all one in-place `ctx.schedule.update` — a session never owns more than one loop record.

Six call forms, wall-clock cron for every fixed cadence, nearest-step snapping with ties upward, `min(10% of the normalized period, 900s)` of jitter drawn from a stable fingerprint and expressed in the cron phase, a 7-day lifetime, a two-strike omission guard on `agent/turn-stopping`, `.dsh/loop.md` default tasks that are re-read every round through a pointer, plan-mode and kill-switch refusals, and an inert path when `ctx.schedule` is absent. See the Chinese sections above for the per-band truth table, the header format and its foreign-record boundary, the configuration table, and the deviation list.
