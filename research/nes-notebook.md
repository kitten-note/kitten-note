# NES 研究笔记本（工作稿）

> 目标：把"端侧、单次前向、类型安全的下一编辑预测器"从工程直觉变成一个**可发表（arXiv/TMLR）的理论+系统工作**。
> 状态标记：📚=已查证文献 / ✏️=待写证明 / 🔬=待做实验 / ❓=开放问题

---

## 0. 课题一句话

**把"下一编辑建议"形式化为：在逆幺半群作用下、被判定的（well-typed）编辑原子游走上的单次前向预测问题——并证明：在固定特征场上，深度为 1 的线性打分器即最优预测类，且接地性（grounding）与类型安全可以由构造保证。**

工作名候选：**Edit Field Theory (EFT)** / **Typed Atom Walk (TAW)** / **Single-Pass Grounded Edit Prediction (SGEP)**。暂用 **EFT**。

---

## 1. 问题形式化

### 1.1 编辑原子与代数结构

- 设有限字符表 Σ（UTF-8 视作字节或码点皆可），文档为 S ∈ Σ*。
- **原子**：有限集合 A ⊂ I(Σ*)——Σ* 上的**部分单射**，例如
  - `Ins_c(p)`：在位置 p 插入字符 c（定义域：p 为合法位置）；
  - `Del(p)`：删除位置 p 的字符；
  - `Rep(p,c) = Del(p) ∘ Ins_c(p)` 等复合物；
  - 再加**结构原子**：`Fmt(pattern)`（段落样式）、`Swap(p,q)`（易位）。
- **关键代数事实（📚 Lawson）**：由插入/删除生成的逆幺半群就是（∨-半格化之前的）**多项式逆幺半群 P_Σ**；`Ins_c` 与 `Del(p)` 互为部分逆。任何"编辑"= P_Σ（及其有类型扩张 A* ) 中的一个元素；编辑是**可复合**的（连续编辑 = 幺半群乘法）。
  - 参考文献：M. V. Lawson, *The polycyclic inverse monoids and the Thompson groups revisited*；*The algebra of rewriting for presentations of inverse monoids*（arXiv:1904.13135）。
- **有类型扩张**：给每个原子一个**类型** τ ∈ T（typo/punct/trim/format/complete/replace…），得到类型化自由逆幺半群 FI(A,T)。类型安全 = 预测结果的类型与当前状态下的定义域（domain）判定一致。

### 1.2 文档状态、会话与游走

- 会话：文档 S₀ ⟶(a₁) S₁ ⟶(a₂) S₂ ⟶ …，其中 aₜ ∈ A 为用户真实施加的原子。
- 群作用视角：逆幺半群 M = ⟨A⟩ 部分作用于 Σ*；轨道 = 文档可达状态；**会话 = Schreier 图上的游走**，边 = 原子。
- 观测量：x_t = (S_t 的窗口 W_t ⊆ Σ^{≤L}，光标/选区位置，最近 k 个原子 a_{t-k..t}，时间间隔，IME 状态)。
- **NES = 预测游走的下一条边**：学 p(a | x_t)，a ∈ A_⊤ = A ∪ {NO_EDIT}。

### 1.3 "单次前向"的数学定义（本文契约）

把预测器定义为电路族 f: X → Δ(A_⊤)。**单次前向 = 常数深度、常数宽度**：

- 自回归 LLM 被排除：计算深度 ∝ 输出长度（逐 token 依赖）。
- 迭代式 NAR（Levenshtein、扩散/流）被排除：深度 ∝ 迭代轮数。
- 我们钉住的类：

  p_θ(a | x) = softmax_a ⟨φ(x), w_a⟩ / τ，

  其中 **φ: X → ℝ^D 是固定的（或离线学习、在线冻结的）特征场**，计算深度 = O(1)（纯并行特征提取），W 是唯一在线学习参数。

- 于是问题变成三个可证的问题：
  - **Q1 表达力**：什么样的 φ 使得目标分布（近似）落入该类？（→ 命题 T1）
  - **Q2 学习**：在线更新 W 的 regret 与泛化界？（→ T2, T3）
  - **Q3 安全**：输出如何保证 well-typed 且接地？（→ T4）

### 1.4 类型安全与接地的精确陈述

- **判定**：Γ, S ⊢ a ⇓ S′（a 在 S 上有定义，得到 S′）。
- **接地**：给定用户语料 C 与字面子表 Λ（标点/格式符白名单），内容函数 κ 满足：

  **payload(a) ⊆ Sub(C) ∪ Λ**（Sub = 子串集合）。

- **我们要证的主定理（T4）**：对任意状态 S 与任意输出 a：

  1. **Soundness**：若 a ≠ NO_EDIT 被输出，则 a 在 S 上有定义；应用后 S′ 仍是合法文档（不变式保持）。
  2. **Grounding**：a 的载荷满足上式（零幻觉 = 闭包性质，而非训练目标）。
  3. **Expressivity（弱完备）**：任意"局部编辑"可表示为若干原子的复合（幺半群生成性）——完备性是代数层面的，可用性（何时建议）是统计层面的，两者分离。

---

## 2. 查新结果与缺口 📚

### 2.1 代码侧 NES / 编辑预测

| 工作 | 形态 | 与我们差异 |
|---|---|---|
| Next Edit Prediction（arXiv:2508.10074，含数据集+基准，2025） | 诊断→编辑的 NEP 任务；SFT LLM | 自回归 LLM；未涉及类型论/接地/单次/在线学习 |
| Sweep Next-Edit 0.5/1.5B | `original/updated` 块；21 行窗口；n-gram 推测解码 | 仍是生成模型；英文代码域 |
| Zed Zeta-2（2026） | 8B，编辑历史+LSP 蒸馏 | 云端/本地大模型；非单次前向 |
| **Edit Flows（NeurIPS 2025）** | **变长离散流匹配，非自回归，直接建模编辑操作序列** | 迭代式流（深度>1）；无类型系统、无接地、无在线学习、无 MDL/regret 分析——**最近邻，必须正面切开** |
| NLE（arXiv:2603.08397） | NAR ASR = 转写编辑 | 领域不同；迭代式 |

### 2.2 非自回归决策模型（Jev 与社区）

- **Jev / TypeSafe AI**（2026-09-15）：结构化评估模型，输出限定答案空间（Choice/Score），单次前向，宣称 ~200× 速度、零幻觉；官方用例含"下一编辑"。📚
- 开源/社区前身：Varritech *non-autoregressive-decision-models* 指南（RL + strictly proper scoring rules）；Laya（33ms 多语言决策）；HN 千点讨论。📚
- **结论**：单次前向本身不再是空白；**空白在"编辑"这个结构化、可复合、需要接地与类型安全的动作空间**上。

### 2.3 HDC ↔ 核方法（作为工具引用，不作为创新）

- NysHD：任意核 → HDC 编码（AAAI 2025）。📚
- FPE ⇔ RFF 等价与"最优超维表示"（Frontiers in AI, 2026）。📚
- Generalized Holographic Reduced Representations（arXiv:2405.09689）。📚
- Rahimi & Recht 随机特征（NeurIPS 2007）——JL 型浓度界。📚
→ 用于支撑 **T1/T2**：我们的特征场是随机特征核的一次实例化。

### 2.4 通用预测 / MDL / 压缩

- Context Tree Weighting：混合模型冗余 O(log T)（Willems et al., 1995）。📚
- Soft-Bayes（PMLR v76, 2017）：专家乘积混合的 regret 界。📚
- log-loss 序列预测的 minimax regret 与贝叶斯混合（Wu et al., NeurIPS 2022；Feder et al., 2021）。📚
- **Infini-gram**（arXiv:2401.17377）：后缀数组上的 ∞-gram，毫秒级，单独 ~47% 下一 token 准确率，可补充神经 LM。📚 → 我们的**内容层**理论原型（也是基线）。
- Context mixing 的 log-loss 编码解释（2026 综述文）。📚

### 2.5 在线学习工具

- OGD 的 O(√T) regret（Zinkevich 2003）；核在线学习；**proper scoring rules**（Gneiting & Raftery 2007）用于校准。📚

### 2.6 缺口表（我们的位置）

| 维度 | 现有工作 | 空白 |
|---|---|---|
| 输出对象 | token / 文本 / 操作序列 | **类型化逆幺半群原子 + 判定** |
| 计算深度 | 自回归（∝长度）或迭代流 | **深度 1 线性类（可证明的表达力/泛化）** |
| 接地 | 无（自由生成） | **payload ⊆ Sub(C) ∪ Λ 的闭包定理** |
| 学习 | 离线训练 | **在线增量 + regret 界 + 校准门控** |
| 理论 | 无统一框架 | **逆幺半群游走 + 核等价 + MDL 三条线** |

---

## 3. 理论纲领（五个命题）

### T1（单次可表达性）✏️
**命题**：设上下文窗口长 ≤ L，目标分布 p*(·|x) 是任意（Lipschitz/有界复杂度）条件分布。则存在子串绑定特征场 φ（由随机超向量绑定/捆绑构造，维度 D）使得

  sup_x ‖p_θ(·|x) − p*(·|x)‖ ≤ ε，当 D ≳ C·L·log|Σ|·ε^{-2}。

**证明思路**：把"窗口内子串一致性"核展开为 RFF（Rahimi–Recht；FPE 等价），用 JL 引理控制 D；线性 softmax 的通用逼近在有限动作集上由分离性给出。**这是"单次前向够用"的定量陈述——Jev 只有主张，我们有界。**

### T2（核等价与泛化）✏️
**命题**：HDC 绑定(⊛)/捆绑(+) 实现的相似度收敛到 PSD 核 k(x,x′)；p_θ 等价于该核的随机特征线性模型。给出 Rademacher/PAC-Bayes 泛化界（显含 D、T、窗长 L）。

### T3（在线遗憾）✏️
**命题**：捆绑式原型更新 ⇔ 提升空间中的 OGD；对凸损失，regret vs 最优固定 W* 为 O(√T)。对数损失下，用 Soft-Bayes/乘积混合聚合多专家，得到 O(√(T ln K)) 型界；进一步（可选）CTW 式 O(log T) 冗余。

### T4（类型安全与接地闭包）✏️ 优先写
如 §1.4 三子句。**Soundness + Grounding 是构造性的**（原子表 + copy-only 载荷 + 白名单），Expressivity 用幺半群生成性。**零幻觉 = 推论**。

### T5（MDL 最优性，经验命题）🔬❓
预测器的累积对数损失逼近用户编辑流的**经验熵率**；差距可分解为三部分：模型类复杂度（T2）、接地限制（T4）、单次约束（T1）。给出估计方法（跨用户/跨语料的熵率下界：CTW/∞-gram 估计）。

---

## 4. 方法（"新预测器" EFT-Predictor）

### 4.1 特征场 φ（全并行，深度 O(1)）
1. **接地子串特征**：后缀自动机/后缀数组上取"最长右匹配"及其统计量（出现次数、右邻分布）→ 哈希后绑定位置。
2. **行为特征**：最近 k 个原子（one-hot 绑定）、时间间隔桶、接受/拒绝历史。
3. **结构特征**：标点/列表/标题状态、段落相对位置、IME 合成态。
4. 全部经 VSA 绑定/捆绑成 H 维超向量（H ≈ 10⁴–10⁵ 二值），即深度 1 特征场。

### 4.2 专家与混合器
- 专家：HDC 原型分类器（每原子一类）、∞-gram 统计专家、规则先验专家（标点/格式）。
- 混合器：log-loss 下的乘积/Soft-Bayes 更新（带 regret 保证），避免任何"注意力/循环"。

### 4.3 内容层（拒斥生成）
- 载荷 = SA 命中子串 ∪ 白名单字面量；命中失败 → NO_EDIT。**内容函数 κ 是查表，不是解码。**

### 4.4 在线更新与校准
- 接受/拒绝 → 增减该样本的超向量（等价 OGD 步）；置信度用 strictly proper scoring 校准；门控阈值由校准后置信度直接给出。

---

## 5. 实验与基准

### 5.1 数据集
1. **合成流（对照）**：规则扰动（同音字/标点/赘词/格式）生成 100 万条，标签=原子（构造即真值）。🔬
2. **ZhWiki-EditStreams（自建基准，贡献物之一）**：中文维基修订历史 → 相邻版本 diff → 原子序列（含 NO_EDIT 判定与类型标注）。数据源：Wikimedia 全量修订 dump（工具：ndrezn/wikipedia-histories）。🔬
3. **跨域**：代码 NEP 基准（arXiv:2508.10074 的数据）验证域外迁移。📚🔬
4. **真实笔记流（可选，隐私本地）**：作者自有笔记的编辑轨迹（不公开）。

### 5.2 基线
∞-gram（infini-gram）、PPM/CTW、HDC 变体、哈希逻辑回归、GBDT、小 FIM LLM（Granite-350M/Qwen2.5-Coder-0.5B）、Edit Flows 风格 NAR。

### 5.3 指标
原子 top-k 准确率；位置 IoU；NO_EDIT 精确率@门控；校准（ECE / proper score）；累积 log-loss 与 regret 曲线（对齐 T3）；WASM 端侧单次延迟；**类型安全违规数（构造上应为 0，作为 sanity）**。

### 5.4 理论验证实验
- 测核近似误差 vs D（对照 T1 的 JL 型界）；
- 测 regret vs √T（对照 T3）；
- 测熵率差距分解（T5）。

---

## 6. 论文

### 6.1 题目候选
1. *Single-Pass Grounded Edit Prediction: Kernel, Regret and Type-Safety Theory for Next-Edit Suggestion*
2. *Typed Atoms on an Inverse Monoid: A Theory of Next-Edit Prediction without Generation*
3. *EFT: Edit Field Theory — Depth-One Prediction of Type-Safe Edits*

### 6.2 章节大纲
1. Introduction（Jev 现象 → 我们需要理论）
2. 形式化（逆幺半群、游走、深度 1 契约、类型判定）
3. 理论（T1–T4；T5 作为假设）
4. EFT-Predictor（特征场、专家-混合器、内容层、在线更新）
5. 基准：ZhWiki-EditStreams + 合成 + 跨域
6. 实验（准确性、regret、校准、端侧延迟、零违规）
7. 相关工作（Edit Flows、NEP、HDC、CTW、infini-gram、Jev 社区）
8. 局限与伦理（中文笔记域；个人语料隐私；非语义级改写）

### 6.3 投稿策略
- 先 arXiv（cs.CL / cs.LG 交叉）。
- 再投 **TMLR**（滚动、theory+systems 友好）为主；若理论打磨后更强 → ICLR 2027 周期 / ACL 2027。

### 6.4 贡献声明草案
1. 首次把 NES 形式化为**逆幺半群游走上的判定预测**，分离"完备性（代数）"与"可用性（统计）"。
2. **深度 1 线性类**下的表达力与泛化界（T1/T2），在线 regret（T3）——把"单次前向"从口号变成定理。
3. **类型安全/接地闭包**（T4）：零幻觉是推论，不是训练目标。
4. EFT-Predictor + ZhWiki-EditStreams 基准 + 端侧验证。

---

## 7. 待办（顺序）

1. 📚 精读五篇：《Edit Flows》(NeurIPS'25)、《Next Edit Prediction》(2508.10074)、《NysHD》(AAAI'25)、《Soft-Bayes》(PMLR'76)、infini-gram (2401.17377)。
2. ✏️ 先写 T4 与 T1 的证明草稿（最可落地，一周内可完成骨架）。
3. 🔬 搭 ZhWiki-EditStreams 抽取管线（dump → diff → 原子化）。
4. ✏️ 确定 φ 的精确定义（绑定/捆绑的具体代数，核的显式形式）。
5. 🔬 最小实现：HDC 专家 + ∞-gram 专家 + Soft-Bayes 混合器，与基线对表。
6. 📝 论文初稿（先写 §2–§4，理论定型后回填 §1/§5）。

---

## 8. 实现记录（v0，unattended run）

### 8.1 代码地图（`research/nes/`）

| 文件 | 作用 |
|---|---|
| `atoms.py` | 类型化编辑原子（7 类）+ `apply_atom` 判定 + diff→atoms |
| `corpus.py` | zhwiki 随机条目抓取（并行、缓存、manifest 记录许可） |
| `synth.py` | 扰动即真值：同音字/标点/赘字/漏标点/短语省略/列表符 → 修复原子标签；近失负例 |
| `features.py` | 特征场 φ：上下文 n-gram + 结构 + 跨度 + 行为槽；FNV-1a 哈希；HDC 双极编码 |
| `predictors.py` | HDC 原型（在线可加）、哈希 Softmax（GPU）、Markov/Prior 基线、温度校准、门控阈值搜索 |
| `content.py` | 接地内容层：最长匹配（∞-gram-lite）+ copy-only 校验 |
| `evaluate.py` | top-k / AUC / 逐类召回 / ECE / 门控 P-R / 报告生成 |
| `train.py` | 端到端编排（语料→合成→特征→训练→校准→评测→产物） |
| `export_for_browser.py` | 导出浏览器包（prototypes/base/softmax/test_vectors） |
| `browser/eft.mjs` | 零依赖 JS 参考推理（与 Python 逐位一致） |
| `browser/test_infer.mjs` | 金标向量一致性测试（Node） |
| `tests/test_core.py` | 29 项单元断言（原子判定/合成重构不变量/特征/内容层） |

### 8.2 v0 关键设计决策

1. **在"噪声态"上预测**：呈现给预测器的输入是用户当前（可能带错）的文档；标签是把噪声修回干净的原子。扰动即真值（无需老师模型、无需 diff 噪声）。
2. **多编辑一致性不变量**：同一文档多个扰动，修复原子按位置降序应用必须逐字重构原文（`AssertionError` 守门，已进单元测试）。
3. **近失负例**：在真实编辑位 ±(span+1..3) 处生成 NO_EDIT 负例——直接训练"位置精度"，而非只学"有没有编辑"。
4. **接地检查**：`INS_SPAN_COPY` 的 payload 必须在文档/语料中可查（`can_ground`），这是 T4 闭包定理的可执行版本。
5. **单次前向契约**：HDC 打分 = 捆绑 + 余弦（无循环）；Softmax 打分 = 稀疏点积；门控 = 校准后阈值。

### 8.3 数据集质量修复（实现中发现的真 bug）

1. duplicate 扰动误插双字符 → 单字符（重构不变量当场抓住）。
2. 短语省略 payload 空读（meta/data 混用）→ 修复；后续发现**第二次出现未纳入保护区间**导致 ~90% 文档被拒 → 短语的两个出现位置全部加入 blocked 区域。
3. **stale 变量 bug**：噪声构建循环未解构 `meta`，读到上一轮循环泄漏值 → 修复（全量合成拒绝率从 ~90% 降到 0.02%）。
4. 列表符扰动权重为 0；bullet 文档比例与权重提高（0.35 / 0.18）→ FMT_BULLET 从 11 条增至 386 条。
5. **文档级切分**取代样本级切分（避免同一文档的窗口泄漏到 test——合成数据评估的常见陷阱）。
6. 训练集 NO_EDIT 上采样比例设为 45%（近失负例 + 随机负例），test/val 保持自然分布。
7. 语料抓取 429 限流：并发降为 2、波间隔 0.4s；缓存复用条件按目标条目数判断。

### 8.4 运行状态（v0 完成）

- [x] 单元测试 29/29
- [x] 合成：2,161 篇语料 → 训练 32,867 样本（45% NO_EDIT 配平，文档级 train/val/test 切分）
- [x] 训练：HDC（8,192 维，在线可加）+ 哈希 Softmax（A2000/CUDA）+ 基线
- [x] 端侧导出：`artifacts/v0/browser/`（base 4MB / prototypes 0.44MB / softmax 0.9MB）
- [x] **金标一致性：HDC 最大偏差 3.5e-14，Softmax 2.4e-7，top-1 一致 200/200**
- [x] 报告与模型卡：`artifacts/v0/REPORT.md`、`MODEL_CARD.md`

### 8.5 v0 结果（test，文档留出）

| 模型 | top1 | top3 | edit-top1 | bal-acc | edit AUC | ECE | gate P | gate R |
|---|---|---|---|---|---|---|---|---|
| **softmax** | 0.704 | 0.995 | **0.750** | 0.794 | **0.893** | **0.021** | 0.878 | 0.602 |
| hdc | 0.618 | 1.000 | 0.583 | 0.603 | 0.796 | 0.249 | 0.913 | 0.532 |
| markov | 0.651 | 0.872 | 0.042 | 0.303 | 0.567 | 0.186 | 1.000 | 0.009 |
| prior（多数类） | 0.651 | 0.853 | 0.000 | 0.143 | 0.487 | 0.201 | — | — |

- 逐类召回（softmax）：FIX 0.69 / DEL_CHAR 0.65 / INS_CHAR 0.86 / DEL_SPAN 1.00 / COPY 0.68 / BULLET 1.00 / NO_EDIT 0.68
- 接地率：INS_SPAN_COPY 载荷 100% 可溯源（文档或语料）
- 延迟（Python 参考）：特征 0.033ms + softmax 0.030ms/样本（HDC 0.218ms）
- 端到端严格管线演示（gate→类→内容层→策略层）在留出样本上 2/6——级联过滤（门控召回 0.60 × 内容可用性 × 破坏性操作策略）是主要原因，预测器本体 edit-top1 = 0.75

### 8.6 实现期抓到的 9 个真 bug（论文附录素材）

1. duplicate 扰动误插双字符（多编辑重构不变量当场拒绝）
2. 短语省略 payload 读空（meta/data 混用）
3. 第二次出现未保护 → 90% 文档被拒
4. 噪声循环 stale `meta` 变量泄漏
5. 样本级切分泄漏文档 → 改文档级切分
6. 特征缓存无哈希校验 → 复用陈旧数组（索引越界）
7. JS 布尔字面量大小写（特征名哈希错位）
8. JS ASCII-only 字符类 vs Python Unicode `isalpha/isdigit`
9. JS UTF-16 切片 vs Python 码点；HDC `if(!byte) continue` 漏投 8 个 -1 票

### 8.7 下一步（v0.1 → 论文版）

1. 语料扩充（限流放宽后 ≥10k 篇）+ passes 24；特征 v3（词级三元组、编辑历史槽位做实）
2. 全位置扫掠式端到端评测（precision@k、首次命中延迟）
3. 内容层升级后缀自动机；ONNX 导出（Gather+Sum+Sign 可表达）
4. 逐类门限与策略层学习（当前为手写规则）
5. 论文侧：T1/T4 证明草稿 + 本文实现细节回填 §5 实验章节

### 8.5 待升级项（论文版）

1. 内容层升级为后缀数组/自动机（当前 str.find 最长匹配，毫秒级但非 O(m)）。
2. 位置扫掠式端到端评测（当前为逐样本评测 + 近失负例代理）。
3. FMT_BULLET 类占比低（合成中约 2%），需要单独的列表文档流。
4. ONNX 导出（HDC 捆绑可在 ONNX 内表达为 Gather+Sum+Sign）供 transformers.js 生态复用。
5. 用户在线更新回放实验（regret 曲线 vs √T，对齐 T3）。
