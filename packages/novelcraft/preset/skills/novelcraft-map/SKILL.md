---
name: novelcraft-map
description: NovelCraft AI 地图册: run 状态机(planning/prompt_review/generating/review_ready/partial/failed/completed)、候选页采用/拒绝/重试、标注编辑、费用确认。地图册任务先读本 skill。
whenToUse: 作者要生成/审核地图册页面、处理生成失败、编辑标注时。
---

# NovelCraft AI 地图册

## 事实模型

- map_atlas_runs(一次规划/生成 run, 授权+secret-free 快照) → nodes(层级,
  跨 run)→ pages(候选/已采用/拒绝/移出) → annotations(名称标注/坐标)。
- 图片由固定 gpt-image-2 生成, 存私有 S3(图片字节不入库); 浏览器经
  owner+novel_id 双门禁读取。
- 候选页分别记录: 直接来源 / AI 视觉补全 / 资料冲突; 采用只改地图册画廊,
  不写回世界/记忆/正文事实。

## 工作流

- 创建 run: POST /api/world/map-atlas/{novel_id}/runs(202 task_id) →
  轮询 run 状态; 页面规划基于已确认资料(RAG map_atlas 证据 + 可选工作稿)。
- confirm-prompts 后再生图; 每页: adopt / reject / archive / restore /
  retry / regenerate / edit(prompt); retry 可能重复计费 → 需作者确认费用。
- 标注层只显示地点/地标名称, 不显示层级/方向/距离/比例/图例。

## agent 纪律

- 规划/生成中的冲突与视觉补全逐页向作者说明; 不把图片内容当作新世界事实。
- 重试/重新生成前明确提示费用确认(provider_in_flight 失联时禁止无条件自动重试)。
