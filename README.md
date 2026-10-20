# @xinvxueyuan/cordis-plugin-loop

[English](#english) | 中文

DeepSeek Harness（DSH）插件：实现 `/loop` 指令 —— **立刻跑一轮**，随后按固定节奏（墙钟 cron + 抖动）或自定节奏（模型用 `loop_next` 续拍 / `loop_stop` 结束）继续，直到 7 天过期、用户停止、或被安全网叫停。

本插件复用宿主已有的 `@deepseek-ai/dsh-schedule`（持久提醒服务）承载每一条 loop：一行任务的**标题与正文**是 loop 的全部可变状态，因此 `loop_next`、`/loop stop` 与遗漏安全网都只需 `ctx.schedule.update` 就地替换同一条记录，会话内 loop 记录数在**正常路径**下恒为 1（唯一的例外是替换时旧记录删除被存储层拒绝——那时两条并存并如实告知，见[自定节奏](#自定节奏)）。

- 包名：`@xinvxueyuan/cordis-plugin-loop`
- 版本：`0.4.0`
- 依赖：`inject` 里的**硬依赖**是 `tools`（`@deepseek-ai/dsh-tools`）与 `schedule`（`@deepseek-ai/dsh-schedule`）；`commands`（`@deepseek-ai/dsh-commands`）是**可选（reactive）**。三个包在 `peerDependencies` 里都声明为**可选 peer**，旧版 DSH 上不阻塞安装。

---

## 目录

- [安装与装配](#安装与装配)
- [组合节点（官方）](#组合节点官方)
- [语法](#语法)
- [节奏归一与抖动](#节奏归一与抖动)
- [loop 记录格式](#loop-记录格式)
- [固定节奏](#固定节奏)
- [自定节奏](#自定节奏)
- [遗漏安全网](#遗漏安全网)
- [停止与状态](#停止与状态)
- [控制条](#控制条)
- [模型工具](#模型工具)
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

`schedule` 是 `inject` 里的**硬依赖**：真实装配下它缺失时，Cordis 会让本插件**不激活** —— 零命令、零工具、零记录，profile 照常启动（本插件起不来不会拖垮整个 profile）。

`apply` 内另保留一条**防御性惰性路径**：若某个组合强行挂载本插件而没有 `schedule`（例如覆盖 `inject`，测试 harness 正是这么挂的），它只写一条警告日志、不注册任何东西，fiber 保持 ACTIVE。两条路径都不注册任何表面，区别只在"是否激活"。

命令行表面需要 `ctx.commands`（`@deepseek-ai/dsh-commands`）。缺少它时工具照常注册，并额外写一条警告说明命令面缺失。

**两个运行期依赖（都是宿主的包）**：注入到会话里的每一轮由 `createUserMessage`（`@deepseek-ai/dsh-llm`）铸造；配置校验用 `@deepseek-ai/schemastery`（`src/config.ts` 运行期 import）。任何 DSH 安装都带这两个包（`schemastery` 同时是 `dsh-tools`/`dsh-schedule` 的依赖，`dsh-llm` 是 `dsh-schedule` 的 peer），所以不需要在 profile 里额外装配，运行期由宿主安装树解析。

`package.json` 把两者声明为**可选 peer**（`peerDependencies` + `peerDependenciesMeta.optional: true`，与本仓对 `dsh-schedule`/`dsh-commands` 的写法一致）：这样依赖关系是机器可读的，又不会在旧版 DSH 上**阻塞安装**（必需 peer 会）。

**产物的 `.d.ts` 也引用这两个包**，所以**隔离消费方的类型检查需要宿主已装它们**：`lib/index.d.ts` 有 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`，`lib/config.d.ts` 有 `import z from '@deepseek-ai/schemastery'`。隔离环境实测会报 `lib/index.d.ts … TS2307: Cannot find module '@deepseek-ai/dsh-llm'` 与 `lib/config.d.ts … TS2307: Cannot find module '@deepseek-ai/schemastery'`——这是声明缺失的表现，在本仓已通过上面的可选 peer + devDependency 表达清楚；只要宿主的 `node_modules` 可解析，消费方类型检查即通过。

---

## 组合节点（官方）

本包以**官方 bundle 形态**发布：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 用一行 Loader entry（`id: loop`，`name` 为本包名）把它装进 profile。既然是 bundle，它消费的**官方服务节点**就必须在 patch 里显式声明，装载顺序才是确定的，而不是靠“服务碰巧先到”：

| 服务键 | 官方提供方（row / 包） | 必需性 | 用途 |
|---|---|---|---|
| `tools` | row `tools` / `@deepseek-ai/dsh-tools` | 必需 | 注册 `loop_*` 工具 |
| `schedule` | row `schedule` / `@deepseek-ai/dsh-schedule` | 必需 | 记录与投递轮次 |
| `commands` | row `commands` / `@deepseek-ai/dsh-commands` | **可选（reactive）** | 注册 `/loop`；缺它时插件仍激活但无 `/loop` |

- **`tools` 与 `schedule` 是硬依赖**：patch 的 `inject: [tools, schedule]` 与 `src/index.ts` 的 `export const inject = ['tools', 'schedule']` 一致，插件会等这两个服务就绪再 `apply`；缺任一个时不会在半装配状态先跑起来。
- **`commands` 故意不进 `inject`**：命令面是可选的，`src/index.ts:316` 用 `ctx.inject(['commands'], …)` **反应式**注册——命令注册表晚到也能在不需要重载的情况下拿到 `/loop`；没有它时插件照常激活，只写一条警告。
- **patch 与 `src/index.ts` 的 `inject` 必须一致**：前者决定 Loader 的装载顺序，后者决定 Cordis 的服务注入，两者是同一份事实的两处投影。`test/manifest.test.ts` 用两条正则分别从 patch 与源码提取名单并断言**集合相等**，任何一侧单独漂移都会让 `npm test` 红——所以改一处必须同时改另一处。

---

## 语法

七种调用形式，保留字**仅在整段输入精确匹配时**生效：

| 形式 | 示例 | 行为 |
|---|---|---|
| 裸 `/loop` | `/loop` | 用默认任务文件，固定节奏 10m |
| `/loop <interval>` | `/loop 10m` | 用默认任务文件，固定节奏 10m |
| `/loop <task>` | `/loop 盯住构建队列` | **自定节奏**：初始待唤醒 = `safetyCheckSeconds` |
| `/loop <interval> <task>` | `/loop 10m 盯住构建队列` | 固定节奏 + 指定任务 |
| `/loop <task> every <interval>` | `/loop 盯住构建队列 every 10 minutes` | 同上（后缀写法） |
| `/loop status\|stop [<短id>\|all]` | `/loop status`、`/loop stop 1f0f9a3c-7d2b-4a56-9f41-0c3b7a2e5d18`、`/loop stop all` | 只读状态 / 删除记录 |
| `/loop next` | `/loop next` | **立刻投递一轮**（用户与模型起的 loop 都可用；固定节奏只投递这一轮、**不改写墙钟计时**，下一轮仍按原 cron 触发） |

保留字规则（`status`、`stop` 大小写不敏感）：

- `status` 只在**整段输入**是 `status` 时是保留字；`status report` 是任务。
- `stop` 只在整段输入是 `stop`，或后跟 `all` / 单个标识符（`^[a-z0-9][a-z0-9:.-]*$`）时是保留字；`stop the world` 是任务。
- interval 只在**第一个 token** 完整匹配 `<数值> <单位>`（允许 `10m`、`10 m`、`10 min`、`10 minutes`、`1.5h`、`.5h`）时才被当作 interval；`every` 单独一个词是任务。

interval 单位：`s`/`sec`/`secs`/`second`/`seconds`、`m`/`min`/`mins`/`minute`/`minutes`、`h`/`hr`/`hrs`/`hour`/`hours`、`d`/`day`/`days`。

明确错误：`0m` → `interval must be a positive duration`（零时长不是时长，与"太短"是两回事）；`30s` → `interval must be at least 1 minute`；`>31d` → `interval must be at most 31 days`；空任务且无默认任务文件 → 列出两处候选路径；inline 任务超过 `maxTaskBytes` → 指出上限并建议改用任务文件。

### 只预览不落地：`/loop --dry-run`

`--dry-run` 是**前置标志**：只在**第一个 token 且精确等于** `--dry-run` 时被剥离；`/loop 10m check the --dry-run flag` 里的那个词是**任务文本**，不会被吞（同一条规则也适用于 `loop_start` 的 `dryRun`）。

```text
/loop --dry-run                      # 预览裸 /loop 形态（默认任务文件 + 10m 固定档）
/loop --dry-run 10m                  # 预览固定档
/loop --dry-run 盯住构建队列          # 预览自定档
/loop --dry-run 10m 盯住构建队列      # 预览固定档 + 指定任务
```

预览文本的标签与顺序是固定契约（缺项不打印，且**绝不打印 `Id:`**——此刻没有记录）：

```text
Loop preview (nothing was armed):
Mode: …
Cron: …            （仅固定档）
Jitter: …          （仅固定档）
First fire: …      （仅固定档）/ First wait: …（自定档）
Expires: …
Round limit: …
Task: …
Title: …
Would replace: …   （仅当本会话已有 loop）
Blockers: none     （无条件时恰好一行；否则**每个条件各占一行**）
This was a preview: no record was created and no round was delivered.
```

**`Blockers:` 是唯一可能重复的标签**：无条件时是单行 `Blockers: none`；有 N 个条件时就是 N 行，每行一个条件，**顺序与真实启动的求值顺序一致**（子代理 → 计划模式 → kill switch → `config.enabled`）——所以首行就是"真启动最先撞上的那条"拒绝。与真实启动不同的是：`startLoop` 撞到第一条就返回，预览**把全部条件都报出来**（这正是预览值得读的地方），且无论如何都不写。

`--dry-run` 与 `status`/`next`/`stop` 组合会被拒绝，文案固定：

```text
--dry-run previews starting a loop; it cannot be combined with status, next or stop. Run /loop --dry-run <interval> [<task>] instead.
```

**预览是只读的，因此在"起不了 loop"的条件下依然允许执行**——计划模式、子代理会话、kill switch（`DSH_DISABLE_LOOP`）、`config.enabled: false`。此时返回 `ok: true`，并把条件逐条列进 `Blockers:`，**不做任何写操作**（不 `create`、不 `delete`、不做全局 `catalog()` 扫描）。这正是本功能的价值点：先看清会发生什么，再决定要不要起。

请求本身**描述不出一个 loop** 时才是失败（`ok: false`），且用的是真实路径**同一句**拒绝：缺任务（`missingTaskMessage`）、任务超长、非法间隔（`0m`/`30s`/`>31d`）、工具 `cadence: "fixed"` 但缺 `seconds`。

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
| `/loop next` | **立刻投递一轮**并回报；固定节奏的记录计时**不被改写**（下一轮仍按原 cron），自定节奏的记录重锚到 60s |
| 模型 `loop_start(cadence, task, dryRun?)` | 起一个 loop，**与 `/loop` 共享同一实现**（`startLoop`）；回执写明 `[agent]`、真实落盘节奏与轮数上限。`dryRun: true` 时**只预览、不落地**（见[模型工具](#模型工具)） |
| 模型 `loop_status()` | 只读返回六字段（`active`/`mode`/`cadence`/`nextAt`/`round`/`startedBy`），与 `/loop status` **同源** |
| 控制条「停止」/「立即下一轮」 | 走 `ctx.remote.commands.execute(sessionId, '/loop stop'\|'/loop next', [])`，即**上面这些命令本身**（不是第二条实现） |

重复停止给出明确提示（`No loop is active in this session; nothing to stop.`），不会假装成功。

短 id 是调度记录 id 去掉 `schedule-` 前缀后的原样 UUID（36 字符、含连字符），也就是 `/loop status` 每行开头显示的那个值：直接复制它即可，不必手写。

---

## 控制条

**位置**：输入框上方的 `conversation.input.dock` 座位（宿主对该座位的官方措辞是 "Full-width entries above the composer card"），id=`loop`、order=5，排在 `todo`(0) 与 `goal`(10) 之间、`queue`(20) 之前。

**它显示什么**：节奏（固定档打印归一后的墙钟节奏，自定档打印"每轮重定"）、下一轮倒计时（每秒重算）、轮次（`round`）、发起者（`你发起` / `模型发起`）。**没有活动 loop 时整块隐藏**——一个空控制条只会占地方。

**它的两个操作**：

| 按钮 | 走什么 | 效果 |
|---|---|---|
| 「停止」 | `ctx.remote.commands.execute(sessionId, '/loop stop', [])` | 与手打 `/loop stop` 完全相同：删除本会话记录并回报 |
| 「立即下一轮」 | `ctx.remote.commands.execute(sessionId, '/loop next', [])` | 与手打 `/loop next` 完全相同：立刻投递一轮；固定节奏**不改写**墙钟计时 |

按钮不是第二条实现：它发的是**同一批命令**，因此拒绝面（子代理、kill switch、参数校验）与手打命令逐字一致。命令失败时控制条**原样显示**宿主回的文本（`message (code)`），不吞错。

**观感（0.2.1 起与 `/goal` 同级）**：控制条现在是**卡片容器 + 图标按钮**，直接照抄本页 `/goal` 卡片的视觉配方——36px 卡片、`--dsw-radius-md`、`--dsw-elevation-panel`（描边色 `--dsw-alias-border-l1`）、底色 `--dsw-specific-menu` + 菜单背景滤镜、`padding: 4px 5px 4px 12px`、`gap: 10px`；结构为 `dock > bar > 字形 + 第 N 轮 + 读数行 + 两个 28×28 圆形图标按钮`（内联 SVG，各带 `title` 与 `aria-label`）。同页并排实测（scratch 会话同时挂 `/goal` 与 `/loop`）：圆角 12px、阴影逐字相同、`padding`/`height`/`gap`/`border-width`/`display` 全同、字形与文字尺寸全同、按钮 `28×28`/`999px`/`border 0`/`padding 0` 全同、**两卡同宽 896px**（composer 928px 未受挤压）。0.2.0 时它还是一行朴素控制条，视觉对齐是本版（0.2.1）的内容。

两处**如实记录的小差异**（不影响同级观感）：

1. `/goal` 用自身 `.bar::before` + `isolation` 承载底色与模糊，控制条用**自身计算值**达到同样的视觉效果（实测计算值一致：`rgba(67,69,74,0.45)` + `blur(40px) saturate(1.5)`）。
2. `/goal` 的图标按钮带 Chrome 专有的 `corner-shape: round`，控制条**没有复制**这一条；`border-radius: 999px` 本身仍渲染为正圆。

**主题 token**：控制条共引用 **14 个**——**11 个真 `--dsw-*` 主题 token** + **3 个 `--dsh-composer-*` 布局量**（后者的定义包与准入理由逐条写在 `test/client-capsule.test.ts` 的 `LAYOUT_TOKEN_ALLOWLIST` 里）。不存在的 `--dsh-*` 假 token 与 `var(--x, fallback)` 都由守卫拦住（含变异自检）。

---

## 模型工具

模型可以自己起 loop，不必等人在输入框打字。四个工具与 `/loop` **共享同一实现**（`startLoop`），零复制逻辑：

| 工具 | 参数 | 行为 |
|---|---|---|
| `loop_start` | `task`、`cadence`（`fixed`/`self`）、`seconds`（固定档）、`dryRun`（只预览） | 立刻投递第 1 轮并武装节奏；回执写明 `[agent]`、真实落盘节奏与轮数上限。`dryRun: true` 时只预览、不落地 |
| `loop_status` | 无 | 只读六字段 `{active, mode, cadence, nextAt, round, startedBy}`，与 `/loop status`、与会话投影**同源**（`loopFactsOf`）；`nextAt` 可空且**总是返回该键** |
| `loop_next` | `seconds`、`reason` | 续拍（自定节奏）；固定节奏会被明确拒绝并说明理由 |
| `loop_stop` | `reason` | 停止并回报原因；没有 loop 时是**失败调用**（`isError`） |

**没有 `rounds` 参数**：轮数上限由配置 `maxRounds`（默认 24）决定，**工具不能按次覆盖**——一个能被调用方随手抬高的上限不是上限。要改上限就改 profile 配置。

**`dryRun: true` 的规则写在参数描述里**（工具 description 只加一句指针，不重复）：预览是**成功调用**（`isError` 不置位），文本首行 `Loop preview (nothing was armed):`、末行 `This was a preview: no record was created and no round was delivered.`，**不创建记录、不投递任何一轮**。它在计划模式 / 子代理 / kill switch / `config.enabled: false` 下**依然可用**，把这些条件列进 `Blockers:`；请求本身描述不出 loop 时才是失败调用，用与真实启动**同一句**拒绝。工具路径的 `Title:` 带 `[agent] ` 前缀，与真实 `loop_start` 落盘记录的标题逐字一致。

**轮数上限**：`loop_start` 起的 loop 与 `/loop` 起的一样受 `maxRounds`（默认 24）约束——达到上限由守卫结束该 loop，并把 `round-limit` 事件与最终说明写进会话。上限、7 天生命周期、两次遗漏是**三条独立**的结束路径，互不掩盖。

**子代理边界**：子代理会话**不能起/停/续** loop（宿主设计如此），`loop_start`/`loop_stop`/`loop_next` 都会明确报错；**只读**的 `loop_status` 与 `/loop status` **不设拒绝**——读是安全的，持父会话 id 的子代理需要它查看父会话状态（源码注释见 `src/registry.ts`）；子代理以自己会话读时如实得到"本会话没有 loop"。`/loop --dry-run` 与 `loop_start({dryRun:true})` 同样放行：它只描述、不落地。

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
| `ctx.schedule` 缺失 | **真实装配：不激活**（`inject` 硬依赖 ⇒ 零命令、零工具、零记录，profile 照常启动）；若组合覆盖 `inject` 强行挂载，则走 `apply` 的防御性惰性路径：零命令、零工具、一条警告日志，fiber 仍 ACTIVE |
| `ctx.commands` 缺失 | 工具照常注册，一条警告说明命令面缺失 |
| 子代理会话调用 `/loop`（启动/停止）| 明确拒绝 |
| 子代理会话调用 `loop_next` / `loop_stop` | 明确错误：`A subagent session has no loop of its own to continue/stop.`（即使伪造了父会话 id 也拒绝） |
| 子代理会话调用 `loop_status` / `/loop status` | **不拒绝**：读是安全的，持父会话 id 的子代理需要它查看父会话状态（依据源码注释 `src/registry.ts`）；以自己会话读时如实得到"本会话没有 loop" |
| 子代理会话调用 `/loop --dry-run` / `loop_start({dryRun:true})` | **不拒绝**：预览只描述、不落地，条件列进 `Blockers:` |
| `--dry-run` 在计划模式 / 子代理 / kill switch / `config.enabled: false` 下 | **允许执行**（只读），把这些条件逐条列进 `Blockers:`；**零 create、零 delete、零全局 `catalog()` 扫描** |
| `--dry-run` 与 `status` / `next` / `stop` 组合 | 拒绝，文案固定（见[语法](#只预览不落地loop---dry-run)） |

**计划模式契约**：宿主 `@deepseek-ai/dsh-plan-mode` 按 **agent** 取状态——`get(agent)` 返回 `{ active }`（有待定选择时另带 `pending`），`set(agent, active)` 选择；服务本身**没有** `active` 属性。因此谓词是 `planMode.get(agentRef)?.active === true`，`agentRef` 是调用命令的那个 live agent 对象（`get` 内部走 `agent.session`）。

**为什么不改用会话投影绕过隔离（已按本 profile 的挂载形态实测）**：plan-mode 自己会注册一个会话投影 `plan`（`dsh-plan-mode/lib/index.js:179` 的 `ctx.sessionProjections.register(planProjectionDefinition)`，视图 `{ active, pending }`），而支撑服务 `session-projection` 在根层是启用的——看上去像一条能绕开隔离的路。实测结论是**不可行**，但机制比上一版写的更细，必须分两种作用域形态说清楚（`ctx.isolate` 的语义是**按服务名**隔离，不是「作用域一定有自己的实例」）：

| 形态 | `ctx.sessionProjections` 解析到 | 登记表 | 从该作用域 `provide` 覆盖 |
|---|---|---|---|
| 子作用域**未**隔离该服务名（本 profile 的形态：`include:session-projection` 已在根层） | 与根层**同一张登记表**（实测 `shared registrations table: true`） | 共享 | **被拒**：`service "sessionProjections" has been registered at <SessionProjectionRegistry>` |
| 子作用域**隔离了**该服务名 | 自己的实例（`scope resolves to the ROOT instance: false`、`shared registrations table: false`） | 独立 | 接受（覆盖只在该作用域内生效） |

- 我上一版写的「作用域会得到自己的实例／根层登记表仍为空」只在不存在的隔离形态下成立，**已按实测改正**（见上表；两种形态我都跑了，原始输出在 t24 的证据里）。
- 但**结论不变**，因为起决定作用的是**服务键**而不是登记表：在两种形态下 `root sees the planMode service: false` 都成立——plan-mode 作为 isolate 存在于各 preset 组，根层**既没有 `planMode` 服务，也没有它的 fiber**，所以它不会替根层注册任何东西（`root registrations AFTER scoped plan-mode mount: []`；我在此环境里也无法让 plan-mode 在作用域内激活：`plan-mode fiber state in scope: 0`，因为它的依赖在真实的 preset 组里，不在探针上下文里）。
- 读 API 的形状同样决定了必须防御式调用：`snapshot(session, ['plan'])` 需要真实会话日志（对没有事件日志的会话抛 `SessionSeq must be a non-negative safe integer, got NaN`）；`cachedSnapshot(session, ['plan'])` 与 `stateOf(session, 'plan')` 在 key 未注册时都返回 `undefined`。
- 结论：`planMode.get(agent)?.active === true` 仍是正确且够用的探测器——plan-mode 与插件**同作用域**时它生效（计划模式下零 create、零 delete），plan-mode 在别的 preset 组、或宿主根本没装 plan-mode 时它只是取不到 → **不拦截**（有意的降级，不是遗漏）。要让拒绝在根层真正可行使，需要**宿主侧**把 plan-mode 组合到根层（配置问题），或给插件一个跨隔离的读取扩展点（上游特性请求）。
- 遗留不确定（诚实记录）：若将来某个 preset 组**激活** plan-mode 且该组**未**隔离 `sessionProjections`，则它那条 `register(...)` 会落到共享（根层）登记表，`plan` 键就可能被根层读到。我在此环境无法激活它来验证这一点，所以**不**据它改写行为（不写投机代码）；届时应重跑上表两组对照再决定是否改用它。

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
| `maxRounds` | `24` | 1–100000 | **轮数上限**：用户起的与模型起的 loop 都适用；达到上限由守卫结束该 loop 并如实说明（见[与原文的偏差与边界](#与原文的偏差与边界)第 9 条） |
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
9. **轮数上限的两条诚实边界**：① 上限**只在守卫能读到回执时执行**——`agent/turn-stopping` 是计数入口，若该事件没有发生（例如会话在轮中被中断），上限不会当场生效，要等下一次有回执的收尾才结算；「立即下一轮」按钮轮**计入**上限（V1：预算评估已移到"零回执早退"之前），但计数依据仍是**回执**而不是按钮次数。② `maxRounds > 10000` 时回执读取会报 `truncated`，此时**按下界执行**（宁可少算也不漏停），回执文本会如实写出这一点。
10. **固定节奏下未按按钮时，注入头可能重复上一轮号**（V2，v0.1.x 既有偏差）：固定档记录的存储 prompt 只在 `loop_next` /「立即下一轮」时重写，cron 自己触发的那几轮沿用上一次写入的 `iteration`，于是真机可能看到"头里写 2、投影已经是 3"。**投影 / `loop_status` 才是诚实值**（按 `ctx.schedule.history` 回执算），头里的 `iteration` 只作提示。
11. **自定节奏 loop 的首次到期投递携带起 loop 时渲染的 prompt**：记录存的是指针 + 每轮重读指令，但**第一次到期投递**用的是创建时已渲染好的那份 prompt；任务文件在那之后改动，从**第二次**投递起才反映（默认任务文件的每轮重读不受影响——这是"首次"这一格的边界）。
12. **会话投影的推送边界**：`@deepseek-ai/dsh-session-projection` 只在 **state 与 wire view 引用同时变化**时推帧。因此投影值必须**按镜像 `revision` 重建**（每次变更换一个新对象）；"只给 state 加一个 revision 字段"不够——wire 侧看不到引用变化就不会推。0.2.0 的 `loop` 投影按这条实现（真 registry 实测）。
13. **重启后的投影自愈延迟（V5-3）**：宿主重启后，**未被本实例服务过**的会话即使存储里有它的 loop，投影仍会读到 NO_LOOP，直到该会话发生一次带 sessionId 的入队活动（turn 结束 / 命令 / 工具调用）。控制条因此**最多延迟一个周期**才显示，之后自愈。
14. **已知宿主限制：子代理会话的 client inspect 会被拒**。在子代理会话里对 `client/Slots`、`client/Builtin`、`client/Theme` 发 inspect 查询会被 `session/agent-busy: … owned by subagent routing` 拒绝（或 10 秒超时）。**真实浏览器 DOM 不受此限** ⇒ 需要活体取证时用页面 DOM（控制条自己渲染的 `data-dsh-loop-state` / `data-dsh-loop-active` 就是为此留的锚），不要据此判定"控制条没挂上"。
15. **预览（`--dry-run`）的四条诚实边界**，全部写在预览文本里：
    ① **`Cron:` 是 requested form，不是持久文本**：`dsh-schedule` 落盘时会把均匀列表规范化为 `a-b/n`（`src/cadence.ts:194-197` 的注释），所以那一行明写"the durable text is the create return value, not this line"；预览绝不声称自己打印的是持久文本。
    ② **不编造首次触发时刻**：精确时刻来自 `create()` 返回的 `scheduledAt`（`src/engine.ts`），预览拿不到。固定档只给规则与确定性抖动偏移，`First fire:` 一行明写"not knowable before the record exists"；自定档的首次等待是可知的（`safetyCheckSeconds`），照给。
    ③ **`Would replace:` 依赖一次读**：读到就列条数与短 id；**读失败时如实写"could not be read, so this preview cannot confirm what would be replaced"**，绝不写成"干净"（把读不到当成没有，是这类预览最容易犯的谎）。
    ④ **`Expires:` 用 `if started now` 限定**：预览与真实启动不是同一瞬间，所以能对齐的是**生命周期长度**（`lifetime N days`），不是绝对时刻；文本按此措辞。

其他边界：`/loop status` 与 `stop` 只看本会话、本插件自己的记录；header 损坏的外来记录既不列出也不删除；子代理永远没有自己的 loop；固定节奏记录由 cron 自己推进，**不依赖**本进程存活到下一次触发。

---

## 开发

```bash
npm run build             # tsc -p tsconfig.build.json → lib/
npm run typecheck         # tsc --noEmit -p tsconfig.json
npm test                  # node --test（本版 217 个用例 / 10 suites；实际数字以输出为准：假时钟 + 真实 command/tool/schedule 装配）
npm run test:integration  # node test/integration-smoke.ts（真实 1 秒级投递冒烟）
npm run test:smoke:client # node test/client-live-smoke.ts（真 client.js 字节 + 真命令 runtime + 真工具 registry）
```

**主题 token 对账（可选，建议发布前跑一次）**：`test/client-capsule.test.ts` 冻结了 403 个主题 token 名做守卫，只有设了 `DSH_THEME_CLIENT` 时才与**实际安装的主题**对账。发布前顺手跑一次，主题改名会让守卫**指名道姓**地红：

```bash
DSH_THEME_CLIENT="<profiles>/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js" \
  node --test test/client-capsule.test.ts
```

测试分层（**每一层的边界如实标注**）：

| 覆盖对象 | 真实度 | 位置 |
|---|---|---|
| 语法 / 节奏真值表 / 抖动 | 纯单元（假时钟） | `test/grammar.test.ts`、`test/cadence.test.ts` |
| 默认任务文件（优先级 / 空文件 / 按字节截断） | 真实文件系统（临时目录） | `test/loopfile.test.ts` |
| **平台中立守卫**（全测试集扫描：盘符字面量、模板字符串、正斜杠盘符） | 纯静态扫描（读 `test/*.ts` 源码，先屏蔽注释）+ 三种漏报形态与六种合法形态的自样本用例 | `test/platform-neutral.test.ts`（已列入 `npm test`；变异证明：把 Windows 期望注回 → `npm test` 120/121 红并指出该行） |
| header 编解码 / 外来记录 / `v === 1` | 纯单元 | `test/state.test.ts` |
| 命令语义（七种形式 + `--dry-run` + 拒绝面） | 直接驱动 `src/registry.ts`，假时钟 + catalogue 形状的 double | `test/command.test.ts` |
| **预览（`--dry-run` / `dryRun`）**：标志文法、零副作用计数、**防漂移**（预览文本逐字段 vs 真实落盘记录解码值，命令面与工具面各一条）、Blockers 全表、`Would replace:` 读失败、**投影零 revision / 零推帧**、真实 `ScheduleService` 上 `catalog()` 行数与投递窗口 | 假时钟 double（精确计数）+ **真实 `@deepseek-ai/dsh-schedule` + 真实 JSON 存储** + **真实 `@deepseek-ai/dsh-session-projection`** | `test/preview.test.ts`（已列入 `npm test`） |
| 命令**注册面与调用面** | **真实 `ctx.commands`（CommandRuntime）**：定义经 `normalizeDefinition` 接受，调用走 `parseCommand` + `command/run`/`command/done` 生命周期 | `test/register.test.ts` |
| 两个工具 | **真实 `ctx.tools`（ToolRuntime）**：schema 编译 + `execute` + `isError` 语义 | `test/tools.test.ts` |
| 自定节奏 / 两次遗漏 / 过期 | 引擎直调（假时钟）+ **真实 cordis 事件派发**（`ctx.emit('agent/turn-stopping')`） | `test/lifecycle.test.ts` |
| 惰性 / 计划模式 / kill switch / 时区 | **真实 `apply`**（有/无 `schedule`、有/无 `commands`） | `test/register.test.ts` |
| 记录生成与真实投递 | **真实 `@deepseek-ai/dsh-schedule` + 真实 `dsh-storage-json` 本地后端 + 真实 `dsh-tools`/`dsh-agent`**，1 秒级 one-shot 走真实 runtime 定时器 | `test/integration.test.ts`、`test/integration-smoke.ts` |
| **客户端半（控制条）** | 真跑 `client.js` 字节：假 `window.__ModuleLoader__` + React 桩 + 共享 hook 槽；断言注册项 `{id:'loop',order:5}`、座位注入、读数逐字段、按钮的**真实调用参数**、zh/en 键集一致、主题 token 守卫（含变异自检） | `test/client-capsule.test.ts` |
| **控制条 → 命令的真实通路** | 真 registry + 真命令 runtime + 真工具 registry + 真 `client.js` 字节（仅 `ctx.schedule` 为 double） | `test/client-live-path.test.ts`、`test/client-live-smoke.ts` |
| 投影变更 feed | 真 `@deepseek-ai/dsh-session-projection` 注册表 | `test/projection-smoke.ts` |

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

### 发布记录：v0.1.0（2026-10-14）—— npm 侧被 skip（该缺口保留，修复版见 v0.1.1）

| 项 | 值 |
|---|---|
| tag | annotated + GPG `v0.1.0`；tag 对象 `9ae22118903dcf62bcd25c5f0031210063731623`，指向提交 `ca9cfcd72bd3fd30b3ed432a70c92bf0d2007747`；GitHub 侧 `verification.verified = true`（`reason: valid`，签名密钥 `6C6FD9B2394D19FD9CA1F247D6701FBD72B7B35A`） |
| Release | <https://github.com/xinvxueyuan/cordis-plugin-loop/releases/tag/v0.1.0>，三资产：`xinvxueyuan-cordis-plugin-loop-0.1.0.tgz`、`SHA256SUMS`、`SHA256SUMS.asc`（`.asc` 由维护者用同一把 GPG 密钥对 `SHA256SUMS` 做分离签名后附加；`release.yml` 本身只产出前两者） |
| 构建来源证明 | `actions/attest-build-provenance` 覆盖 tgz 与 SHA256SUMS；`gh attestation verify <file> --repo xinvxueyuan/cordis-plugin-loop --source-ref refs/tags/v0.1.0` 退出 0，`--source-ref refs/heads/main` 被拒（`expected SourceRepositoryRef to be refs/heads/main, got refs/tags/v0.1.0`） |
| tgz 校验 | 从 Release 下载后重算 SHA256 = `2b9ea26c288852d02f95216eb507dbbe1ce02056333b1d42f9c198acd5a76a6e`，与 `SHA256SUMS` 记录一致；`SHA256SUMS.asc` 本地 `gpg --verify` 为 Good signature |
| CI | Release run [`38431103573`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/38431103573) **success**；Publish run [`38431103637`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/38431103637) **failure** → `Stage for npm` 与 `Publish to GitHub Packages` 两个 job 因此 **skipped** |
| registry 现状 | npmjs.org：`@xinvxueyuan/cordis-plugin-loop` 为 404（**未发布、也没有 stage 队列条目**）；GitHub Packages：无该包 |

**阻塞（已在 v0.1.1 修复）**：`test/loopfile.test.ts` 的两条用例——`DSH_HOME is resolved from the environment or the user home`（:91）与 `the candidate list is project first, then DSH_HOME`（:96）——断言的是 **Windows 路径语义**（期望 `C:\custom\.dsh` 与 `C:\project/.dsh/loop.md` 原样返回），在 Linux runner 上 `path.resolve` 会把 runner 的 cwd 前缀上去（实测得到 `/home/runner/work/cordis-plugin-loop/cordis-plugin-loop/C:\custom\.dsh`），于是 `npm test` 在 CI 上 115 pass / 2 fail，`publish.yml` 的 `test` job 失败、两个 `needs: test` 的发布 job 被 skip。注意 `v0.1.0` 已随 Release 存在，**tag 不移动**，因此修复走新版本号（见下）。**该 npm 侧缺口因此从未补上：v0.1.0 在 npmjs 与 GitHub Packages 上都不存在。**

### 发布记录：v0.1.1（2026-10-14）—— **已上线 npm（`latest`）**

| 项 | 值 |
|---|---|
| tag | annotated + GPG `v0.1.1`；tag 对象 `e68b3fa0525fa849d64866907ad97d653ee414f0`，指向提交 `ce607fe30b0371bb510dfa2e2a331fd850da0757`；GitHub 侧 `verification.verified = true`（`reason: valid`）。`v0.1.0` 的 tag 对象仍是 `9ae22118…`（未移动） |
| Release | <https://github.com/xinvxueyuan/cordis-plugin-loop/releases/tag/v0.1.1>，三资产：`xinvxueyuan-cordis-plugin-loop-0.1.1.tgz`（80 883 B）、`SHA256SUMS`、`SHA256SUMS.asc`（维护者对 `SHA256SUMS` 的分离签名，`gpg --verify` 为 Good signature） |
| 构建来源证明 | `gh attestation verify <file> --repo xinvxueyuan/cordis-plugin-loop --source-ref refs/tags/v0.1.1` 对 tgz 与 SHA256SUMS 均**退出 0**；负向对照 `refs/heads/main` 与 `refs/tags/v0.1.0` 均被拒（`got refs/tags/v0.1.1`）⇒ 只命中本 tag |
| tgz 校验 | 从 Release 下载后重算 SHA256 = `4d4e8f9223b0670eb50eb97945a99056952b83a469485476a87710fc91ac6a05`，与 `SHA256SUMS` 一致 |
| CI | Release run [`38439675281`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/38439675281) **success**；Publish run [`38439675414`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/38439675414) 在**第五次重跑（attempt 5，2026-10-14T12:14:29Z）三个 job 全部 success**：`Test (node 24)`、`Publish to GitHub Packages (npm.pkg.github.com)`、`Stage for npm (trusted publishing + human 2FA approval)` |
| npm 上线 | **`npm install @xinvxueyuan/cordis-plugin-loop` 可用**：`0.1.1` 于 **2026-10-14T12:29:49.666Z** 上线（UTC；= 2026-10-14 20:29:49 +08:00），`dist-tags.latest = 0.1.1`。入队与来源：**stage id `a8ad0427-c3d2-4121-bee6-39cbca568ece`、shasum `a10cb56ac8184bbee69386ef7654f205a551bfbb`、provenance `logIndex=3250474839`**；registry 侧 `dist.shasum` 与之一致，`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`，`dist.integrity = sha512-aAjlzSAc+u75aGYjsPym15PqHTZmHeSl+cL75/+Rtf2YxGlzBV5RIfXB1R5o4QYyW+kP7V+7h975OfeRmqSkyA==` |
| registry 现状 | npmjs.org：`versions = ["0.0.0-stage", "0.0.1", "0.1.1"]`，`latest = 0.1.1`；**GitHub Packages：`cordis-plugin-loop@0.1.1`**，包 id `15868485`、版本 id `1380584577` |
| bootstrap 遗留 | 两个一次性产物仍在 registry 上，**如实保留**：`0.0.0-stage` 是 npm 在 bootstrap 时自动生成的占位；`0.0.1` 是 bootstrap 的空壳版本（只有一个 package.json，内容与本插件无关）。建议日后清理：`npm deprecate @xinvxueyuan/cordis-plugin-loop@0.0.1 "bootstrap placeholder; use 0.1.1"`（可选，需维护者 2FA） |

**本次卡了四轮 E401 的根因（教训）**：新包第一次发布时，若把 bootstrap 的 stage 条目 **`npm stage reject`** 掉，npm 会**级联删除包行与它的 trusted publisher 配置**（旧条目 `c3565419-…` 事后被查明早已不存在：`npm trust list` 返回 `No trust configurations found`、`npm trust revoke` 报 404）；此后 CI 的 `npm stage publish` 会一直以 `E401 Unable to authenticate` 失败，因为 OIDC 换证找不到任何可信发布配置。**正确姿势是 approve bootstrap 条目让包真正存在**（本仓后来正是：先 approve 0.0.1 → 维护者重建 trust `dd7f5d27-…` → 第五次重跑一次通过）。

---

### profile 基线观察（T5-F4 留痕，只读）

`profiles/**` 是受保护文件（内含明文密钥），本项目对它们**只做只读元数据留痕**（mtime + sha256 + 字节数）：**从未读取内容、从未写入**。

| 观察时间 | web | desktop | headless |
|---|---|---|---|
| 2026-10-16 22:26:29（T5-F4 原始观察：三份**同秒**被原子重写，无法归因） | `f6825e04…`（31103 B） | `d79e2323…`（17253 B） | `9fb81c32…`（16676 B） |
| 2026-10-17（**现状基线**；来源待用户确认，未读取内容） | `e92747a6…`（30343 B，14:26:16） | `62138067…`（16518 B，06:53:25） | `f890aae4…`（15941 B，06:53:25） |

旁证（不改变挂载结论）：宿主 14:20:27 重启（PID 22836），web patch 的 mtime 晚于它 5 分 49 秒（配置层热生效）；改后 `host/Config entry=include:loop` 仍正常（schema 含 `maxRounds` default 24），四个工具 4/4 在列 ⇒ **挂载行与依赖面未受影响**。

### 发布记录：v0.2.0（2026-10-17）—— **已上线 npm（`latest`）**

| 项 | 值 |
|---|---|
| tag | annotated + GPG `v0.2.0`；tag 对象 `84dbce4b58f784a71cd56d572c53650120eb8669`，指向提交 `1615530ab5fff217f77e995cea66e5b5eb4bd73c`；本地 `git tag -v` 为 `Good signature from "xinvxueyuan (github)"`（密钥 `6C6FD9B2394D19FD9CA1F247D6701FBD72B7B35A`）。`v0.1.0`（`9ae22118…`）与 `v0.1.1`（`e68b3fa0…`）**未移动** |
| 提交 | `1615530a`「release: v0.2.0 — agent-startable loops and a control capsule above the composer」，**26 条显式路径**（无 `lib/`、无 `node_modules/`、未用 `git add -A`／`.`），26 files changed, 5929 insertions(+), 117 deletions(-)；push `main` 后该 sha **命中 0 条 workflow run**（未触发发布） |
| Release | <https://github.com/xinvxueyuan/cordis-plugin-loop/releases/tag/v0.2.0>，三资产：`xinvxueyuan-cordis-plugin-loop-0.2.0.tgz`（132 840 B）、`SHA256SUMS`（107 B）、`SHA256SUMS.asc`（887 B，维护者对 `SHA256SUMS` 的分离签名，`gpg --verify` 为 Good signature） |
| 构建来源证明 | `gh attestation verify <file> --repo xinvxueyuan/cordis-plugin-loop --source-ref refs/tags/v0.2.0` 对 tgz 与 SHA256SUMS 均**退出 0**；负向对照 `refs/heads/main` 被拒（`Error: expected SourceRepositoryRef to be refs/heads/main, got refs/tags/v0.2.0`）⇒ 只命中本 tag |
| tgz 校验 | 从 Release 下载后重算 SHA256 = `2a5c399f28f14966ff0b9e736d5d571ad368745a712eefaee7310781b52f07e3`，与 `SHA256SUMS` 逐字一致；该 tgz 的 **SHA1 = `884cd49ebb6c0350fbbd1bb49b856fb972bb2ec2`**，与 CI 的 stage shasum 相同 ⇒ Release 的字节与入队的是同一份 |
| CI | Release run [`39015255952`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39015255952) **success**；Publish run [`39015255957`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39015255957) **success**，三个 job 全绿：`Test (node 24)`（`tests 200 · suites 10 · pass 200 · fail 0 · duration_ms 3116.794768`）、`Publish to GitHub Packages`、`Stage for npm (trusted publishing + human 2FA approval)` |
| npm stage | **stage id `90e2b658-16a9-45c6-84c6-296ee5906df6`、shasum `884cd49ebb6c0350fbbd1bb49b856fb972bb2ec2`、provenance `logIndex=3291648377`**；`npm stage list` 只读复核为 `staged by: GitHub Actions (trusted automation)`、`tag: latest`、`access: public`（与 CI 日志逐字一致） |
| npm 上线 | **`npm install @xinvxueyuan/cordis-plugin-loop` 可用**：`0.2.0` 于 **2026-10-17T07:57:15.364Z** 上线（UTC；= 2026-10-17 15:57:15 +08:00），`dist-tags.latest = 0.2.0`、`dist.shasum = 884cd49ebb6c0350fbbd1bb49b856fb972bb2ec2`（与 stage 回执逐字一致）、`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`。批准动作由**维护者本人在 2FA 下**执行（`npm stage approve <stage-id>`），发布者未代做 |
| registry 现状 | npmjs.org：`versions = ["0.0.0-stage", "0.0.1", "0.1.1", "0.2.0"]`、`latest = 0.2.0`（批准后 `npm stage list` 返回 `No staged versions of package name …` ⇒ 队列已清）；**GitHub Packages：`cordis-plugin-loop@0.2.0`**，包 id `15868485`、版本 id `1400920214`（2026-10-17T07:52:54Z） |
| 版本固化 | `package.json` + `package-lock.json` 两处（根 `version` 与 `packages[""].version`）同步为 `0.2.0`；`npm ci --dry-run` exit 0；`npm pack --dry-run` 含 `client.js`（26.6 kB）与 14 条 `src/`，凭据类条目 **0** |
| 验证 | 冻结字节上：`npm run build` / `npm run typecheck` / `npm test`（**200/200 · 10 suites · 3395.3193 ms · 自然退出**）/ `npm run test:integration`（`integration smoke: OK`）全 **exit 0**；主题对账（`DSH_THEME_CLIENT`）**41/41**；版本固化后复跑 build/typecheck/test 仍全绿（**200/200 · 3052.2314 ms**） |
| 推送前密钥扫描 | 43 文件 × 12 类厂商形状（`ghp_`/`npm_`/`AKIA`/`glpat-`/`sk-`/`Bearer`/私钥块/基本认证 URL 等）**0 命中** |
| 已知后续 | 控制条的**观感**（卡片化外壳、图标按钮）与 `/goal` 尚未对齐，列为 **0.2.1** 的后续项；"子代理会话的 client inspect 会被拒"这条宿主限制见上面的边界第 14 条 |

---

### 发布记录：v0.2.1（2026-10-17）—— 控制条视觉对齐 `/goal` 卡片（**已上线 npm `latest`**）

| 项 | 值 |
|---|---|
| 内容 | 控制条改为**卡片容器 + 图标按钮**，与 `/goal` 同级观感（详见[控制条](#控制条)）；**无行为变化**（无 loop 隐藏、next 后 label +1、stop 后消失、零轮询、console Errors 0） |
| 代码 delta | 恰两个文件：`client.js`（26612 B → 30021 B）、`test/client-capsule.test.ts`（59781 B → 61172 B），由质量门 r6 绑定（`428d0f58…f2ef` / `a7bffc60…2bd8`）；本任务只动 version/lock/README |
| tag | annotated + GPG `v0.2.1`；tag 对象 `c12352ffc7ea38808b28559321e9b3cffdbc338f`，指向提交 `ab3ae85a8c164993e0783288c2b7f296ee521691`；`git tag -v` = Good signature（`xinvxueyuan (github)`，密钥 `6C6FD9B2…B35A`）。`v0.2.0 84dbce4b…`、`v0.1.1 e68b3fa0…`、`v0.1.0 9ae22118…` **未移动** |
| 提交 | `ab3ae85a`「release: v0.2.1 — align the control bar with the /goal card (card container + icon buttons)」，**4 条显式路径**（`client.js`、`test/client-capsule.test.ts`、`package.json`、`package-lock.json`；无 `lib/`、无 `node_modules/`、未用 `git add -A`／`.`），4 files changed, +212/−89；push `main` 后该 sha 命中 **0 条 run**（未触发发布） |
| CI | Publish run [`39017822042`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39017822042) **success**：`Test (node 24)`（`pass 200 · fail 0 · duration_ms 2528.681014`）、`Publish to GitHub Packages`、`Stage for npm` 三个 job 全绿；Release run [`39017822045`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39017822045) **success** |
| npm 上线 | **已上线 2026-10-17T09:25:12.220Z（本地 17:25:12）**：`dist-tags.latest = 0.2.1`、`dist.shasum = 8954979fac8e428be6f8789e5c29d2d5ff6fe095`（与 stage 回执逐字一致）、`npm stage list` 已清空（`No staged versions of package name "@xinvxueyuan/cordis-plugin-loop".`）、`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`。入队与来源：**stage id `4fba7165-3402-48f9-a943-9367090b55e3`、shasum `8954979f…`、provenance `logIndex=3292055373`**（`npm stage list` 曾只读复核逐字一致：`staged by: GitHub Actions (trusted automation)`、`tag: latest`、`access: public`）；批准动作由**维护者本人在 2FA 下**执行，发布者未代做 |
| Release | <https://github.com/xinvxueyuan/cordis-plugin-loop/releases/tag/v0.2.1>，三资产：`xinvxueyuan-cordis-plugin-loop-0.2.1.tgz`（138 928 B）、`SHA256SUMS`（107 B）、`SHA256SUMS.asc`（887 B，维护者对 `SHA256SUMS` 的分离签名，`gpg --verify` 为 Good signature） |
| tgz 校验 | 下载后重算 SHA256 = `274d2d21dc0107eafb9004bf4e974d9bc7e6a772b691eabe03046999beaa9505`，与 `SHA256SUMS` 逐字一致；其 **SHA1 = `8954979fac8e428be6f8789e5c29d2d5ff6fe095`** == stage shasum ⇒ 与入队 tarball 是同一份字节 |
| 构建来源证明 | `gh attestation verify <tgz\|SHA256SUMS> --repo xinvxueyuan/cordis-plugin-loop --source-ref refs/tags/v0.2.1` 两者均**退出 0**；负向对照 `refs/heads/main` 被拒（`expected SourceRepositoryRef to be refs/heads/main, got refs/tags/v0.2.1`）⇒ 只命中本 tag |
| GitHub Packages | **`cordis-plugin-loop@0.2.1`**，包 id `15868485`、版本 id **`1401012051`**（2026-10-17T08:34:04Z） |
| 验证 | 冻结字节：build / typecheck / `npm test`（**200/200 · 10 suites · 3012.774 ms · 自然退出**）/ `test:integration`（`integration smoke: OK`）/ 主题对账（`DSH_THEME_CLIENT`）**41/41** 全 exit 0；`npm pack --dry-run` 47 files，含 `client.js`(30.0 kB) 与 14 条 `src/`、凭据类条目 **0**；版本固化后复跑 build/typecheck/test 仍全绿（**200/200 · 3046.8932 ms**） |
| 推送前密钥扫描 | 43 文件 × 12 类厂商形状 **0 命中** |

---

### 发布记录：v0.2.2（2026-10-18）—— 放宽 DSH peer 范围，接受 `0.2.1-rc.2`（**已上线 npm `latest`**）

| 项 | 值 |
|---|---|
| 内容 | 仅改 `peerDependencies`：4 个 `@deepseek-ai/dsh-*` 条目由精确 `0.2.0-rc.2` 放宽为 `^0.2.0-rc.2`，让 DSH `0.2.1-rc.2` 的运行期 peer 兼容门（`evaluatePluginCompatibility` → `semver.satisfies(range, { includePrerelease: true })`）通过。**运行期代码零变化**：`src/`、`client.js`、`test/` 均未改；`^0.2.0-rc.2` 同时覆盖 `0.2.0-rc.2` 与 `0.2.1-rc.2` |
| 代码 delta | 恰三个文件：`package.json`（version + 4 条 peer）、`package-lock.json`（根两处 version）、`README.md`（版本行），3 files changed, +8/−8 |
| tag | annotated + GPG `v0.2.2`；tag 对象 `afb01e5b29a7332bfe6d5850ae4ed8ba92d28641`，指向提交 `a96f588d5dff1dee9afc9724bef0c5db91190821`；`git tag -v` = Good signature（`xinvxueyuan (github)`，密钥 `6C6FD9B2…B35A`）。`v0.2.1 c12352ff…`、`v0.2.0 84dbce4b…`、`v0.1.1 e68b3fa0…`、`v0.1.0 9ae22118…` **未移动** |
| 提交 | `a96f588d`「release: v0.2.2 — widen DSH peer ranges to accept 0.2.1-rc.2」，**3 条显式路径**（无 `lib/`、无 `node_modules/`、未用 `git add -A`／`.`），3 files changed, +8/−8；push `main` 后该 sha 命中 **0 条 run**（未触发发布） |
| CI | Publish run [`39104757419`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39104757419) **success**：`Test (node 24)`、`Publish to GitHub Packages`、`Stage for npm` 三个 job 全绿；Release run [`39104757427`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39104757427) **success** |
| npm 上线 | **已上线 2026-10-18T06:45:07.255Z（本地 14:45:07）**：`dist-tags.latest = 0.2.2`、`dist.shasum = 4d802c27da6cdc0665971fb7b5849b05bab52c00`（与 stage 回执逐字一致）、`npm stage list` 已清空（`No staged versions of package name "@xinvxueyuan/cordis-plugin-loop".`）、`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`、`versions` 数组含 `0.2.2`。入队与来源：**stage id `8271dcca-43d8-4d45-b5fc-abc07847c71e`、shasum `4d802c27…`、provenance `logIndex=3307633281`**（`npm stage list` 曾只读复核逐字一致：`status: staged`、`tag: latest`、`access: public`、`staged by: GitHub Actions (trusted automation)`）；批准动作（`npm stage approve 8271dcca-43d8-4d45-b5fc-abc07847c71e`）由**维护者本人在 2FA 下**执行，发布者未代做 |
| Release | <https://github.com/xinvxueyuan/cordis-plugin-loop/releases/tag/v0.2.2>，三资产：`xinvxueyuan-cordis-plugin-loop-0.2.2.tgz`（140 890 B）、`SHA256SUMS`（107 B）、`SHA256SUMS.asc`（887 B，维护者对 `SHA256SUMS` 的分离签名，`gpg --verify` 为 Good signature） |
| tgz 校验 | 下载后重算 SHA256 = `1657b2708d4ee0f66d2290a059aa97c9f8f3a8792bd72a5bd79ce8616e6a17a7`，与 `SHA256SUMS` 逐字一致；其 **SHA1 = `4d802c27da6cdc0665971fb7b5849b05bab52c00`** == stage shasum ⇒ 与入队 tarball 是同一份字节 |
| 构建来源证明 | `gh attestation verify <tgz\|SHA256SUMS> --repo xinvxueyuan/cordis-plugin-loop --source-ref refs/tags/v0.2.2` 两者均**退出 0**；负向对照 `refs/heads/main` 被拒（`expected SourceRepositoryRef to be refs/heads/main, got refs/tags/v0.2.2`）⇒ 只命中本 tag |
| GitHub Packages | **`cordis-plugin-loop@0.2.2`**，包 id `15868485`、版本 id **`1403958109`**（2026-10-18T06:39:00Z） |
| 验证 | 版本固化后 `npm ci --dry-run` exit 0（`up to date in 920ms`）；build / typecheck / `npm test`（**200/200 · 10 suites · 3462.7315 ms · 自然退出**）全 exit 0；stage 日志 47 files、package size 140.9 kB、unpacked 515.3 kB |

### 发布记录：v0.2.3（2026-10-19）—— **真正**让 DSH peer 范围接受 `0.2.1-rc.2`（**已上线 npm `latest`**）

| 项 | 值 |
|---|---|
| 内容 | 仅改 `package.json` 与 `package-lock.json`。**v0.2.2 的"放宽"实际无效**：它把精确 `0.2.0-rc.2` 改成 `^0.2.0-rc.2`，而预发布版本只有与范围中某个比较器**同 `[major,minor,patch]` 元组**时才匹配——`satisfies('0.2.1-rc.2', '^0.2.0-rc.2')` 实测为 `false`，即它宣称接受 `0.2.1-rc.2`，实际从未接受。本版把 4 条 peer 改为 `^0.2.0-rc.2 \|\| ^0.2.1-rc.2`，实测同时满足 `0.2.0-rc.2`（latest）与 `0.2.1-rc.2`（next）；`dsh-*` devDeps 升到 `0.2.1-rc.2`，唯 `@deepseek-ai/dsh-invariants` 保持 `^0.2.0-rc.2`（registry 上该包**没有** `0.2.1-rc.2`，其 `next` 仍是 `0.2.0-rc.2`） |
| 代码 delta | 恰两个文件：`package.json`（version + 4 条 peer + 17 条 devDep）、`package-lock.json`（重生）。`src/`、`test/`、`README.md` 未改；+633/−636 |
| tag | annotated + GPG `v0.2.3`；tag 对象 `96defff9bd19efc0d59e7db81113ec051f6504e5`，指向提交 `4eddd56190785cb47e1b75ec76a3cf11982603ed`；`git tag -v` = Good signature（`xinvxueyuan (github)`，密钥 `6C6FD9B2…B35A`）。历史 tag（`v0.2.2 afb01e5b…` 等）**未移动** |
| CI | Publish run [`39146362415`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39146362415) **success**；Release run [`39146362813`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39146362813) **success** |
| npm 上线 | **已上线 2026-10-19**：`dist-tags.latest = 0.2.3`、`dist.shasum = ee9367d2eb7213e5043562220908d9ea44b30a1c`。入队来源：stage id `3ffca56f-3b70-4894-9aee-30d11c05427f`、shasum `ee9367d2…`、`staged by: GitHub Actions (trusted automation)`；批准（`npm stage approve 3ffca56f-…`）由**维护者本人在 2FA 下**执行，发布者未代做；批准后 `npm stage list` 已清空 |
| Release | <https://github.com/xinvxueyuan/cordis-plugin-loop/releases/tag/v0.2.3>，资产 `xinvxueyuan-cordis-plugin-loop-0.2.3.tgz`（141 709 B）与 `SHA256SUMS` |
| tgz 校验 | 下载后重算 SHA256 = `2091dcd03173a737315d48475572f52167dd6212f08be5d14519e5176a7140a2`，与 `SHA256SUMS` 逐字一致；其 **SHA1 = `ee9367d2eb7213e5043562220908d9ea44b30a1c`** == npm 上 published shasum ⇒ 与 npm 那份**是同一份字节** |
| 构建来源证明 | `gh attestation verify <tgz> --repo xinvxueyuan/cordis-plugin-loop --source-ref refs/tags/v0.2.3` **退出 0**；负向对照 `refs/heads/main` **退出 1** ⇒ 证明只命中本 tag |
| 验证 | 独立验证者（与实现者无共享上下文）在 `%TEMP%` 副本自写探针复跑：`npm ci` / `typecheck` / `test`（**200/200**）/ `build` 全 exit 0；14 条 `dsh-*` peer 范围实测覆盖 `0.2.1-rc.2` 与 `0.2.0-rc.2`；活体闸门在真实宿主确认 `loop_status` 可答、`loop_stop` 在无 loop 时**明确拒绝** |

---

### 发布记录：v0.3.0（2026-10-19）—— `/loop --dry-run` 预览 + `loop_start({dryRun})`（**已上线 npm `latest`**）

| 项 | 值 |
|---|---|
| 内容 | 新增 `/loop --dry-run [<interval>] [<task>]` 与 `loop_start({dryRun:true})`：**只预览、不落地**（零写零发），并在计划模式 / 子代理 / kill switch / `enabled:false` 下**照常放行**、把这些条件列为 `Blockers:`。预览与真实启动**共用同一份归一计算**（`src/plan.ts` 的 `planLoop` + `src/registry.ts` 的 `resolveStartRequest`），杜绝"预览说的"与"真起的"漂移。文档向实现对齐：`loop_start` 参数去掉从未实现过的 `rounds`、补 `dryRun`，并订正子代理读路径边界 |
| 代码 delta | **14 条显式路径**：`README.md`、`package.json`、`package-lock.json`、`src/command.ts`、`src/engine.ts`、`src/grammar.ts`、`src/plan.ts`（新增）、`src/registry.ts`、`src/tools.ts`、`test/grammar.test.ts`、`test/integration-smoke.ts`、`test/preview.test.ts`（新增）、`test/register.test.ts`、`test/tools.test.ts`；14 files changed, +1658/−140；**无 `lib/`、无 `node_modules/`**，未用 `git add -A`／`.` |
| tag | annotated + GPG `v0.3.0`；tag 对象 `31f32c463079a343b7b4bf7f8d4d84798ad416d5`，指向提交 `8250d2130316dd91aa63b1017af797627a35cca2`；`git cat-file -t` = `tag`，`git tag -v` = **Good signature**（`xinvxueyuan (github)`，密钥 `6C6FD9B2…B35A`）。历史 tag（`v0.2.3 96defff9…`、`v0.2.2 afb01e5b…`、`v0.2.1 c12352ff…`、`v0.2.0 84dbce4b…`、`v0.1.1 e68b3fa0…`、`v0.1.0 9ae22118…`）**逐个复核前后未移动**；无 force-push、无 `workflow_dispatch` |
| 提交 | `8250d213`「release: v0.3.0 — /loop --dry-run preview and loop_start({dryRun})」；GPG 签名 `%G? = G`；push `main` 后按该 sha 过滤 run 列表命中 **0 条 run**（未触发发布） |
| 冻结锚 | 质量门 r2 绑定：45 文件逐文件 sha256（口径 `git ls-files --cached --others --exclude-standard` → 排除 `node_modules`/`lib`/`.git` → 序数排序；**逐文件才是判据，聚合仅索引**）；发布者复算与绑定的 14 条逐字 **MATCH**，其余 31 个文件经 `git hash-object` 与 `HEAD` 逐字节比对一致 |
| CI | Publish run [`39176407361`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39176407361) **success**，三个 job **全部执行且 success（无一 skipped）**：`Test (node 24)`（`tests 217 · suites 10 · pass 217 · fail 0 · duration_ms 3257.575113`）、`Stage for npm (trusted publishing + human 2FA approval)`、`Publish to GitHub Packages (npm.pkg.github.com)`；Release run [`39176407464`](https://github.com/xinvxueyuan/cordis-plugin-loop/actions/runs/39176407464) **success** |
| npm 上线 | **已上线 2026-10-19T00:05:01.267Z（UTC；= 本地 08:05:01）**：`dist-tags.latest = 0.3.0`、`dist.shasum = 743571d014502a35c8f3f167d14915b5729abecc`（与 stage 回执**逐字一致**）、`npm stage list` 队列已清空（`No staged packages found.`）、`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`、`versions` 数组含 `0.3.0`（`0.2.3` 的上线时刻仍为 `2026-10-18T17:01:06.992Z`，未被改写）。入队与来源：**stage id `1e520c88-0ba7-4827-bfb5-b3d6d874ec8a`、shasum `743571d0…`、provenance `logIndex=3318192747`**（`npm stage list` 曾只读复核逐字一致：`status: staged`、`tag: latest`、`access: public`、`staged by: GitHub Actions (trusted automation)`、`date staged: 2026-10-18T23:25:21.736Z`）；批准（`npm stage approve 1e520c88-0ba7-4827-bfb5-b3d6d874ec8a`）由**维护者本人在 2FA 下**执行，发布者**未代做**（本轮未 approve、未 `npm login`、未做 2FA） |
| Release | <https://github.com/xinvxueyuan/cordis-plugin-loop/releases/tag/v0.3.0>，三资产：`xinvxueyuan-cordis-plugin-loop-0.3.0.tgz`（157 946 B）、`SHA256SUMS`（107 B）、`SHA256SUMS.asc`（887 B，维护者对 `SHA256SUMS` 的分离签名，`gpg --verify` 为 Good signature）。`.asc` **不由 CI 产出**：`release.yml` 只生成前两者，`.asc` 由维护者本机补签后上传 |
| tgz 校验 | 从 Release 下载后重算 SHA256 = `fec31622721f00080cd81dfa9005abb6845f476ea24a37b132ac26dce3125412`，与 `SHA256SUMS` 逐字一致；其 **SHA1 = `743571d014502a35c8f3f167d14915b5729abecc`** == stage shasum ⇒ Release 的字节与入队的是**同一份** |
| 构建来源证明 | `gh attestation verify <tgz\|SHA256SUMS> --repo xinvxueyuan/cordis-plugin-loop --source-ref refs/tags/v0.3.0` 两者均**退出 0**；负向对照 `refs/heads/main` 两者均**退出 1**（`expected SourceRepositoryRef to be refs/heads/main, got refs/tags/v0.3.0`）；证明 JSON 全文对 `refs/heads/` **零命中**（`refs/tags/v0.3.0` 命中 8 处），SAN = `…/release.yml@refs/tags/v0.3.0`、`externalParameters.workflow.ref = refs/tags/v0.3.0`、`resolvedDependencies = git+…@refs/tags/v0.3.0@8250d213…` ⇒ 只命中本 tag |
| GitHub Packages | **`cordis-plugin-loop@0.3.0`**，包 id `15868485`、版本 id **`1406552576`**（2026-10-18T23:25:16Z） |
| 验证 | 冻结字节上：`npm run build` / `npm run typecheck` exit 0；`npm test`（**217/217 · 10 suites · 3222.7036 ms · 自然退出**）；`npm run test:integration` exit 0（`preview: stored rows 0 -> 0` / `real start: stored rows 0 -> 1`，即预览零写、真启动才落盘）；`npm run test:smoke:client` exit 0；主题对账（`DSH_THEME_CLIENT`）**41/41**；`npm ci --dry-run` exit 0；`npm pack --dry-run` **50 files**，含 `client.js`（30.0 kB）与 15 条 `src/`、**凭据类条目 0**。版本固化后复跑 build/typecheck/test 仍全绿（**217/217 · 3252.7441 ms**） |
| 版本固化 | `package.json` + `package-lock.json` **两处**（根 `version` 与 `packages[""].version`）同步为 `0.3.0`；固化后逐文件锚 diff（白名单仅这两个文件）⇒ **`changed 2 / missing 0 / added 0`**，其余 43 个文件 sha256 逐字节未变；**负向对照**（空白名单）⇒ 退出 1 且恰好点出这两个文件 |
| 推送前密钥扫描 | 45 文件 × **15 类**厂商形状（`ghp_`/`github_pat_`/`gho_`/`ghs_`/`npm_`/`AKIA`/`glpat-`/`sk-`/`xox*`/`AIza`/私钥块/`Bearer`/基本认证 URL/通用 secret 赋值/`eyJ…` JWT 形）**0 命中**（脚本置 `%TEMP%` 并在用后删除） |
| 活体闸门 | 队长在根会话、冻结字节上实测：固定档预览打印完整标签面且**无 `Id:`**、如实报出将被替换的真记录；预览后 `loop_status` 的 `nextAt` 未变（**零副作用**）；真启动 / `loop_stop` / 再 `loop_status` 全链路正常；自定档预览无 `Cron:`/`Jitter:` 行（与契约一致）；活体工具表 `loop_start` description 与源码逐字一致；`client.js` 全程零改动（`428d0f58df5af7ac393dddb69cd38e85580e978283cbbca6c77184983536f2ef`）。**未覆盖（如实）**：`/loop --dry-run` 的**命令面**无法由模型执行（模型不能直接发斜杠命令），它由冻结字节上的用例覆盖（真 `CommandRuntime`），且与工具面共用同一 `stripDryRunFlag` |
| 环境边界（如实） | 发布者本地 `npm test` 跑的是**本地已装**的 dsh `0.2.0-rc.2`（lock 已钉 `0.2.1-rc.2`/`cordis 4.0.5`，但本地 `node_modules` 未重装），而 **CI 的 `Test (node 24)` 走干净 `npm ci`、跑 `0.2.1-rc.2`** —— 两侧运行期 peer 不同（与 v0.2.3 发布时相同）。`npm ci --dry-run` exit 0 ⇒ `package.json` 与 lock **同步**；发布者未擅自 `npm install`（会动 `node_modules`） |

**上线复核（现查，非转述）**：`npm view @xinvxueyuan/cordis-plugin-loop version dist-tags dist.shasum --json` ⇒ `version 0.3.0`、`dist-tags.latest 0.3.0`、`dist.shasum 743571d014502a35c8f3f167d14915b5729abecc`（与交回的 stage shasum **逐字相同** ⇒ 上线的那份与入队/Release 的是同一份字节）；`npm stage list` ⇒ `No staged packages found.`（队列已清空）。

#### 已知边界与待办（0.3.1 backlog，仅记录、未在本版处理）

1. **`/loop stop` 不撤回"已排队的那一轮"**：宿主 `dsh-schedule` 的语义是**删除不撤回已投递的提醒**（其 `schedule_delete` 描述原文如此）。因此停止一个 loop 后，此前已排队/已投递的那一轮消息仍可能浮现。活体闸门实测撞到过一次（`loop_stop` 返回成功后，首轮消息仍出现）。这是**宿主调度行为、非本插件缺陷**，且不影响记录与投影的正确性（`loop_status` 立刻如实变为 `active:false`）；本版仅在文档中如实记录该边界。
2. **`test/loopfile.test.ts` 会遗留 `%TEMP%\loopfile-*` 目录**：验证者实测残留 **168 个**，疑为 `mkdtemp` 后未清理。**非本版引入**（既有测试），不影响发布产物与 CI 结果（CI 为一次性 runner），记为 0.3.1 待办。

### 发布记录：v0.4.0（2026-10-20）—— 以官方 bundle 形态发布（**已上线 npm `latest`**）

| 项 | 事实 |
|---|---|
| 内容 | 新增 `cordis.patch.yml`（Loader row `loop` + 显式 `inject: [tools, schedule]`）、`package.json` 的 `dsh.bundle.patch` 与顶层 `icon`、`locale/{en,zh}.json`、`icon.svg`、`test/manifest.test.ts`（守护 patch、`inject` 与源码集合相等、显示资源与打包面）；`dsh.client` 与 `client.js` **零改动** |
| 提交 | `23ba97e`「feat: ship as an official DSH bundle (v0.4.0)」，8 条显式路径；推送 `main` 后命中 **0** 条 run |
| tag | annotated + GPG `v0.4.0`；tag 对象 `498cfc42dd6fa516b2c43c2c4b726bf191917e0c`；`git tag -v` = **Good signature**（`xinvxueyuan (github)`，密钥 `6C6FD9B2…B35A`） |
| CI | Publish run `39387232937`（`Test (node 24)` ✅ / `Publish to GitHub Packages` ✅ / **`Stage package (with provenance)` 真的执行** ✅）、Release run `39387233114` ✅ |
| stage | stage id `0b991c59-2a93-4c97-962d-0683b7f07f6e`、shasum `bd06483dbf609830cba748c22a997ca592cdb799`（`access: public`、`tag: latest`、`actorType: trusted automation`），由维护者 2FA 批准上线 |
| 上线复核（现查） | `dist-tags.latest = 0.4.0`、`dist.shasum = bd06483d…`（**与 stage shasum、Release tgz 的 SHA1 逐字相同**）、`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`、`dsh.bundle.patch = ./cordis.patch.yml` 与 `icon = icon.svg` 确实在 npm 上；上线时间 `2026-10-20T07:41:31.464Z`；`npm stage list` 已空 |
| Release | <https://github.com/xinvxueyuan/cordis-plugin-loop/releases/tag/v0.4.0>，本轮为 CI 两资产：`xinvxueyuan-cordis-plugin-loop-0.4.0.tgz`（162 685 B）与 `SHA256SUMS`（107 B）；本地复算 tgz 的 SHA256 与 `SHA256SUMS` 逐字一致（本轮未附手签 `.asc`） |
| 验证 | 门禁 `225/225` 全绿；质量门内容层 pass（12/12 门禁、三类变异精确打红），发布层先 `needs_revision`（版本已被占用）→ 版本冻结后逐字节复核**非预期漂移 0** 再发 |

---

<a id="english"></a>
## English

`@xinvxueyuan/cordis-plugin-loop` implements DSH's `/loop`: run a task **now**, then keep it running on a fixed wall-clock cadence (cron + deterministic jitter) or a self-paced one (`loop_next` / `loop_stop`). Each loop is one durable `@deepseek-ai/dsh-schedule` task whose title and prompt carry all of its mutable state, so a continuation, a stop, and the omission safety net are all one in-place `ctx.schedule.update` — a session never owns more than one loop record.

Seven call forms (plus `/loop next` to deliver a round immediately, and a leading `--dry-run` flag that describes a loop without arming it), wall-clock cron for every fixed cadence, nearest-step snapping with ties upward, `min(10% of the normalized period, 900s)` of jitter drawn from a stable fingerprint and expressed in the cron phase, a configurable round limit (`maxRounds`, default 24), a 7-day lifetime, a two-strike omission guard on `agent/turn-stopping`, `.dsh/loop.md` default tasks that are re-read every round through a pointer, plan-mode and kill-switch refusals, and an inert path when `ctx.schedule` is absent. The model can also start and read a loop itself through the `loop_start` / `loop_status` tools — the same `startLoop` implementation the `/loop` command uses, with `dryRun: true` for the same read-only preview — and a control bar above the composer (`conversation.input.dock`, id `loop`, order 5) shows the cadence, the next-round countdown, the round number and the starter, with stop / next-round buttons that simply execute `/loop stop` / `/loop next` through `ctx.remote.commands.execute`. Card-style visual parity with `/goal` is a 0.2.1 follow-up. See the Chinese sections above for the per-band truth table, the header format and its foreign-record boundary, the configuration table, and the deviation list.
