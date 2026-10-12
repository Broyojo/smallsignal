# Development Workflow

### 规则与入口

仓库开发流程的唯一导航。原版 Skill 决定方法步骤；工程文档决定契约、验证和
发布义务。用户明确限定的范围持续有效。方法与规则冲突时说明冲突和影响，形成
显式决策后更新对应规则。

| 阶段     | Skill           | 进入前需要                     | 完成后得到                      |
| -------- | --------------- | ------------------------------ | ------------------------------- |
| 需求     | grill-with-docs | 问题、约束、当前行为           | 经用户确认的共同理解            |
| Spec     | to-spec         | 已讨论结论                     | Issue、验收与已确认测试边界     |
| 拆分     | to-tickets      | 需要交接的 Spec                | 经确认的纵向 tickets 与阻塞关系 |
| 实现     | implement       | 可引用需求、负责人、分支与基线 | 验证、双轴审查和 commit         |
| 整套实施 | implement-spec  | 已发布 Spec 与带阻塞的 tickets | 按 frontier 并行、逐票交付      |
| 独立审查 | code-review     | 固定 diff 范围与 Spec          | 独立 Standards / Spec 报告      |
| 交付     | pr              | 经审查的候选与证据             | PR，再由交付设施验证并发布      |
| 回顾     | retro           | 指定会话来源                   | 待人工选择的改进候选            |

调用与注册见 references/README.md；会话所在 checkout 必须包含 `.agents/skills/`。

需求明确的小任务直接实施。拆票只用于多人、多会话或真实阻塞；每票交付一条可
验证的纵向行为。宽机械重构按原版 expand–contract 例外。用户可一次授权多个
阶段；已确认决策在阶段间继承，新事实使其失效时重新讨论。不额外重复 implement
已包含的 tdd 和 code-review。

并发任务用独立 branch/worktree，分支 `codex/issue-<n>-<topic>`（用户指定优先）。

implement-spec 沿用 frontier 调度和每票一个 worktree 的子代理，并替换如下：

- 子代理按 `.agents/skills/implement/SKILL.md` 原文处理 ticket，不经 Skill 工具
  调用 implement；其中 tdd 与 code-review 照常调用。
- 每个 ticket 按 pr 与 docs/deployment.md 单独交付，Production 验收后关闭；
  不建集成分支，不做最终合并审查，由父 Issue 的全部范围验收覆盖整个 Spec。
- 阻塞 ticket 合入 main 后，下游从 main 开新 worktree；其 Production 验收失败
  时先按 docs/deployment.md 修复或回滚。

### 实现与审查

实施前读取关联 Issue 正文、有效澄清和相关产品契约，确定固定比较基线。契约
改变时在同一目标中更新它并核对调用者；文档规则见 AGENTS.md「Documentation」。

在已确认的公共 seam 执行原版 TDD（测试原则见 docs/testing/README.md），完成
其中的检查后执行原版 code-review。

审查输入：已提交候选用 `git diff <base>...HEAD`；未提交时只暂存目标文件（含
新增），两路都读 `git diff --cached <target-base> -- <owned-paths>`。不覆盖他人
暂存内容；修复后重新暂存并复核；提交只含审查过的目标内容。

两路各用独立上下文，输出各不超过 400 words，分开呈现：

- Standards：固定 diff、CODING_STANDARDS、原版气味基线；项目标准优先，跳过
  工具已查事项。
- Spec：同一 diff、完整验收需求及相关澄清。没有 Spec 时报告该轴无法完成，
  不计为通过。

确定性问题完成前修复；判断性建议逐项决定并说明。修复与原发现重新核对；需求
变化先同步需求来源。commit 只含目标文件，说明改变、原因、验证、限制和
Test-Impact。

### 交付与完成

正常产品请求包含交付；local-only 或分支试行到指定边界为止。pr 用原版
Summary / Evidence / Merge Danger。交付步骤见 docs/deployment.md；合并后
Production 通过运行验收才算完成，无部署的文档变更完成文档验收即可。ticket
验收后关闭；父 Issue 全部范围验收后才关闭，拆票发布阶段不改动父 Issue；PR
自动关闭语法不能替代生产验收。

### 特殊入口

- 疑难缺陷：读取 manifest 固定版本的 diagnosing-bugs 原文，走完整诊断过程；
  普通缺陷直接修复并保护行为。
- improve-codebase-architecture：反复改动困难或缺少测试 seam 时显式使用，选中
  候选作为新目标进入需求流程。
- prototype 只带回验证过的决定，原型留独立分支；wizard 中 Agent 不经手密钥。
- handoff 文档放仓库外系统临时目录；retro 的改进候选由用户选择后执行。
