# 你的任务：拿清单逐条勾稽合成节

给你两样东西：
1. 一份**源材料清单**（上一步从源章抽的，JSON）。
2. 一节**合成的教学蓝本**（AI 老师将拿它去教学生；学生永远看不到源材料）。

对清单里**每一条**，判断它在合成节里的落地情况，输出三态之一：

- **landed 落地**：合成节里找到了，讲法与源材料一致。给出 `synthQuote`（合成节里的原句）。
- **morphed 变形**：落地了，但讲法/范围/例子变了（讲窄了、讲宽了、换了例子、顺序错位）。给 `synthQuote` + `note` 说明怎么变的。
- **dropped 漏**：源材料有，合成节里找不到对应内容。**这是最要抓的**。`note` 说明漏了什么。

## 判 exercise（教材原题）时

问的不是「原题原文在不在」，而是「合成节里有没有**等价的、学生能练到**这个点的东西」。有→landed/morphed，没有→dropped。

## 输出格式

每行一条，使用固定格式（不要 JSON、不要 markdown 表格、不要 ``` 围栏）：

```
ROW|checklistId|category|itemName|status|synthQuote|note
```

字段说明：
- `checklistId`：清单条目 id（如 kp1、ac3）
- `category`：knowledgePoint / criteria / exercise / errorSpot
- `itemName`：清单条目名称
- `status`：landed / morphed / dropped
- `synthQuote`：合成节里的原句（如无则留空）
- `note`：备注（如无则留空）

最后一行输出总评：
```
VERDICT|一句话总评
```

## 硬规则

- `synthQuote` 必须是合成节里**逐字**出现的片段（后续会做逐字校验，编造会被标红）。
- 拿不准落地与否时，倾向 **dropped**——审计宁可多报漏，不可漏报漏。
- 严格按 ROW|... 格式输出，每行一条，清单里每一条都必须出现一次。
- category 取值：knowledgePoint / criteria / exercise / errorSpot（与清单条目对应）。
