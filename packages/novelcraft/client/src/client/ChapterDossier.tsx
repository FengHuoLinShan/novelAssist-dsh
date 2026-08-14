// 章节档案(ChapterDossier): §17.5.1 每章一整页的读面钻取视图。
// 数据源 = /novelcraft chapter/dossier(宿主读 store.chapterDossier + .assistant 读面
// 合并: 本章最新审查 / 本章 open 信号 / next_chapter==N 最新提案)。纯读, 无动作;
// 半宽纵向排布(D10), 全部作者语言, 不暴露 raw JSON/内部枚举。
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCaller } from './index.ts'
import type { ChapterDossierAsset, DossierSceneCard, SignalCard } from '../wire.ts'
import { NS } from './locales.ts'
import { useChapterDossier } from './useWatch.ts'
import css from './novelcraft.module.css'

export interface ChapterDossierProps {
  connection: RpcCaller | undefined
  sessionId: string | undefined
  t: TranslateNS<typeof NS>
  chapterIndex: number
  /** 返回章节列表(StoryMap 列表 / 写作台 tab)。 */
  onBack: () => void
}

type T = ChapterDossierProps['t']

/** 区块空占位(作者语言)。 */
function EmptyLine({ t }: { t: T }): JSX.Element {
  return <div className={css.dossierEmpty}>{t('dossier.empty')}</div>
}

/** 简单行区块(小标题 + 若干行; 空则不渲染)。 */
function Block(props: { title: string; lines: string[] }): JSX.Element {
  if (props.lines.length === 0) return <></>
  return (
    <section className={css.dossierBlock}>
      <div className={css.sectionTitle}>{props.title}</div>
      {props.lines.map((line, i) => <div key={i} className={css.itemLine}>{line}</div>)}
    </section>
  )
}

/** Scene 分解卡(outline.md 字段表: goal/core_conflict/must_happen/must_not_happen/narrative_tag)。 */
function SceneCard(props: { scene: DossierSceneCard; t: T }): JSX.Element {
  const { scene, t } = props
  const rows: Array<[string, string]> = []
  if (scene.goal) rows.push([t('dossier.scene.goal'), scene.goal])
  if (scene.core_conflict) rows.push([t('dossier.scene.conflict'), scene.core_conflict])
  if (scene.must_happen) rows.push([t('dossier.scene.must'), scene.must_happen])
  if (scene.must_not_happen) rows.push([t('dossier.scene.mustNot'), scene.must_not_happen])
  if (scene.narrative_tag) rows.push([t('dossier.scene.tag'), scene.narrative_tag])
  return (
    <article className={css.card}>
      <header className={css.cardHeader}>
        <span className={css.cardTitle}>{scene.title || scene.slug}</span>
        <span className={css.cardMeta}>{scene.status}</span>
      </header>
      {rows.map(([label, value]) => (
        <p key={label} className={css.proposed}>
          <span className={css.dossierFieldLabel}>{label}</span>: {value}
        </p>
      ))}
    </article>
  )
}

/** 伏笔对账单列(种下/经过/应回收)。 */
function ForeshadowColumn(props: { title: string; items: Array<{ slug: string; name: string }>; t: T }): JSX.Element {
  return (
    <div className={css.dossierColumn}>
      <div className={css.dossierColumnTitle}>{props.title}</div>
      {props.items.length === 0
        ? <div className={css.dossierEmpty}>{props.t('dossier.empty')}</div>
        : props.items.map((f) => <div key={f.slug} className={css.itemLine}>{f.name}</div>)}
    </div>
  )
}

/** 相关信号小卡(只读呈现, 无四动词——档案视图是读面)。 */
function SignalMiniCard(props: { signal: SignalCard; t: T }): JSX.Element {
  const { signal, t } = props
  return (
    <article className={css.card}>
      <header className={css.cardHeader}>
        <span className={css.cardTitle}>{signal.title}</span>
        <span className={css.cardMeta}>{signal.severity}</span>
      </header>
      <p className={css.proposed}>{t('inbox.action')}: {signal.proposed_action}</p>
    </article>
  )
}

export function ChapterDossier(props: ChapterDossierProps): JSX.Element {
  const { t, connection, sessionId, chapterIndex, onBack } = props
  const { data } = useChapterDossier(connection, sessionId, chapterIndex)

  const bound = data?.bound != null
  const dossier: ChapterDossierAsset | null = data?.dossier ?? null

  return (
    <div className={css.dossier}>
      <div className={css.dossierHeader}>
        <button type="button" className={css.dossierBack} onClick={onBack} aria-label={t('dossier.back')}>
          ← {t('dossier.back')}
        </button>
        <span className={css.dossierHeaderTitle}>{t('dossier.title')}</span>
      </div>

      {!bound || dossier == null ? (
        <div className={css.empty}>{t('dossier.unbound')}</div>
      ) : (
        <>
          {dossier.chapter == null ? (
            <div className={css.empty}>{t('dossier.missing')}</div>
          ) : (
            <div className={css.dossierMeta}>
              ch{dossier.chapter.index}
              {dossier.chapter.title ? ` · ${dossier.chapter.title}` : ''}
              {dossier.chapter.status ? ` · ${t('dossier.status')}: ${dossier.chapter.status}` : ''}
              {' · '}{dossier.chapter.wordCount} {t('dossier.words')}
            </div>
          )}

          <section className={css.dossierBlock}>
            <div className={css.sectionTitle}>{t('dossier.scenes')}</div>
            {dossier.scenes.length === 0
              ? <EmptyLine t={t} />
              : dossier.scenes.map((s) => <SceneCard key={s.slug} scene={s} t={t} />)}
          </section>

          <Block title={t('dossier.characters')} lines={dossier.characters.map((c) => c.name)} />
          <Block title={t('dossier.pov')} lines={dossier.pov.map((p) => `${p.character} · ${p.scene}`)} />

          <section className={css.dossierBlock}>
            <div className={css.sectionTitle}>{t('dossier.foreshadowing')}</div>
            <div className={css.dossierColumns}>
              <ForeshadowColumn title={t('dossier.foreshadowing.planted')} items={dossier.foreshadowing.planted} t={t} />
              <ForeshadowColumn title={t('dossier.foreshadowing.active')} items={dossier.foreshadowing.activeThrough} t={t} />
              <ForeshadowColumn title={t('dossier.foreshadowing.due')} items={dossier.foreshadowing.duePayoff} t={t} />
            </div>
          </section>

          <Block title={t('dossier.reveals')} lines={dossier.reveals.map((r) => r.name)} />
          <Block title={t('dossier.objects')} lines={dossier.referencedObjects.map((o) => `${o.name}${o.kind ? ' · ' + o.kind : ''}`)} />
          <Block title={t('dossier.rhythm')} lines={[
            `${t('dossier.rhythm.words')}: ${dossier.rhythm.wordCount}`,
            `${t('dossier.rhythm.scenes')}: ${dossier.rhythm.sceneCount}`,
            `${t('dossier.rhythm.avg')}: ${dossier.rhythm.avgSceneLength}`,
          ]} />

          <section className={css.dossierBlock}>
            <div className={css.sectionTitle}>{t('dossier.review')}</div>
            {data.review == null ? (
              <EmptyLine t={t} />
            ) : (
              <article className={css.card}>
                <header className={css.cardHeader}>
                  <span className={css.cardTitle}>{data.review.verdict}</span>
                  <span className={css.cardMeta}>{data.review.finding_count} · {data.review.reviewed_at}</span>
                </header>
              </article>
            )}
          </section>

          <section className={css.dossierBlock}>
            <div className={css.sectionTitle}>{t('dossier.signals')}</div>
            {data.signals.length === 0
              ? <EmptyLine t={t} />
              : data.signals.map((s) => <SignalMiniCard key={s.id} signal={s} t={t} />)}
          </section>

          <section className={css.dossierBlock}>
            <div className={css.sectionTitle}>{t('dossier.proposal')}</div>
            {data.proposal == null ? (
              <EmptyLine t={t} />
            ) : (
              <div>
                <div className={css.itemLine}>ch{data.proposal.next_chapter}</div>
                {data.proposal.proposals.map((prop) => (
                  <article key={prop.title} className={css.card}>
                    <header className={css.cardHeader}>
                      <span className={css.cardTitle}>{prop.title}</span>
                    </header>
                    <p className={css.proposed}>{prop.premise}</p>
                    {prop.basis != null && prop.basis.length > 0
                      ? <p className={css.proposed}>{t('desk.proposals.basis')}: {prop.basis.join(' / ')}</p>
                      : null}
                    {prop.cost ? <p className={css.proposed}>{t('desk.proposals.cost')}: {prop.cost}</p> : null}
                    {prop.risk ? <p className={css.proposed}>{t('desk.proposals.risk')}: {prop.risk}</p> : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
