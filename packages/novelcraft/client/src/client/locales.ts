// 文案键(中英双语; 语言面由 DSH locale 服务解析)。
export const NS = 'novelcraft'

type AdditionalNovelcraftKey =
  | 'actions.open'
  | 'common.loading'
  | 'common.loadFailed'
  | 'common.retry'
  | 'common.unknownItem'
  | 'common.untitled'
  | 'common.statusUnknown'
  | 'common.none'
  | 'pet.connecting'
  | 'pet.disconnected'
  | 'pet.stale'
  | 'inbox.count'
  | 'inbox.chatBusy'
  | 'inbox.sent'
  | 'inbox.prompt.accept'
  | 'inbox.prompt.modify'
  | 'inbox.reason.reject'
  | 'inbox.reason.modify'
  | 'inbox.keyboard'
  | 'inbox.category.ingest'
  | 'inbox.category.dedup'
  | 'inbox.category.suggest'
  | 'inbox.category.plot'
  | 'inbox.category.risk'
  | 'inbox.category.writing'
  | 'inbox.category.other'
  | 'workflow.otherActions'
  | 'workflow.history'
  | 'book.createToggle'
  | 'book.nameLabel'
  | 'book.createHint'
  | 'book.prompt.create'
  | 'book.prompt.open'
  | 'story.mode.view'
  | 'story.mode.plan'
  | 'story.chapterNumber'
  | 'outline.taskLabel'
  | 'outline.preview.story'
  | 'outline.preview.thread'
  | 'outline.preview.arc'
  | 'outline.prompt.sources'
  | 'outline.prompt.drafts'
  | 'outline.prompt.preview'
  | 'outline.prompt.apply'
  | 'desk.chatBusy'
  | 'desk.mode.chapters'
  | 'desk.mode.proposals'
  | 'desk.mode.reviews'
  | 'desk.chapters.empty'
  | 'desk.proposals.create'
  | 'desk.proposals.use'
  | 'desk.proposals.intent'
  | 'desk.proposals.pending'
  | 'desk.proposals.readOnly'
  | 'desk.reviews.findings'
  | 'desk.prompt.import'
  | 'desk.prompt.propose'
  | 'desk.prompt.continue'
  | 'preset.purpose.writing'
  | 'preset.purpose.import'
  | 'preset.purpose.polish'
  | 'preset.purpose.custom'
  | 'preset.details'
  | 'preset.advanced'
  | 'preset.maxOutput'
  | 'preset.timeout'
  | 'preset.minutes'
  | 'preset.effort.low'
  | 'preset.effort.medium'
  | 'preset.effort.high'
  | 'preset.effort.max'
  | 'world.tab.create'
  | 'world.tab.content'
  | 'world.taskLabel'
  | 'world.references'
  | 'world.references.empty'
  | 'world.pageIntent'
  | 'world.existingPage'
  | 'world.existingPageHint'
  | 'world.improve'
  | 'world.page.draft'
  | 'world.page.published'
  | 'world.run.chat'
  | 'world.run.converge'
  | 'world.run.explore'
  | 'world.run.inspect'
  | 'world.run.bible'
  | 'world.prompt.references'
  | 'world.prompt.referenceItem'
  | 'world.prompt.drafts'
  | 'world.prompt.newPage'
  | 'world.prompt.existingPage'
  | 'world.prompt.mode'
  | 'world.prompt.request'
  | 'world.prompt.publish'
  | 'atlas.status.pending'
  | 'atlas.status.adopted'
  | 'atlas.status.rejected'
  | 'atlas.status.archived'
  | 'atlas.placeholder'
  | 'atlas.conflicts'
  | 'atlas.imageMissing'
  | 'atlas.largeImage'
  | 'atlas.noImage'
  | 'atlas.visualBrief'
  | 'atlas.imageGuide'
  | 'atlas.copyGuide'
  | 'atlas.supported'
  | 'atlas.visualFill'
  | 'atlas.annotations'
  | 'atlas.annotation.default'
  | 'atlas.annotation.add'
  | 'atlas.annotation.name'
  | 'atlas.annotation.delete'
  | 'atlas.annotation.hint'
  | 'atlas.annotation.saving'
  | 'atlas.annotation.save'
  | 'atlas.annotation.saved'
  | 'atlas.annotation.queued'
  | 'atlas.annotation.discardConfirm'
  | 'atlas.annotation.failed'
  | 'atlas.annotation.nameRequired'
  | 'atlas.chatBusyQueued'
  | 'atlas.chatBusy'
  | 'atlas.imageTooLarge'
  | 'atlas.uploadFailed'
  | 'atlas.selectedPage'
  | 'atlas.unbound'
  | 'atlas.tab.mine'
  | 'atlas.tab.pending'
  | 'atlas.runSummary'
  | 'atlas.pagesUnit'
  | 'atlas.runNeedsAttention'
  | 'atlas.queuePending'
  | 'atlas.empty'
  | 'atlas.plan'
  | 'atlas.mine.empty'
  | 'atlas.pending.empty'
  | 'atlas.selectNode'
  | 'atlas.choosePage'
  | 'atlas.placeholderHint'
  | 'atlas.uploading'
  | 'atlas.upload'
  | 'atlas.prompt.import'
  | 'atlas.prompt.applyLabels'
  | 'atlas.prompt.plan'
  | 'workflow.prompt.resume'
  | 'workflow.prompt.clear'
  | 'workflow.prompt.restart'

export type NovelcraftKey = AdditionalNovelcraftKey
  | 'actions.title'
  | 'pet.silent'
  | 'pet.glow'
  | 'pet.busy'
  | 'pet.attention'
  | 'pet.title'
  | 'atlas.title'
  | 'pet.plot'
  | 'inbox.title'
  | 'inbox.empty'
  | 'inbox.unbound'
  | 'inbox.threshold'
  | 'inbox.refresh'
  | 'inbox.close'
  | 'inbox.verb.accept'
  | 'inbox.verb.reject'
  | 'inbox.verb.modify'
  | 'inbox.verb.defer'
  | 'inbox.reason.placeholder'
  | 'inbox.reason.confirm'
  | 'inbox.status.open'
  | 'inbox.status.accepted'
  | 'inbox.status.rejected'
  | 'inbox.status.deferred'
  | 'inbox.status.resolved'
  | 'inbox.evidence'
  | 'inbox.action'
  | 'inbox.act.fail'
  | 'inbox.done.adopt'
  | 'inbox.done.record'
  | 'story.title'
  | 'workflow.title'
  | 'workflow.unbound'
  | 'workflow.empty'
  | 'workflow.loading'
  | 'workflow.chatBusy'
  | 'workflow.requested'
  | 'workflow.kind.import'
  | 'workflow.kind.atlas'
  | 'workflow.state.running'
  | 'workflow.state.needs-attention'
  | 'workflow.state.completed'
  | 'workflow.state.failed'
  | 'workflow.progress'
  | 'workflow.phase'
  | 'workflow.scope'
  | 'workflow.resume'
  | 'workflow.abandon'
  | 'workflow.restart'
  | 'workflow.restartHint'
  | 'book.title'
  | 'book.current'
  | 'book.unbound'
  | 'book.empty'
  | 'book.open'
  | 'book.create'
  | 'book.name'
  | 'book.chatBusy'
  | 'book.requested'
  | 'story.empty'
  | 'story.unbound'
  | 'story.threads'
  | 'story.arcs'
  | 'story.foreshadowing'
  | 'story.reveals'
  | 'story.scenes'
  | 'story.edges'
  | 'story.edge.other'
  | 'story.edge.serves_thread'
  | 'story.edge.belongs_to_arc'
  | 'story.edge.reveals_foreshadowing'
  | 'story.edge.pays_off_in_scene'
  | 'story.edge.references_character'
  | 'story.edge.references_entity'
  | 'story.edge.references_memory'
  | 'story.chapters'
  | 'outline.workbench'
  | 'outline.target'
  | 'outline.target.story'
  | 'outline.target.thread'
  | 'outline.target.arc'
  | 'outline.task'
  | 'outline.sources'
  | 'outline.sources.empty'
  | 'outline.includeDrafts'
  | 'outline.preview'
  | 'outline.previews'
  | 'outline.previews.empty'
  | 'outline.receipt'
  | 'outline.warnings'
  | 'outline.apply'
  | 'outline.chatBusy'
  | 'outline.requested'
  | 'world.title'
  | 'world.unbound'
  | 'world.mode'
  | 'world.mode.chat'
  | 'world.mode.converge'
  | 'world.mode.explore'
  | 'world.mode.inspect'
  | 'world.mode.bible'
  | 'world.task'
  | 'world.objects'
  | 'world.objects.empty'
  | 'world.pages'
  | 'world.pages.empty'
  | 'world.page.noSummary'
  | 'world.publish'
  | 'world.includeDrafts'
  | 'world.newPage'
  | 'world.run'
  | 'world.chatBusy'
  | 'world.requested'
  | 'desk.title'
  | 'desk.empty'
  | 'desk.unbound'
  | 'desk.mode.watch'
  | 'desk.mode.plan'
  | 'desk.mode.review'
  | 'desk.mode.reference'
  | 'desk.mode.import'
  | 'intake.choose'
  | 'intake.hint'
  | 'intake.staging'
  | 'intake.fail'
  | 'intake.tooLarge'
  | 'intake.previewTitle'
  | 'intake.previewSummary'
  | 'intake.noHeadings'
  | 'intake.unrecognizedLong'
  | 'intake.confirm'
  | 'desk.chapters'
  | 'desk.objects'
  | 'desk.reviews'
  | 'desk.reviews.empty'
  | 'desk.proposals'
  | 'desk.proposals.empty'
  | 'desk.proposals.basis'
  | 'desk.proposals.cost'
  | 'desk.proposals.risk'
  | 'desk.proposals.sources'
  | 'dossier.title'
  | 'dossier.back'
  | 'dossier.unbound'
  | 'dossier.missing'
  | 'dossier.status'
  | 'dossier.words'
  | 'dossier.scenes'
  | 'dossier.scene.goal'
  | 'dossier.scene.conflict'
  | 'dossier.scene.must'
  | 'dossier.scene.mustNot'
  | 'dossier.scene.tag'
  | 'dossier.characters'
  | 'dossier.pov'
  | 'dossier.foreshadowing'
  | 'dossier.foreshadowing.planted'
  | 'dossier.foreshadowing.active'
  | 'dossier.foreshadowing.due'
  | 'dossier.reveals'
  | 'dossier.objects'
  | 'dossier.rhythm'
  | 'dossier.rhythm.words'
  | 'dossier.rhythm.scenes'
  | 'dossier.rhythm.avg'
  | 'dossier.review'
  | 'dossier.signals'
  | 'dossier.proposal'
  | 'dossier.empty'
  | 'preset.title'
  | 'preset.unbound'
  | 'preset.current'
  | 'preset.use'
  | 'preset.default.name'
  | 'preset.default.desc'
  | 'preset.available'
  | 'preset.effort'
  | 'preset.effort.default'
  | 'preset.effort.adapterDefault'
  | 'preset.select.ok'
  | 'preset.select.fail'
  | 'preset.source.seed'
  | 'preset.source.stored'
  | 'chapter.view'
  | 'chapter.select'
  | 'chapter.option'
  | 'chapter.unbound'
  | 'chapter.empty'
  | 'chapter.createFirst'
  | 'chapter.new'
  | 'chapter.refresh'
  | 'chapter.title'
  | 'chapter.body'
  | 'chapter.status'
  | 'chapter.edit'
  | 'chapter.save'
  | 'chapter.saving'
  | 'chapter.cancel'
  | 'chapter.editingFinishedDraftKept'
  | 'chapter.saveFailed'
  | 'chapter.chatDraftBusy'
  | 'chapter.unsavedChangesBlocked'
  | 'chapter.conflictTitle'
  | 'chapter.conflictKept'
  | 'chapter.conflictCopy'
  | 'chapter.conflictRecover'
  | 'chapter.conflictRecovered'
  | 'chapter.history'
  | 'chapter.current'
  | 'chapter.bytes'
  | 'chapter.invalidHash'
  | 'chapter.diff'
  | 'chapter.noDiff'
  | 'chapter.truncated'
  | 'chapter.restore'
  | 'chapter.restoreRequested'
  | 'chapter.review'
  | 'chapter.reviewCurrent'
  | 'chapter.reviewCandidate'
  | 'chapter.reviewRequested'
  | 'chapter.noReview'
  | 'chapter.fresh'
  | 'chapter.stale'
  | 'chapter.selectFinding'
  | 'chapter.reviseSelected'
  | 'chapter.reviseRequested'
  | 'chapter.candidate'
  | 'chapter.adoptCandidate'
  | 'chapter.adoptRequested'
  | 'chapter.rejectReason'
  | 'chapter.rejectCandidate'
  | 'chapter.rejectRequested'

export const zh: Record<NovelcraftKey, string> = {
  'actions.title': 'NovelCraft 功能',
  'actions.open': 'NovelCraft',
  'common.loading': '正在加载…',
  'common.loadFailed': '暂时无法加载，请稍后重试。',
  'common.retry': '重试',
  'common.unknownItem': '未知内容',
  'common.untitled': '未命名',
  'common.statusUnknown': '状态未知，请刷新或重试',
  'common.none': '暂无',
  'pet.silent': '静默',
  'pet.glow': '微光',
  'pet.busy': '忙碌',
  'pet.attention': '待确认',
  'pet.connecting': '连接中',
  'pet.disconnected': '连接中断',
  'pet.stale': '状态可能过期',
  'pet.title': 'NovelCraft 守望',
  'atlas.title': '地图册',
  'atlas.status.pending': '待确认',
  'atlas.status.adopted': '已采用',
  'atlas.status.rejected': '已拒绝',
  'atlas.status.archived': '已归档',
  'atlas.placeholder': '待上传图片',
  'atlas.conflicts': '采用前需要确认的设定冲突',
  'atlas.imageMissing': '原图暂时无法读取，可以重新上传。',
  'atlas.largeImage': '图片较大，当前只显示尺寸和大小：',
  'atlas.noImage': '这一页还没有图片。上传后就能添加标签。',
  'atlas.visualBrief': '画面说明',
  'atlas.imageGuide': '图片生成参考',
  'atlas.copyGuide': '复制参考',
  'atlas.supported': '来自原文和已有设定',
  'atlas.visualFill': '待你确认的视觉补充',
  'atlas.annotations': '地图标签',
  'atlas.annotation.default': '标签',
  'atlas.annotation.add': '添加标签',
  'atlas.annotation.name': '标签名称',
  'atlas.annotation.delete': '删除',
  'atlas.annotation.hint': '可以在图片上拖动标签，也可以在下方直接改名或删除。',
  'atlas.annotation.saving': '正在提交…',
  'atlas.annotation.save': '交给助手保存',
  'atlas.annotation.saved': '已保存',
  'atlas.annotation.queued': '已提交，等待助手应用',
  'atlas.annotation.discardConfirm': '地图标签还有未提交的修改。确定放弃这些修改吗？',
  'atlas.annotation.failed': '暂时无法提交，本页修改仍然保留，可以重试。',
  'atlas.annotation.nameRequired': '标签名称不能为空。',
  'atlas.chatBusyQueued': '标签修改已保存为待处理内容。请先处理对话输入框里的草稿，然后告诉助手保存地图标签。',
  'atlas.chatBusy': '对话输入框里还有未发送的内容。请先发送或清空，我们不会覆盖它。',
  'atlas.imageTooLarge': '图片超过 50 MB，请压缩后重试。',
  'atlas.uploadFailed': '图片暂时无法上传，请检查格式和尺寸后重试。',
  'atlas.selectedPage': '选中的地图页',
  'atlas.unbound': '请先在书库中打开一本书。',
  'atlas.tab.mine': '我的地图册',
  'atlas.tab.pending': '待完善',
  'atlas.runSummary': '最近一次规划',
  'atlas.pagesUnit': '页',
  'atlas.runNeedsAttention': '这次规划需要你确认或重试。',
  'atlas.queuePending': '项标签修改等待助手处理',
  'atlas.empty': '还没有地图册。可以让助手先根据现有设定规划地图页。',
  'atlas.plan': '请助手规划地图册',
  'atlas.mine.empty': '还没有已采用的地图页。',
  'atlas.pending.empty': '暂时没有待完善的地图页。',
  'atlas.selectNode': '从左侧选择一个地图页查看详情。',
  'atlas.choosePage': '这个地点有多个地图页，请先选择具体页面。',
  'atlas.placeholderHint': '这一页还没有图片，可以直接上传。',
  'atlas.uploading': '正在检查图片…',
  'atlas.upload': '为当前页上传图片',
  'atlas.prompt.import': '请导入我刚才选择的地图图片《{file}》，放到“{page}”下。',
  'atlas.prompt.applyLabels': '请保存我刚才提交的地图标签修改。',
  'atlas.prompt.plan': '请为这本书规划一套地图册，先生成待确认的地图页方案。',
  'pet.plot': '当前剧情',
  'inbox.title': '待处理',
  'inbox.empty': '暂时没有需要你决定的事情。',
  'inbox.unbound': '请先在书库中打开一本书。',
  'inbox.threshold': '待确认阈值',
  'inbox.refresh': '刷新',
  'inbox.close': '关闭',
  'inbox.verb.accept': '采用建议',
  'inbox.verb.reject': '不采用',
  'inbox.verb.modify': '修改建议',
  'inbox.verb.defer': '稍后处理',
  'inbox.reason.placeholder': '一句话理由(校准原料, 必填)',
  'inbox.reason.confirm': '确认',
  'inbox.reason.reject': '为什么不采用？',
  'inbox.reason.modify': '你希望怎么改？',
  'inbox.count': '需要处理',
  'inbox.keyboard': '快捷键：j/k 切换 · u 刷新 · Esc 关闭',
  'inbox.category.ingest': '导入',
  'inbox.category.dedup': '重复内容',
  'inbox.category.suggest': '设定建议',
  'inbox.category.plot': '剧情',
  'inbox.category.risk': '设定冲突',
  'inbox.category.writing': '写作',
  'inbox.category.other': '其他',
  'inbox.status.open': '待处理',
  'inbox.status.accepted': '已采纳',
  'inbox.status.rejected': '已打回',
  'inbox.status.deferred': '先放着',
  'inbox.status.resolved': '已解决',
  'inbox.evidence': '证据',
  'inbox.action': '建议动作',
  'inbox.act.fail': '操作失败',
  'inbox.chatBusy': '对话输入框已有未发送内容；事项仍保留，请先发送或清空。',
  'inbox.sent': '已交给助手处理；完成前事项会继续保留。',
  'inbox.prompt.accept': '请先读取待处理事项“{title}”（事项编号：{id}），完成对应操作和必要审批后再将它标记为已解决。',
  'inbox.prompt.modify': '请先读取待处理事项“{title}”（事项编号：{id}），按这个要求调整后完成对应操作：{reason}。操作失败时保留事项。',
  'inbox.done.adopt': '已记录采纳决定',
  'inbox.done.record': '已记录',
  'story.title': '剧情地图',
  'workflow.title': '任务进度',
  'workflow.unbound': '请先在书库中打开一本书。',
  'workflow.empty': '暂时没有进行中或需要继续的任务。',
  'workflow.loading': '刷新中…',
  'workflow.chatBusy': '对话输入框已有未发送内容，请先发送或清空。',
  'workflow.requested': '已交给助手处理。',
  'workflow.kind.import': '深度导入',
  'workflow.kind.atlas': '地图册',
  'workflow.state.running': '进行中',
  'workflow.state.needs-attention': '需要确认',
  'workflow.state.completed': '已完成',
  'workflow.state.failed': '失败',
  'workflow.progress': '任务进度',
  'workflow.phase': '当前阶段',
  'workflow.scope': '章节范围',
  'workflow.resume': '继续任务',
  'workflow.abandon': '清除任务记录',
  'workflow.restart': '重新导入',
  'workflow.restartHint': '如果旧任务无法继续，可重新导入这些章节：',
  'workflow.otherActions': '其他操作',
  'workflow.history': '已完成',
  'workflow.prompt.resume': '请继续“{kind}”任务。任务编号：{id}。',
  'workflow.prompt.clear': '请清除这条“{kind}”任务记录，不要删除已经导入或生成的内容。任务编号：{id}。',
  'workflow.prompt.restart': '请重新导入第 {start}–{end} 章，不沿用旧任务。',
  'book.title': '书库',
  'book.current': '当前',
  'book.unbound': '当前还没有打开任何书。',
  'book.empty': '书库还是空的，先创建第一本书吧。',
  'book.open': '打开这本书',
  'book.create': '创建并打开',
  'book.name': '输入书名',
  'book.createToggle': '新建一本书',
  'book.nameLabel': '书名',
  'book.createHint': '创建完成后会自动打开，需要你在 DSH 中确认操作。',
  'book.prompt.create': '请创建一本新书《{book}》，创建完成后打开它。',
  'book.prompt.open': '请打开书库中的《{title}》。精确书库标识：{book}。',
  'book.chatBusy': '对话输入框已有未发送内容，请先发送或清空。',
  'book.requested': '已交给助手处理。',
  'story.empty': '还没有剧情结构。先告诉助手你想写的方向吧。',
  'story.unbound': '请先在书库中打开一本书。',
  'story.mode.view': '查看剧情结构',
  'story.mode.plan': '规划剧情结构',
  'story.chapterNumber': '第 {index} 章',
  'story.threads': '剧情线',
  'story.arcs': '篇章纲',
  'story.foreshadowing': '伏笔',
  'story.reveals': '回收',
  'story.scenes': '场景',
  'story.edges': '剧情关系',
  'story.edge.other': '其他',
  'story.edge.serves_thread': '服务剧情线',
  'story.edge.belongs_to_arc': '归属篇章',
  'story.edge.reveals_foreshadowing': '回收伏笔',
  'story.edge.pays_off_in_scene': '落地场景',
  'story.edge.references_character': '引用角色',
  'story.edge.references_entity': '引用实体',
  'story.edge.references_memory': '引用记忆',
  'story.chapters': '章节',
  'outline.workbench': '剧情结构规划',
  'outline.target': '想规划什么？',
  'outline.target.story': '全书总纲',
  'outline.target.thread': '剧情线',
  'outline.target.arc': '篇章纲',
  'outline.taskLabel': '你的要求',
  'outline.task': '例如：希望中段冲突更集中，同时保留现有结局…',
  'outline.sources': '选择参考内容（可选）',
  'outline.sources.empty': '暂时没有可选的参考内容。',
  'outline.includeDrafts': '也参考我选中的草稿和待确认内容',
  'outline.preview': '生成预览',
  'outline.preview.story': '生成全书总纲预览',
  'outline.preview.thread': '生成剧情线预览',
  'outline.preview.arc': '生成篇章预览',
  'outline.prompt.sources': '参考内容：{sources}。',
  'outline.prompt.drafts': '可以参考我明确选中的草稿和待确认内容。',
  'outline.prompt.preview': '请生成{target}预览。我的要求：{input}。{sources}{drafts}',
  'outline.prompt.apply': '请采用“{title}”这个结构方案。方案编号：{id}。',
  'outline.previews': '最近预览',
  'outline.previews.empty': '还没有总纲或结构预览。',
  'outline.receipt': '参考内容',
  'outline.warnings': '需确认',
  'outline.apply': '采用这个方案',
  'outline.chatBusy': '对话输入框已有未发送内容，请先发送或清空。',
  'outline.requested': '请求已交给助手；预览不会直接成为已采用内容，采用仍需审批。',
  'world.title': '世界书',
  'world.unbound': '请先在书库中打开一本书。',
  'world.tab.create': '共创设定',
  'world.tab.content': '世界书内容',
  'world.mode': '这次想做什么？',
  'world.mode.chat': '一起讨论一个设定',
  'world.mode.converge': '把零散想法整理清楚',
  'world.mode.explore': '继续想几个新方向',
  'world.mode.inspect': '检查已有设定的问题',
  'world.mode.bible': '生成一页世界书草稿',
  'world.taskLabel': '你想处理的问题',
  'world.task': '例如：这座城市为什么能长期维持浮空？',
  'world.references': '参考已有设定（可选）',
  'world.references.empty': '暂时没有可选的设定或页面。',
  'world.objects': '已采用的设定',
  'world.objects.empty': '还没有已采用的设定。',
  'world.pages': '世界书页',
  'world.pages.empty': '还没有世界书页。',
  'world.page.noSummary': '本页暂无摘要。',
  'world.publish': '发布到世界书',
  'world.includeDrafts': '也参考我选中的草稿',
  'world.pageIntent': '页面方式',
  'world.newPage': '创建新页面',
  'world.existingPage': '继续完善已有页面',
  'world.existingPageHint': '请先在“参考已有设定”中选择一个世界书页面。',
  'world.improve': '一起继续完善',
  'world.page.draft': '待发布',
  'world.page.published': '已发布',
  'world.run': '交给助手',
  'world.run.chat': '开始讨论',
  'world.run.converge': '帮我整理清楚',
  'world.run.explore': '提供新方向',
  'world.run.inspect': '检查已有设定',
  'world.run.bible': '生成世界书草稿',
  'world.prompt.references': '参考内容：{references}。',
  'world.prompt.referenceItem': '《{title}》（资料标识 {reference}）',
  'world.prompt.drafts': '可以参考我明确选中的草稿。',
  'world.prompt.newPage': '请生成一页新的世界书草稿。',
  'world.prompt.existingPage': '请基于我选中的世界书页继续完善。',
  'world.prompt.mode': '请{mode}。',
  'world.prompt.request': '{intent}我想处理的问题：{input}。{references}{drafts}',
  'world.prompt.publish': '请发布世界书草稿《{title}》，精确资料标识为 {reference}。',
  'world.chatBusy': '对话输入框已有未发送内容，请先发送或清空。',
  'world.requested': '请求已交给助手；讨论/检视零写入，草稿发布仍需审批。',
  'desk.title': '写作台',
  'desk.empty': '暂无内容。',
  'desk.unbound': '请先在书库中打开一本书。',
  'desk.chatBusy': '对话输入框里还有未发送的内容。请先发送或清空，我们不会覆盖它。',
  'desk.mode.chapters': '章节',
  'desk.mode.proposals': '续写建议',
  'desk.mode.reviews': '审查记录',
  'desk.mode.watch': '守望',
  'desk.mode.plan': '计划',
  'desk.mode.review': '评审',
  'desk.mode.reference': '参照',
  'desk.mode.import': '导入',
  'intake.choose': '选择 .txt / .md 手稿',
  'intake.hint': '选择手稿后先核对分章预览，再交给助手导入。支持 .txt 和 .md，最大 50 MB。',
  'intake.staging': '正在校验并暂存…',
  'intake.fail': '文件授权失败, 请检查格式后重试。',
  'intake.tooLarge': '文件超过 50MB, 请拆分后重试。',
  'intake.previewTitle': '分章预览',
  'intake.previewSummary': '识别到 {count} 章 · 标题前内容 {preamble} 字',
  'intake.noHeadings': '未识别到章节标题，将按单章导入。',
  'intake.unrecognizedLong': '长稿未识别到章节标题，已阻止导入。请加入“第X章”或“# 第X章”标题后重新选择。',
  'intake.confirm': '确认分章并交给助手',
  'desk.chapters': '章节',
  'desk.chapters.empty': '还没有可查看的章节。',
  'desk.objects': '世界对象',
  'desk.reviews': '审查记录',
  'desk.reviews.empty': '还没有章节审查记录。',
  'desk.reviews.findings': '发现问题',
  'desk.prompt.import': '请导入我刚才选择的手稿《{file}》，按章节整理后写入这本书。',
  'desk.prompt.propose': '请以第 {chapter} 章为起点，为下一章提供 2–3 个续写方向。我的写作意图：{intent}',
  'desk.prompt.continue': '请按“{title}”这个方向续写第 {chapter} 章。任务编号：{run}；方案编号：{proposal}。',
  'desk.proposals': '续写建议',
  'desk.proposals.empty': '还没有续写建议。',
  'desk.proposals.create': '生成续写建议',
  'desk.proposals.use': '按这个方向续写',
  'desk.proposals.intent': '这一章我想完成什么（可选）',
  'desk.proposals.pending': '已有待确认稿，请先处理',
  'desk.proposals.readOnly': '这是旧版建议，可以查看，但无法精确选中续写。',
  'desk.proposals.basis': '依据',
  'desk.proposals.cost': '成本',
  'desk.proposals.risk': '风险',
  'desk.proposals.sources': '参考 {used} 项 · 省略 {omitted} 项 · 警告 {warnings} 项',
  'dossier.title': '章节档案',
  'dossier.back': '返回列表',
  'dossier.unbound': '请先在书库中打开这本书。',
  'dossier.missing': '这一章还没有导入，暂时没有档案。',
  'dossier.status': '状态',
  'dossier.words': '字',
  'dossier.scenes': '场景拆解',
  'dossier.scene.goal': '目标',
  'dossier.scene.conflict': '核心冲突',
  'dossier.scene.must': '必发生',
  'dossier.scene.mustNot': '禁发生',
  'dossier.scene.tag': '场景作用',
  'dossier.characters': '人物在场',
  'dossier.pov': '视角人物',
  'dossier.foreshadowing': '伏笔对账',
  'dossier.foreshadowing.planted': '种下',
  'dossier.foreshadowing.active': '经过',
  'dossier.foreshadowing.due': '应回收',
  'dossier.reveals': '回收揭示',
  'dossier.objects': '设定引用',
  'dossier.rhythm': '节奏',
  'dossier.rhythm.words': '字数',
  'dossier.rhythm.scenes': '场景数',
  'dossier.rhythm.avg': '均长',
  'dossier.review': '语义审查',
  'dossier.signals': '待留意事项',
  'dossier.proposal': '续写建议',
  'dossier.empty': '暂无',
  'preset.title': '模型预设',
  'preset.unbound': '这本书还没绑定工作区。',
  'preset.current': '当前使用',
  'preset.use': '使用这个预设',
  'preset.default.name': '跟随当前助手',
  'preset.default.desc': '这本书不单独设置模型。',
  'preset.available': '已连接的模型服务',
  'preset.effort': '思考强度',
  'preset.effort.default': '跟随预设或当前助手',
  'preset.effort.adapterDefault': '服务默认',
  'preset.purpose.writing': '适合构思、正文创作和续写',
  'preset.purpose.import': '适合长篇导入、拆章和结构整理',
  'preset.purpose.polish': '适合章节审查、校对和精修',
  'preset.purpose.custom': '自定义模型方案',
  'preset.details': '模型详情',
  'preset.advanced': '高级设置',
  'preset.maxOutput': '最大输出',
  'preset.timeout': '最长等待',
  'preset.minutes': '分钟',
  'preset.effort.low': '低',
  'preset.effort.medium': '中',
  'preset.effort.high': '高',
  'preset.effort.max': '最高',
  'preset.select.ok': '已应用',
  'preset.select.fail': '应用失败, 请稍后再试',
  'preset.source.seed': '内置',
  'preset.source.stored': '自定义',
  'chapter.view': '章节正文',
  'chapter.select': '选择章节',
  'chapter.option': '第 {index} 章 {title}',
  'chapter.unbound': '当前会话尚未绑定小说工作区。',
  'chapter.empty': '没有可编辑的当前章节。',
  'chapter.createFirst': '新建第一章',
  'chapter.new': '新章草稿',
  'chapter.refresh': '刷新',
  'chapter.title': '章节标题',
  'chapter.body': '章节正文',
  'chapter.status': '状态',
  'chapter.edit': '编辑',
  'chapter.save': '审批保存',
  'chapter.saving': '暂存中…',
  'chapter.cancel': '结束编辑',
  'chapter.editingFinishedDraftKept': '已结束编辑；浏览器草稿仍保留，尚未保存到小说。',
  'chapter.saveFailed': '暂存失败, 请刷新后重试。',
  'chapter.chatDraftBusy': '对话里已有未发送草稿；请先发送或清空，避免覆盖。',
  'chapter.unsavedChangesBlocked': '浏览器里还有未审批保存的修改；请先审批保存。结束编辑只会保留草稿，不会解除此保护。',
  'chapter.conflictTitle': '发现未合并的浏览器草稿',
  'chapter.conflictKept': '小说正文已在别处变化。当前正文已加载，原浏览器草稿保留在下方，不会被删除。',
  'chapter.conflictCopy': '保留的草稿副本',
  'chapter.conflictRecover': '载入此副本继续编辑',
  'chapter.conflictRecovered': '草稿副本已载入编辑区；请核对当前版本后再审批保存。',
  'chapter.history': '版本历史',
  'chapter.current': '当前',
  'chapter.bytes': '字节',
  'chapter.invalidHash': '这个旧版本需要兼容处理，恢复时会自动完成。',
  'chapter.diff': '对比',
  'chapter.noDiff': '正文没有差异。',
  'chapter.truncated': '差异过长，当前视图已截断。',
  'chapter.restore': '审批恢复',
  'chapter.restoreRequested': '恢复请求已交给助手，确认审批后会生成一个新版本。',
  'chapter.review': '审查与返修',
  'chapter.reviewCurrent': '审查当前章',
  'chapter.reviewCandidate': '独立审查待确认稿',
  'chapter.reviewRequested': '审查已交给助手。完成后刷新本页查看发现的问题。',
  'chapter.noReview': '尚无审查。',
  'chapter.fresh': '当前有效',
  'chapter.stale': '已过期',
  'chapter.selectFinding': '请先选择要处理的问题。',
  'chapter.reviseSelected': '按所选问题返修',
  'chapter.reviseRequested': '定向返修已交给助手；结果会成为待独立审查候选。',
  'chapter.candidate': '待确认稿',
  'chapter.adoptCandidate': '确认采用',
  'chapter.adoptRequested': '采用请求已交给助手，仍需通过审批与新鲜度复核。',
  'chapter.rejectReason': '拒绝理由（必填，不会用于自动训练）',
  'chapter.rejectCandidate': '不采用这份稿件',
  'chapter.rejectRequested': '拒绝决定已交给助手；成功后会释放本章待处理槽。',
}

export const en: Record<NovelcraftKey, string> = {
  'actions.title': 'NovelCraft actions',
  'actions.open': 'NovelCraft',
  'common.loading': 'Loading…',
  'common.loadFailed': 'Unable to load this right now. Please try again.',
  'common.retry': 'Try again',
  'common.unknownItem': 'Unknown item',
  'common.untitled': 'Untitled',
  'common.statusUnknown': 'Status unavailable. Refresh or try again.',
  'common.none': 'None yet',
  'pet.connecting': 'Connecting',
  'pet.disconnected': 'Disconnected',
  'pet.stale': 'Status may be stale',
  'inbox.count': 'Needs attention',
  'inbox.chatBusy': 'Chat has an unsent draft. The item remains available; send or clear the draft first.',
  'inbox.sent': 'Sent to the assistant. The item remains until the work finishes.',
  'inbox.prompt.accept': 'Read the pending item “{title}” (item ID: {id}), complete its action and any required approval, then mark it resolved.',
  'inbox.prompt.modify': 'Read the pending item “{title}” (item ID: {id}) and complete its action with this change: {reason}. Keep the item if the action fails.',
  'inbox.reason.reject': 'Why do you not want to use this suggestion?',
  'inbox.reason.modify': 'How would you like to change it?',
  'inbox.keyboard': 'Shortcuts: j/k move · u refresh · Esc close',
  'inbox.category.ingest': 'Import',
  'inbox.category.dedup': 'Duplicate content',
  'inbox.category.suggest': 'World suggestion',
  'inbox.category.plot': 'Plot',
  'inbox.category.risk': 'World conflict',
  'inbox.category.writing': 'Writing',
  'inbox.category.other': 'Other',
  'workflow.otherActions': 'Other actions',
  'workflow.history': 'Completed',
  'workflow.prompt.resume': 'Please continue the “{kind}” task. Task number: {id}.',
  'workflow.prompt.clear': 'Please clear this “{kind}” task record without deleting imported or generated content. Task number: {id}.',
  'workflow.prompt.restart': 'Please import chapters {start}–{end} again without reusing the old task.',
  'book.createToggle': 'Create another book',
  'book.nameLabel': 'Book title',
  'book.createHint': 'The new book will open after creation. DSH will still ask you to confirm the actions.',
  'book.prompt.create': 'Please create a new book titled “{book}” and open it after creation.',
  'book.prompt.open': 'Please open “{title}” from the library. Exact library key: {book}.',
  'story.mode.view': 'View story structure',
  'story.mode.plan': 'Plan story structure',
  'story.chapterNumber': 'Chapter {index}',
  'outline.taskLabel': 'What you want',
  'outline.preview.story': 'Generate full-outline preview',
  'outline.preview.thread': 'Generate plot-thread preview',
  'outline.preview.arc': 'Generate story-arc preview',
  'outline.prompt.sources': 'Reference material: {sources}.',
  'outline.prompt.drafts': 'You may also use the drafts and unconfirmed material I explicitly selected.',
  'outline.prompt.preview': 'Please generate a {target} preview. My request: {input}. {sources}{drafts}',
  'outline.prompt.apply': 'Please use the structure plan “{title}”. Plan number: {id}.',
  'desk.chatBusy': 'The conversation input contains an unsent draft. Send or clear it first; it will not be overwritten.',
  'desk.mode.chapters': 'Chapters',
  'desk.mode.proposals': 'Next-chapter ideas',
  'desk.mode.reviews': 'Review history',
  'desk.chapters.empty': 'There are no chapters to view yet.',
  'desk.proposals.create': 'Generate next-chapter ideas',
  'desk.proposals.use': 'Continue in this direction',
  'desk.proposals.intent': 'What should this chapter accomplish? (optional)',
  'desk.proposals.pending': 'Review the pending draft first',
  'desk.proposals.readOnly': 'This older suggestion can be viewed but cannot be selected precisely.',
  'desk.reviews.findings': 'Issues found',
  'desk.prompt.import': 'Please import the manuscript “{file}” I just selected, organize it into chapters, and add it to this book.',
  'desk.prompt.propose': 'Starting from chapter {chapter}, suggest two or three directions for the next chapter. My writing intent: {intent}',
  'desk.prompt.continue': 'Please continue chapter {chapter} in the direction “{title}”. Task number: {run}; plan number: {proposal}.',
  'preset.purpose.writing': 'Best for ideation, drafting, and continuation',
  'preset.purpose.import': 'Best for long imports, chapter splitting, and structure',
  'preset.purpose.polish': 'Best for review, proofreading, and revision',
  'preset.purpose.custom': 'Custom model setup',
  'preset.details': 'Model details',
  'preset.advanced': 'Advanced settings',
  'preset.maxOutput': 'Maximum output',
  'preset.timeout': 'Maximum wait',
  'preset.minutes': 'minutes',
  'preset.effort.low': 'Low',
  'preset.effort.medium': 'Medium',
  'preset.effort.high': 'High',
  'preset.effort.max': 'Maximum',
  'world.tab.create': 'Create together',
  'world.tab.content': 'Worldbook content',
  'world.taskLabel': 'What would you like to work on?',
  'world.references': 'Use existing material (optional)',
  'world.references.empty': 'No existing settings or pages are available yet.',
  'world.pageIntent': 'Page option',
  'world.existingPage': 'Continue an existing page',
  'world.existingPageHint': 'Select a worldbook page under existing material first.',
  'world.improve': 'Keep developing this',
  'world.page.draft': 'Ready to publish',
  'world.page.published': 'Published',
  'world.run.chat': 'Start discussion',
  'world.run.converge': 'Organize these ideas',
  'world.run.explore': 'Suggest new directions',
  'world.run.inspect': 'Check existing settings',
  'world.run.bible': 'Create worldbook draft',
  'world.prompt.references': 'Reference material: {references}.',
  'world.prompt.referenceItem': '“{title}” (source reference {reference})',
  'world.prompt.drafts': 'You may also use the drafts I explicitly selected.',
  'world.prompt.newPage': 'Please create a new worldbook page draft.',
  'world.prompt.existingPage': 'Please continue developing the worldbook page I selected.',
  'world.prompt.mode': 'Please {mode}.',
  'world.prompt.request': '{intent} What I want to work on: {input}. {references}{drafts}',
  'world.prompt.publish': 'Please publish the worldbook draft “{title}” with the exact source reference {reference}.',
  'atlas.status.pending': 'Needs review',
  'atlas.status.adopted': 'Adopted',
  'atlas.status.rejected': 'Rejected',
  'atlas.status.archived': 'Archived',
  'atlas.placeholder': 'Needs an image',
  'atlas.conflicts': 'World conflicts to confirm before adoption',
  'atlas.imageMissing': 'The original image cannot be read. You can upload it again.',
  'atlas.largeImage': 'This image is large, so only its dimensions and size are shown:',
  'atlas.noImage': 'This page does not have an image yet. Upload one to add labels.',
  'atlas.visualBrief': 'Visual brief',
  'atlas.imageGuide': 'Image-generation guide',
  'atlas.copyGuide': 'Copy guide',
  'atlas.supported': 'Supported by the manuscript and adopted settings',
  'atlas.visualFill': 'Visual additions for you to confirm',
  'atlas.annotations': 'Map labels',
  'atlas.annotation.default': 'Label',
  'atlas.annotation.add': 'Add label',
  'atlas.annotation.name': 'Label name',
  'atlas.annotation.delete': 'Delete',
  'atlas.annotation.hint': 'Drag labels on the image, or rename and delete them below.',
  'atlas.annotation.saving': 'Submitting…',
  'atlas.annotation.save': 'Ask assistant to save',
  'atlas.annotation.saved': 'Saved',
  'atlas.annotation.queued': 'Submitted, waiting for the assistant to apply',
  'atlas.annotation.discardConfirm': 'This map page has unsent label changes. Discard them?',
  'atlas.annotation.failed': 'Unable to submit. Your edits remain on this page so you can retry.',
  'atlas.annotation.nameRequired': 'Label names cannot be empty.',
  'atlas.chatBusyQueued': 'The label edits are saved for later. Handle the conversation draft, then ask the assistant to save the map labels.',
  'atlas.chatBusy': 'The conversation input contains an unsent draft. Send or clear it first; it will not be overwritten.',
  'atlas.imageTooLarge': 'The image is over 50 MB. Compress it and try again.',
  'atlas.uploadFailed': 'Unable to upload this image. Check its format and dimensions, then retry.',
  'atlas.selectedPage': 'selected map page',
  'atlas.unbound': 'Open a book from the library first.',
  'atlas.tab.mine': 'My atlas',
  'atlas.tab.pending': 'Needs work',
  'atlas.runSummary': 'Latest plan',
  'atlas.pagesUnit': 'pages',
  'atlas.runNeedsAttention': 'This plan needs your attention or a retry.',
  'atlas.queuePending': 'label edits waiting for the assistant',
  'atlas.empty': 'There is no atlas yet. Ask the assistant to plan map pages from the existing material.',
  'atlas.plan': 'Ask assistant to plan an atlas',
  'atlas.mine.empty': 'There are no adopted map pages yet.',
  'atlas.pending.empty': 'There are no map pages waiting for work.',
  'atlas.selectNode': 'Select a map page on the left to view its details.',
  'atlas.choosePage': 'This location has multiple map pages. Select a specific page first.',
  'atlas.placeholderHint': 'This page still needs an image. You can upload one now.',
  'atlas.uploading': 'Checking image…',
  'atlas.upload': 'Upload image for this page',
  'atlas.prompt.import': 'Please import the map image “{file}” I just selected and place it under “{page}”.',
  'atlas.prompt.applyLabels': 'Please save the map-label edits I just submitted.',
  'atlas.prompt.plan': 'Please plan an atlas for this book, beginning with map-page proposals for me to review.',
  'pet.silent': 'Silent',
  'pet.glow': 'Glow',
  'pet.busy': 'Busy',
  'pet.attention': 'Needs you',
  'pet.title': 'NovelCraft Watch',
  'atlas.title': 'Map atlas',
  'pet.plot': 'Current plot',
  'inbox.title': 'Needs attention',
  'inbox.empty': 'There is nothing waiting for your decision.',
  'inbox.unbound': 'Open a book from the library first.',
  'inbox.threshold': 'Attention threshold',
  'inbox.refresh': 'Refresh',
  'inbox.close': 'Close',
  'inbox.verb.accept': 'Use suggestion',
  'inbox.verb.reject': 'Do not use',
  'inbox.verb.modify': 'Change suggestion',
  'inbox.verb.defer': 'Handle later',
  'inbox.reason.placeholder': 'One-line reason (feeds calibration, required)',
  'inbox.reason.confirm': 'Confirm',
  'inbox.status.open': 'Open',
  'inbox.status.accepted': 'Accepted',
  'inbox.status.rejected': 'Rejected',
  'inbox.status.deferred': 'Deferred',
  'inbox.status.resolved': 'Resolved',
  'inbox.evidence': 'Evidence',
  'inbox.action': 'Proposed action',
  'inbox.act.fail': 'Action failed',
  'inbox.done.adopt': 'Accept recorded',
  'inbox.done.record': 'Recorded',
  'story.title': 'Story Map',
  'workflow.title': 'Task progress',
  'workflow.unbound': 'Open a book from the library first.',
  'workflow.empty': 'There are no running or resumable tasks.',
  'workflow.loading': 'Refreshing…',
  'workflow.chatBusy': 'Chat has an unsent draft. Send or clear it first.',
  'workflow.requested': 'The request was sent to the assistant; effectful actions still require approval.',
  'workflow.kind.import': 'Deep import',
  'workflow.kind.atlas': 'Map atlas',
  'workflow.state.running': 'Running',
  'workflow.state.needs-attention': 'Needs attention',
  'workflow.state.completed': 'Completed',
  'workflow.state.failed': 'Failed',
  'workflow.progress': 'Progress',
  'workflow.phase': 'Current phase',
  'workflow.scope': 'Chapter range',
  'workflow.resume': 'Continue task',
  'workflow.abandon': 'Clear task record',
  'workflow.restart': 'Import again',
  'workflow.restartHint': 'If the old task cannot continue, import these chapters again:',
  'book.title': 'Library',
  'book.current': 'Current',
  'book.unbound': 'No book is open yet.',
  'book.empty': 'Your library is empty. Create your first book.',
  'book.open': 'Open this book',
  'book.create': 'Create and open',
  'book.name': 'Enter a book title',
  'book.chatBusy': 'Chat has an unsent draft. Send or clear it first.',
  'book.requested': 'The request was sent to the assistant; create or switch still requires approval.',
  'story.empty': 'There is no story structure yet. Tell the assistant what you want to write.',
  'story.unbound': 'Open a book from the library first.',
  'story.threads': 'Plot lines',
  'story.arcs': 'Story sections',
  'story.foreshadowing': 'Foreshadowing',
  'story.reveals': 'Reveals',
  'story.scenes': 'Scenes',
  'story.edges': 'Story relationships',
  'story.edge.other': 'Other',
  'story.edge.serves_thread': 'Supports plot line',
  'story.edge.belongs_to_arc': 'Belongs to story section',
  'story.edge.reveals_foreshadowing': 'Reveals foreshadowing',
  'story.edge.pays_off_in_scene': 'Pays off in scene',
  'story.edge.references_character': 'References character',
  'story.edge.references_entity': 'References entity',
  'story.edge.references_memory': 'References memory',
  'story.chapters': 'Chapters',
  'outline.workbench': 'Story structure planning',
  'outline.target': 'What would you like to plan?',
  'outline.target.story': 'Story outline',
  'outline.target.thread': 'Plot line',
  'outline.target.arc': 'Story section',
  'outline.task': 'For example: strengthen the middle conflict while keeping the current ending…',
  'outline.sources': 'Choose reference material (optional)',
  'outline.sources.empty': 'No reference material is available yet.',
  'outline.includeDrafts': 'Also use selected drafts and material awaiting confirmation',
  'outline.preview': 'Generate preview',
  'outline.previews': 'Recent previews',
  'outline.previews.empty': 'No outline or structure previews yet.',
  'outline.receipt': 'Reference items',
  'outline.warnings': 'Needs confirmation',
  'outline.apply': 'Use this plan',
  'outline.chatBusy': 'Chat has an unsent draft. Send or clear it first.',
  'outline.requested': 'The request was sent to the assistant. A preview is not adopted content, and using it still requires approval.',
  'world.title': 'World Bible',
  'world.unbound': 'Open a book from the library first.',
  'world.mode': 'What would you like to do?',
  'world.mode.chat': 'Discuss a setting together',
  'world.mode.converge': 'Organize scattered ideas',
  'world.mode.explore': 'Explore a few new directions',
  'world.mode.inspect': 'Check existing settings for problems',
  'world.mode.bible': 'Create a worldbook page draft',
  'world.task': 'For example: how can this floating city sustain itself over time?',
  'world.objects': 'Adopted settings',
  'world.objects.empty': 'There are no adopted settings yet.',
  'world.pages': 'Bible pages',
  'world.pages.empty': 'No Bible pages yet.',
  'world.page.noSummary': 'This page has no summary yet.',
  'world.publish': 'Publish to worldbook',
  'world.includeDrafts': 'Also use selected drafts',
  'world.newPage': 'Create a new page',
  'world.run': 'Send to assistant',
  'world.chatBusy': 'Chat has an unsent draft. Send or clear it first.',
  'world.requested': 'The request was sent to the assistant; discussion and inspection are read-only, and draft publication still requires approval.',
  'desk.title': 'Writing Desk',
  'desk.empty': 'Nothing here yet.',
  'desk.unbound': 'Open a book from the library first.',
  'desk.mode.watch': 'Watch',
  'desk.mode.plan': 'Plan',
  'desk.mode.review': 'Review',
  'desk.mode.reference': 'Reference',
  'desk.mode.import': 'Import',
  'intake.choose': 'Choose a .txt / .md manuscript',
  'intake.hint': 'Choose a manuscript, review the chapter split, then send it to the assistant for import. Supports .txt and .md up to 50 MB.',
  'intake.staging': 'Validating and staging…',
  'intake.fail': 'File authorization failed. Check the format and try again.',
  'intake.tooLarge': 'The file exceeds 50MB. Split it and try again.',
  'intake.previewTitle': 'Chapter preview',
  'intake.previewSummary': '{count} chapters detected · {preamble} characters before the first heading',
  'intake.noHeadings': 'No chapter heading was detected; this will import as one chapter.',
  'intake.unrecognizedLong': 'This long manuscript has no recognized chapter headings, so import is blocked. Add “Chapter N” or Markdown headings and choose it again.',
  'intake.confirm': 'Confirm chapters and continue',
  'desk.chapters': 'Chapters',
  'desk.objects': 'World objects',
  'desk.reviews': 'Review records',
  'desk.reviews.empty': 'There are no chapter review records yet.',
  'desk.proposals': 'Continuation ideas',
  'desk.proposals.empty': 'There are no next-chapter ideas yet.',
  'desk.proposals.basis': 'Basis',
  'desk.proposals.cost': 'Cost',
  'desk.proposals.risk': 'Risk',
  'desk.proposals.sources': '{used} references · {omitted} omitted · {warnings} warnings',
  'dossier.title': 'Chapter Notes',
  'dossier.back': 'Back to list',
  'dossier.unbound': 'Open this book from the library first.',
  'dossier.missing': 'This chapter has not been imported yet, so there are no notes.',
  'dossier.status': 'Status',
  'dossier.words': 'chars',
  'dossier.scenes': 'Scenes',
  'dossier.scene.goal': 'Goal',
  'dossier.scene.conflict': 'Core conflict',
  'dossier.scene.must': 'Must happen',
  'dossier.scene.mustNot': 'Must not happen',
  'dossier.scene.tag': 'Purpose in the story',
  'dossier.characters': 'Characters present',
  'dossier.pov': 'Point-of-view character',
  'dossier.foreshadowing': 'Foreshadowing',
  'dossier.foreshadowing.planted': 'Planted',
  'dossier.foreshadowing.active': 'Active through',
  'dossier.foreshadowing.due': 'Due payoff',
  'dossier.reveals': 'Reveals',
  'dossier.objects': 'Referenced objects',
  'dossier.rhythm': 'Rhythm',
  'dossier.rhythm.words': 'Word count',
  'dossier.rhythm.scenes': 'Scenes',
  'dossier.rhythm.avg': 'Avg length',
  'dossier.review': 'Review',
  'dossier.signals': 'Items to review',
  'dossier.proposal': 'Continuation idea',
  'dossier.empty': 'None',
  'preset.title': 'Model Presets',
  'preset.unbound': 'Open a book from the library first.',
  'preset.current': 'Current',
  'preset.use': 'Use this preset',
  'preset.default.name': 'Follow the current assistant',
  'preset.default.desc': 'Do not set a separate model for this book.',
  'preset.available': 'Connected model services',
  'preset.effort': 'Thinking intensity',
  'preset.effort.default': 'Follow the preset or current assistant',
  'preset.effort.adapterDefault': 'Service default',
  'preset.select.ok': 'Applied',
  'preset.select.fail': 'Apply failed, please try again later',
  'preset.source.seed': 'Built-in',
  'preset.source.stored': 'Custom',
  'chapter.view': 'Chapter Text',
  'chapter.select': 'Select chapter',
  'chapter.option': 'Chapter {index} {title}',
  'chapter.unbound': 'This session is not bound to a novel vault.',
  'chapter.empty': 'No editable current chapter.',
  'chapter.createFirst': 'Create chapter one',
  'chapter.new': 'New chapter draft',
  'chapter.refresh': 'Refresh',
  'chapter.title': 'Chapter title',
  'chapter.body': 'Chapter body',
  'chapter.status': 'Status',
  'chapter.edit': 'Edit',
  'chapter.save': 'Save with approval',
  'chapter.saving': 'Staging…',
  'chapter.cancel': 'Finish editing',
  'chapter.editingFinishedDraftKept': 'Editing ended. The browser draft is still kept and has not been saved to the novel.',
  'chapter.saveFailed': 'Staging failed. Refresh and try again.',
  'chapter.chatDraftBusy': 'Chat already has an unsent draft. Send or clear it first to avoid overwriting it.',
  'chapter.unsavedChangesBlocked': 'The browser has changes that are not saved with approval. Save them first; finishing editing keeps the draft and does not remove this protection.',
  'chapter.conflictTitle': 'Unmerged browser draft found',
  'chapter.conflictKept': 'The novel changed elsewhere. The current text is loaded and the earlier browser draft remains below.',
  'chapter.conflictCopy': 'Saved draft copy',
  'chapter.conflictRecover': 'Load this copy for editing',
  'chapter.conflictRecovered': 'The draft copy is loaded. Compare it with the current version before saving with approval.',
  'chapter.history': 'Version history',
  'chapter.current': 'Current',
  'chapter.bytes': 'bytes',
  'chapter.invalidHash': 'This older version needs a compatibility update; restoring it will handle that automatically.',
  'chapter.diff': 'Diff',
  'chapter.noDiff': 'No body changes.',
  'chapter.truncated': 'The diff is too long and was truncated in this view.',
  'chapter.restore': 'Restore with approval',
  'chapter.restoreRequested': 'The restore request was sent to the assistant; approval creates a new version.',
  'chapter.review': 'Review and revise',
  'chapter.reviewCurrent': 'Review current',
  'chapter.reviewCandidate': 'Review pending draft',
  'chapter.reviewRequested': 'The review request was sent to the assistant. Refresh this view when it finishes.',
  'chapter.noReview': 'No review yet.',
  'chapter.fresh': 'Fresh',
  'chapter.stale': 'Stale',
  'chapter.selectFinding': 'Select at least one finding first.',
  'chapter.reviseSelected': 'Revise selected findings',
  'chapter.reviseRequested': 'Targeted revision was sent to the assistant; the result must be reviewed independently.',
  'chapter.candidate': 'Pending draft',
  'chapter.adoptCandidate': 'Use this draft',
  'chapter.adoptRequested': 'The adoption request was sent to the assistant and still requires approval and freshness checks.',
  'chapter.rejectReason': 'Rejection reason (required; not used for automatic training)',
  'chapter.rejectCandidate': 'Do not use this draft',
  'chapter.rejectRequested': 'The rejection was sent to the assistant; success releases this chapter’s pending slot.',
}
