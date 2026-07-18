# 你的任务：拿清单逐条核对教学对话

给你三样东西：
1. 一份**教学内容清单**（从上一步从源材料或书本原文抽的，JSON）。
2. 一段**教学对话 transcript**——一位 AI 老师（苏格拉底式）和一位学生之间的对话。
   每轮以 `【教师】` 或 `【学生】` 开头。
3. 一个**教学节奏档位**：`thorough`（细）/ `normal`（中）/ `express`（快）。

对清单里**每一条**，判断在对话中老师是否覆盖了这个点，输出三态之一：

- **landed 落地**：老师在对话中明确讲了、引导学生推导了这个点。给出 `synthQuote`——老师嘴里**最相关的一句原话**（逐字摘）。
- **morphed 变形**：落地了，但讲法/范围/例子变了（讲窄了、讲宽了、不完整、例子不对）。给 `synthQuote` + `note` 说明怎么变的。
- **dropped 漏**：对话中没有证据表明老师覆盖了这个点。`note` 说明可能为什么漏了。

## 节奏如何影响判断

不同的节奏档位对应不同的教学期望。你的判断要根据节奏调整：

### thorough（细）——拆到最细，多复述多例子
- 期望：**所有清单条目**都应该落地，包括活动、练习、易错点
- landed 的门槛高：必须讲得完整、有例子、有验证
- morphed 就是问题：讲窄了或跳步了就是信号
- dropped 是红灯：任何条目漏了都应该在 verdict 里强调

### normal（中）——正常节奏，每 2-3 轮复述一次
- 期望：**知识点 + 评价标准 + 易错点**应该落地；**练习题**可以有变形
- exercises 如果对话里出现了等价练习→ landed/morphed，没出现但对话轮次有限→ morphed 而非 dropped（注明"轮次不足，未覆盖此题"）
- knowledgePoints 漏了才是问题

### express（快）——跳过基础，直奔核心
- 期望：**知识点（knowledgePoints）** 应该落地；其他三类不作硬性要求
- assessmentCriteria / exercises / errorSpots 即使完全没出现也不判 dropped——判 morphed，note 写"快速模式下预期不覆盖"
- knowledgePoints 如果落地但讲得精简（没展开例子）→ 判 landed，不要因为"没展开"判 morphed
- **只有 knowledgePoints 漏了才判 dropped**

## 与「勾稽合成节」的关键区别

你审的不是一份静态文档——你审的是一段**真实对话**。对话天然：
- 知识点可能**分散在多轮对话**中——老师在一个轮次引出概念，学生在后续追问中深化。你不需要找"一段完整表述"，找到片段证据即可算落地。
- **学生的话也可以作为间接证据**——如果学生复述、总结、举例中体现了某个点被教到，即使老师当时没有长篇大论，也说明落地了（在 note 里注明"通过学生复述间接体现"）。
- 对话可能**被打断、绕路、回来**——如果老师在 tangent 之后回到了这个点，也算落地。
- 对话文本量大——你不需要逐句分析，只需要**对照清单条目有目标地扫描**。

## 判 exercise（教材原题）时

教材原题问的是"对话里有没有等价的练习"——不是原题原文，而是老师有没有让学生练到这个技能点。有等价练习→ landed/morphed，没有→ 根据节奏判断（见上方）。

## 输出格式

**每行一条**，用以下固定格式（不要用 JSON——直接按行输出）。若本次以函数/工具形式调用，请忽略此行格式约束，直接按函数 schema 输出：

```
ROW|checklistId|category|itemName|status|synthQuote|note
```

字段说明：
- `checklistId`：清单条目 id（如 kp1、ac3）
- `category`：knowledgePoint / criteria / exercise / errorSpot
- `itemName`：清单条目名称
- `status`：landed / morphed / dropped
- `synthQuote`：老师原句（如无则留空，不要填"无"或"-"）
- `note`：备注（如无则留空。express 模式下非 knowledgePoint 判 morphed 时注明"快速模式"）

最后一行输出总评：
```
VERDICT|一句话总评（应提及节奏档位和对应期望）
```

## 硬规则

- `synthQuote` 必须是 transcript 里**老师说话的原句**（后续会做逐字校验）。
- 拿不准落地与否时，倾向 **dropped**——但仅限 knowledgePoints；其他类别遵循节奏规则。
- **严格按 ROW|...|VERDICT|... 格式输出**，每行一条，不输出其他内容。
- 清单里每一条都必须在输出里出现一次。
- 不要输出 markdown 表格、不要 JSON、不要 ``` 代码围栏。

