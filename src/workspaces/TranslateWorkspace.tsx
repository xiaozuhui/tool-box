import { useEffect, useState, type KeyboardEvent } from 'react'
import './TranslateWorkspace.css'
import {
    addFavorite,
    loadDictionaryDashboard,
    queryTranslation,
    removeFavorite,
    updateDictionarySettings,
} from '../lib/desktop'
import type {
    DictionaryDashboard,
    DictionaryEntrySummary,
    DictionarySettings,
    FavoriteEntry,
    QueryDirection,
    ResolvedDirection,
    TranslationResult,
} from '../types'

const directionOptions: Array<{ value: QueryDirection; label: string; description: string }> = [
    { value: 'auto', label: '自动', description: '自动识别输入语言' },
    { value: 'zhToEn', label: '中译英', description: '中文词语或短语' },
    { value: 'enToZh', label: '英译中', description: '英文单词或短语' },
]

function formatTime(value: string) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date)
}

function flattenResults(result: TranslationResult | null) {
    if (!result) return []
    return [...result.phraseHits, ...result.exactHits, ...result.fuzzyHits]
}

function firstPrimaryTranslation(entry: DictionaryEntrySummary | null) {
    return entry?.primaryTranslation ?? ''
}

function directionBadge(direction: ResolvedDirection) {
    return direction === 'zhToEn' ? '中译英' : '英译中'
}

function sectionTitle(kind: 'phrase' | 'exact' | 'fuzzy') {
    if (kind === 'phrase') return '短语优先'
    if (kind === 'exact') return '精确命中'
    return '模糊补充'
}

function formatGeneratedAt(value: string | null | undefined) {
    if (!value) return '未记录'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date)
}

interface ResultSectionProps {
    title: string
    items: DictionaryEntrySummary[]
    selectedId: number | null
    onSelect: (entry: DictionaryEntrySummary) => void
    compact: boolean
}

function ResultSection({ title, items, selectedId, onSelect, compact }: ResultSectionProps) {
    if (!items.length) return null

    return (
        <section className="translate-result-section">
            <div className="section-heading">
                <h3>{title}</h3>
                <span className="panel-chip">{items.length}</span>
            </div>
            <div className={compact ? 'translate-result-list compact' : 'translate-result-list'}>
                {items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        className={item.id === selectedId ? 'translate-result-card active' : 'translate-result-card'}
                        onClick={() => onSelect(item)}
                    >
                        <div className="translate-result-header">
                            <strong>{item.term}</strong>
                            <span className="meta-chip">{item.isPhrase ? 'PHRASE' : 'WORD'}</span>
                        </div>
                        <p>{item.primaryTranslation}</p>
                        <div className="translate-result-meta">
                            <span>{item.matchReason}</span>
                            <span>{item.tags.join(' / ') || 'general'}</span>
                        </div>
                    </button>
                ))}
            </div>
        </section>
    )
}

export default function TranslateWorkspace() {
    const [dashboard, setDashboard] = useState<DictionaryDashboard | null>(null)
    const [query, setQuery] = useState('')
    const [direction, setDirection] = useState<QueryDirection>('auto')
    const [result, setResult] = useState<TranslationResult | null>(null)
    const [selectedEntry, setSelectedEntry] = useState<DictionaryEntrySummary | null>(null)
    const [busy, setBusy] = useState(false)
    const [status, setStatus] = useState('离线词典已就绪，可直接输入中英文单词或短语。')
    const [error, setError] = useState<string | null>(null)
    const [settingsBusy, setSettingsBusy] = useState(false)
    const [supportView, setSupportView] = useState<'history' | 'favorites'>('history')
    const [settingsExpanded, setSettingsExpanded] = useState(false)

    async function refreshDashboard() {
        const next = await loadDictionaryDashboard()
        setDashboard(next)
        setDirection((current) => (current === 'auto' ? next.settings.defaultDirection : current))
    }

    useEffect(() => {
        void refreshDashboard().catch((reason: unknown) => {
            const message = reason instanceof Error ? reason.message : String(reason)
            setError(message)
            setStatus(message)
        })
    }, [])

    async function runLookup(nextQuery?: string, nextDirection?: QueryDirection | ResolvedDirection) {
        const finalQuery = (nextQuery ?? query).trim()
        if (!finalQuery) {
            setError('请输入要查询的单词或短语。')
            setStatus('请输入要查询的单词或短语。')
            return
        }

        const requestDirection = (nextDirection ?? direction) as QueryDirection
        setBusy(true)
        setError(null)
        setStatus('正在查询离线词典...')

        try {
            const translation = await queryTranslation({
                query: finalQuery,
                direction: requestDirection,
                limit: dashboard?.settings.compactResultView ? 6 : 8,
            })
            const candidates = flattenResults(translation)
            setResult(translation)
            setSelectedEntry(candidates[0] ?? null)
            setStatus(candidates.length ? `已返回 ${candidates.length} 条候选` : '没有找到精确命中，已给出可用候选')
            setQuery(finalQuery)

            if (dashboard?.settings.autoCopyPrimary && candidates[0]?.primaryTranslation) {
                await navigator.clipboard.writeText(candidates[0].primaryTranslation)
                setStatus('已返回结果，并自动复制首条释义')
            }

            await refreshDashboard()
        } catch (reason: unknown) {
            const message = reason instanceof Error ? reason.message : String(reason)
            setError(message)
            setStatus(message)
        } finally {
            setBusy(false)
        }
    }

    async function handleFavorite(entry: DictionaryEntrySummary | null) {
        if (!entry) return
        try {
            await addFavorite({
                query: query.trim() || entry.term,
                direction: result?.direction ?? 'enToZh',
                translation: entry.primaryTranslation,
            })
            await refreshDashboard()
            setStatus('已加入收藏')
        } catch (reason: unknown) {
            const message = reason instanceof Error ? reason.message : String(reason)
            setError(message)
            setStatus(message)
        }
    }

    async function handleRemoveFavorite(item: FavoriteEntry) {
        try {
            await removeFavorite(item.id)
            await refreshDashboard()
            setStatus(`已移除收藏：${item.query}`)
        } catch (reason: unknown) {
            const message = reason instanceof Error ? reason.message : String(reason)
            setError(message)
            setStatus(message)
        }
    }

    async function patchSettings(partial: Partial<DictionarySettings>) {
        if (!dashboard) return
        setSettingsBusy(true)
        try {
            const nextSettings = await updateDictionarySettings({
                ...dashboard.settings,
                ...partial,
            })
            setDashboard((current) => (current ? { ...current, settings: nextSettings } : current))
            setStatus('本地词典设置已更新')
        } catch (reason: unknown) {
            const message = reason instanceof Error ? reason.message : String(reason)
            setError(message)
            setStatus(message)
        } finally {
            setSettingsBusy(false)
        }
    }

    async function copySelection() {
        const text = firstPrimaryTranslation(selectedEntry)
        if (!text) return
        await navigator.clipboard.writeText(text)
        setStatus('当前释义已复制到剪贴板')
    }

    function clearQuery() {
        setQuery('')
        setResult(null)
        setSelectedEntry(null)
        setError(null)
        setStatus('已清空当前查询')
    }

    function swapDirection() {
        setDirection((current) => {
            if (current === 'auto') return 'zhToEn'
            return current === 'zhToEn' ? 'enToZh' : 'zhToEn'
        })
    }

    function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key !== 'Enter') return
        event.preventDefault()
        void runLookup()
    }

    const resultItems = flattenResults(result)
    const metadata = dashboard?.metadata
    const favorites = dashboard?.favorites ?? []
    const history = dashboard?.history ?? []
    const settings = dashboard?.settings
    const defaultDirectionLabel = directionOptions.find((option) => option.value === (settings?.defaultDirection ?? 'auto'))?.label ?? '自动'
    const resultStateLabel = busy ? '查询中' : error ? '异常' : '就绪'
    const detailDirection = result?.direction ?? 'enToZh'
    const supportCount = supportView === 'history' ? history.length : favorites.length
    const selectedExampleCount = selectedEntry?.variants.reduce((count, variant) => count + variant.examples.length, 0) ?? 0
    const selectedEntryFavorited = selectedEntry
        ? favorites.some((item) => item.direction === detailDirection && item.translation === selectedEntry.primaryTranslation)
        : false

    return (
        <main className="workspace">
            <header className="workspace-header translate-header">
                <div className="workspace-heading">
                    <span className="workspace-kicker">Offline lexicon</span>
                    <h2>离线翻译</h2>
                    <p>{metadata ? `${metadata.sourceLabel} · ${metadata.entryCount} 词条 · ${metadata.phraseCount} 短语` : '正在载入词典元信息...'}</p>
                </div>
                <div className="workspace-toolbar">
                    <div className="workspace-brief">
                        <div className="workspace-brief-item">
                            <span>默认方向</span>
                            <strong>{defaultDirectionLabel}</strong>
                            <small>{settings?.compactResultView ? '紧凑结果视图' : '标准结果视图'}</small>
                        </div>
                        <div className="workspace-brief-item is-status">
                            <span>检索状态</span>
                            <strong>{resultStateLabel}</strong>
                            <small>{error ?? status}</small>
                        </div>
                    </div>
                    <div className="toolbar-actions">
                        <button type="button" className="secondary-button" onClick={() => void refreshDashboard()} disabled={busy || settingsBusy}>
                            刷新词典
                        </button>
                    </div>
                </div>
            </header>

            <div className="translate-layout">
                <section className="translate-column-main">
                    <section className="translate-query-grid">
                        <article className="preview-card translate-input-card">
                            <div className="card-header">
                                <h3>查询输入</h3>
                                <span className="meta-chip">词语 / 短语</span>
                            </div>
                            <p className="translate-card-intro">支持中英单词、短语与常见技术表达，回车可直接发起本地检索。</p>
                            <div className="translate-direction-row">
                                {directionOptions.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        className={option.value === direction ? 'mode-button active' : 'mode-button'}
                                        onClick={() => setDirection(option.value)}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                            <label className="field">
                                <span>输入内容</span>
                                <input
                                    value={query}
                                    onChange={(event) => setQuery(event.target.value)}
                                    onKeyDown={onInputKeyDown}
                                    placeholder="例如：toolbox / 图像处理 / artificial intelligence"
                                />
                            </label>
                            <div className="translate-action-row">
                                <button type="button" className="primary-button" onClick={() => void runLookup()} disabled={busy}>
                                    {busy ? '查询中' : '开始查询'}
                                </button>
                                <button type="button" className="secondary-button" onClick={swapDirection} disabled={busy}>
                                    切换方向
                                </button>
                                <button type="button" className="secondary-button" onClick={() => void copySelection()} disabled={!selectedEntry}>
                                    复制首条释义
                                </button>
                                <button type="button" className="secondary-button" onClick={() => void handleFavorite(selectedEntry)} disabled={!selectedEntry || selectedEntryFavorited}>
                                    {selectedEntryFavorited ? '已收藏' : '收藏当前结果'}
                                </button>
                                <button type="button" className="ghost-button" onClick={clearQuery} disabled={busy && !query}>
                                    清空
                                </button>
                            </div>
                            {result?.notes.length ? (
                                <ul className="translate-note-list">
                                    {result.notes.map((item) => (
                                        <li key={item}>{item}</li>
                                    ))}
                                </ul>
                            ) : null}
                            {result?.suggestions.length ? (
                                <div className="translate-suggestion-strip">
                                    <span className="translate-strip-label">相关表达</span>
                                    <div className="translate-chip-row">
                                        {result.suggestions.map((item) => (
                                            <button key={item} type="button" className="suggestion-chip" onClick={() => void runLookup(item)}>
                                                {item}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                        </article>

                        <article className="preview-card translate-status-card">
                            <div className="card-header">
                                <h3>检索概览</h3>
                                <span className="meta-chip">{result ? directionBadge(result.direction) : 'READY'}</span>
                            </div>
                            <div className="translate-status-grid">
                                <article className="translate-status-cell">
                                    <span>版本</span>
                                    <strong>{metadata ? metadata.version : '加载中'}</strong>
                                    <small>{metadata?.sourceLabel ?? '读取词典资源'}</small>
                                </article>
                                <article className="translate-status-cell">
                                    <span>结果</span>
                                    <strong>{resultItems.length || 0}</strong>
                                    <small>{result ? directionBadge(result.direction) : '等待查询'}</small>
                                </article>
                                <article className="translate-status-cell">
                                    <span>方向</span>
                                    <strong>{result ? directionBadge(result.direction) : defaultDirectionLabel}</strong>
                                    <small>{result ? result.query : '尚未发起查询'}</small>
                                </article>
                                <article className="translate-status-cell">
                                    <span>更新</span>
                                    <strong>{formatGeneratedAt(metadata?.generatedAt)}</strong>
                                    <small>{metadata ? `${metadata.packageCount} 个数据包` : '读取中'}</small>
                                </article>
                            </div>
                            {metadata?.features.length ? (
                                <div className="translate-chip-row">
                                    {metadata.features.map((feature) => (
                                        <span key={feature} className="detail-chip feature-chip">{feature}</span>
                                    ))}
                                </div>
                            ) : null}
                            <div className="translate-status-note">
                                <strong>{selectedEntry ? selectedEntry.term : '检索提示'}</strong>
                                <p>
                                    {selectedEntry
                                        ? `${selectedEntry.primaryTranslation}${selectedEntry.aliases.length ? ` · 别名 ${selectedEntry.aliases.slice(0, 2).join(' / ')}` : ''}`
                                        : error ?? status}
                                </p>
                            </div>
                        </article>
                    </section>

                    <article className="preview-card translate-results-card">
                        <div className="card-header">
                            <h3>候选结果</h3>
                            <span className="meta-chip">{resultItems.length ? `${resultItems.length} 条` : '等待查询'}</span>
                        </div>
                        {result ? (
                            <div className="translate-overview-grid">
                                <article className="signal-cell compact-signal">
                                    <span>QUERY</span>
                                    <strong>{result.query}</strong>
                                    <small>{result.normalizedQuery}</small>
                                </article>
                                <article className="signal-cell compact-signal">
                                    <span>LANG</span>
                                    <strong>{result.detectedSourceLanguage === 'zh' ? '中文' : 'English'}</strong>
                                    <small>{directionBadge(result.direction)}</small>
                                </article>
                                <article className="signal-cell compact-signal">
                                    <span>TOTAL</span>
                                    <strong>{result.totalHits}</strong>
                                    <small>{result.suggestions.length ? `${result.suggestions.length} 个建议` : '无额外建议'}</small>
                                </article>
                            </div>
                        ) : null}
                        {result ? (
                            <div className="translate-results-stack">
                                <ResultSection
                                    title={sectionTitle('phrase')}
                                    items={result.phraseHits}
                                    selectedId={selectedEntry?.id ?? null}
                                    onSelect={setSelectedEntry}
                                    compact={settings?.compactResultView ?? false}
                                />
                                <ResultSection
                                    title={sectionTitle('exact')}
                                    items={result.exactHits}
                                    selectedId={selectedEntry?.id ?? null}
                                    onSelect={setSelectedEntry}
                                    compact={settings?.compactResultView ?? false}
                                />
                                <ResultSection
                                    title={sectionTitle('fuzzy')}
                                    items={result.fuzzyHits}
                                    selectedId={selectedEntry?.id ?? null}
                                    onSelect={setSelectedEntry}
                                    compact={settings?.compactResultView ?? false}
                                />
                                {!resultItems.length ? (
                                    <div className="empty-state subtle">
                                        <strong>NO MATCH</strong>
                                        <p>可以换一种表达，或切换查询方向</p>
                                    </div>
                                ) : null}
                            </div>
                        ) : (
                            <div className="empty-state subtle">
                                <strong>OFFLINE READY</strong>
                                <p>输入任意中英单词或短语后开始查询</p>
                            </div>
                        )}
                    </article>

                    <article className="preview-card translate-support-card">
                        <div className="card-header">
                            <h3>查询侧记</h3>
                            <span className="meta-chip">{supportCount}</span>
                        </div>
                        <div className="translate-support-overview">
                            <article className="translate-support-pill">
                                <span>最近查询</span>
                                <strong>{history.length}</strong>
                                <small>保留回放路径与命中数量</small>
                            </article>
                            <article className="translate-support-pill">
                                <span>收藏夹</span>
                                <strong>{favorites.length}</strong>
                                <small>保留常用词条与当前方向</small>
                            </article>
                        </div>
                        <div className="translate-support-toolbar">
                            <div className="translate-support-switch">
                                <button
                                    type="button"
                                    className={supportView === 'history' ? 'support-switch-button active' : 'support-switch-button'}
                                    onClick={() => setSupportView('history')}
                                >
                                    最近查询
                                </button>
                                <button
                                    type="button"
                                    className={supportView === 'favorites' ? 'support-switch-button active' : 'support-switch-button'}
                                    onClick={() => setSupportView('favorites')}
                                >
                                    收藏夹
                                </button>
                            </div>
                            <p>{supportView === 'history' ? '点击记录可直接回放查询路径。' : '收藏会保留查询方向和首条释义。'}</p>
                        </div>

                        {supportView === 'history' ? (
                            history.length ? (
                                <div className="translate-support-list">
                                    {history.map((item) => (
                                        <button
                                            key={item.id}
                                            type="button"
                                            className="utility-list-item support-item"
                                            onClick={() => {
                                                setQuery(item.query)
                                                setDirection(item.direction)
                                                void runLookup(item.query, item.direction)
                                            }}
                                        >
                                            <div className="support-item-head">
                                                <strong>{item.query}</strong>
                                                <span className="support-item-time">{formatTime(item.createdAt)}</span>
                                            </div>
                                            <span>{directionBadge(item.direction)} · {item.resultCount} 条结果</span>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <div className="empty-state subtle compact-empty support-empty-state">
                                    <strong>暂无历史</strong>
                                    <p>开始一次查询后，这里会保留最近检索轨迹。</p>
                                </div>
                            )
                        ) : favorites.length ? (
                            <div className="translate-support-list">
                                {favorites.map((item) => (
                                    <div key={item.id} className="favorite-list-item support-favorite-item">
                                        <button
                                            type="button"
                                            className="utility-list-item support-item"
                                            onClick={() => {
                                                setQuery(item.query)
                                                setDirection(item.direction)
                                                void runLookup(item.query, item.direction)
                                            }}
                                        >
                                            <div className="support-item-head">
                                                <strong>{item.query}</strong>
                                                <span className="support-item-time">{directionBadge(item.direction)}</span>
                                            </div>
                                            <span>{item.translation}</span>
                                        </button>
                                        <button type="button" className="ghost-button support-remove-button" onClick={() => void handleRemoveFavorite(item)}>
                                            移除
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="empty-state subtle compact-empty support-empty-state">
                                <strong>暂无收藏</strong>
                                <p>选中候选后可随时加入收藏，便于回放常用词条。</p>
                            </div>
                        )}
                    </article>
                </section>

                <aside className="panel translate-side-panel">
                    <header className="panel-header">
                        <div className="panel-title-row">
                            <h3>词条详情</h3>
                            <span className="panel-chip">{selectedEntry ? directionBadge(result?.direction ?? 'enToZh') : 'WAIT'}</span>
                        </div>
                        <p>{selectedEntry ? `${selectedEntry.variants.length} 条义项 · ${selectedEntry.aliases.length} 个别名` : '从左侧结果里选择一条词条，查看释义、例句和本地设置。'}</p>
                    </header>

                    {selectedEntry ? (
                        <>
                            <section className="panel-section detail-hero">
                                <div className="detail-headline">
                                    <strong>{selectedEntry.term}</strong>
                                    <span>{selectedEntry.primaryTranslation}</span>
                                </div>
                                <div className="detail-action-row">
                                    <button type="button" className="secondary-button" onClick={() => void copySelection()}>
                                        复制释义
                                    </button>
                                    <button type="button" className="secondary-button" onClick={() => void handleFavorite(selectedEntry)} disabled={selectedEntryFavorited}>
                                        {selectedEntryFavorited ? '已收藏' : '收藏词条'}
                                    </button>
                                </div>
                                <div className="detail-meta-grid">
                                    <div className="signal-cell compact-signal">
                                        <span>MATCH</span>
                                        <strong>{selectedEntry.matchReason}</strong>
                                        <small>{selectedEntry.isPhrase ? '短语优先' : '词条命中'} · {selectedEntry.score.toFixed(1)}</small>
                                    </div>
                                    <div className="signal-cell compact-signal">
                                        <span>VOICE</span>
                                        <strong>{selectedEntry.phonetic ?? selectedEntry.pronunciation ?? '—'}</strong>
                                        <small>{selectedEntry.sourceLanguage} → {selectedEntry.targetLanguage}</small>
                                    </div>
                                    <div className="signal-cell compact-signal">
                                        <span>ALIAS</span>
                                        <strong>{selectedEntry.aliases.length}</strong>
                                        <small>{selectedEntry.aliases.length ? '可作为快捷检索入口' : '当前无别名'}</small>
                                    </div>
                                    <div className="signal-cell compact-signal">
                                        <span>EXAMPLE</span>
                                        <strong>{selectedExampleCount}</strong>
                                        <small>{selectedEntry.variants.length} 条义项中的例句总数</small>
                                    </div>
                                </div>
                            </section>

                            <section className="panel-section detail-context">
                                <div className="section-heading">
                                    <h3>词条线索</h3>
                                    <span className="panel-chip">{selectedEntry.tags.length + selectedEntry.aliases.length}</span>
                                </div>
                                <div className="detail-group">
                                    <span className="detail-group-label">标签</span>
                                    <div className="translate-chip-row detail-chip-row">
                                        {selectedEntry.tags.length ? (
                                            selectedEntry.tags.map((tag) => (
                                                <span key={tag} className="detail-chip">{tag}</span>
                                            ))
                                        ) : (
                                            <span className="detail-chip detail-chip-muted">暂无标签</span>
                                        )}
                                    </div>
                                </div>
                                <div className="detail-group">
                                    <span className="detail-group-label">别名</span>
                                    <div className="translate-chip-row detail-chip-row">
                                        {selectedEntry.aliases.length ? (
                                            selectedEntry.aliases.map((alias) => (
                                                <button key={alias} type="button" className="detail-chip alias-chip" onClick={() => void runLookup(alias)}>
                                                    {alias}
                                                </button>
                                            ))
                                        ) : (
                                            <span className="detail-chip detail-chip-muted">暂无别名</span>
                                        )}
                                    </div>
                                </div>
                            </section>

                            <section className="panel-section detail-variants">
                                <div className="section-heading">
                                    <h3>义项与例句</h3>
                                    <span className="panel-chip">{selectedEntry.variants.length}</span>
                                </div>
                                {selectedEntry.variants.map((variant, index) => (
                                    <article key={variant.id} className="detail-variant-card">
                                        <div className="detail-variant-head">
                                            <strong>{variant.definition}</strong>
                                            <span>{variant.partOfSpeech ?? `sense ${index + 1}`}</span>
                                        </div>
                                        <div className="detail-variant-meta">
                                            <span>序号 {index + 1}</span>
                                            <span>评分 {variant.score.toFixed(1)}</span>
                                            <span>{variant.examples.length ? `${variant.examples.length} 条例句` : '暂无例句'}</span>
                                        </div>
                                        {variant.examples.length ? (
                                            <ul className="translate-note-list compact-note-list">
                                                {variant.examples.map((example) => (
                                                    <li key={example}>{example}</li>
                                                ))}
                                            </ul>
                                        ) : null}
                                    </article>
                                ))}
                            </section>
                        </>
                    ) : (
                        <div className="empty-state subtle detail-empty">
                            <strong>DETAIL</strong>
                            <p>查询后选择一条候选，右侧会展开词条详情</p>
                        </div>
                    )}

                    <section className="panel-section detail-settings">
                        <div className="section-heading">
                            <h3>本地设置</h3>
                            <button type="button" className="ghost-button detail-settings-toggle" onClick={() => setSettingsExpanded((current) => !current)}>
                                {settingsExpanded ? '收起' : '展开'}
                            </button>
                        </div>
                        <div className="settings-summary-card">
                            <strong>{metadata?.sourceLabel ?? '离线词典'}</strong>
                            <span>{metadata ? `${metadata.packageCount} 个数据包 · ${metadata.entryCount} 词条 · ${metadata.phraseCount} 短语` : '读取中'}</span>
                            <small>最近构建：{formatGeneratedAt(metadata?.generatedAt)}</small>
                        </div>
                        {metadata?.features.length ? (
                            <div className="translate-chip-row">
                                {metadata.features.map((feature) => (
                                    <span key={feature} className="detail-chip feature-chip">{feature}</span>
                                ))}
                            </div>
                        ) : null}
                        {settingsExpanded ? (
                            <>
                                <label className="field checkbox-field">
                                    <span>默认方向</span>
                                    <select
                                        value={settings?.defaultDirection ?? 'auto'}
                                        onChange={(event) => void patchSettings({ defaultDirection: event.target.value as QueryDirection })}
                                        disabled={settingsBusy}
                                    >
                                        {directionOptions.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label} · {option.description}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="toggle-field">
                                    <span>查询后自动复制首条释义</span>
                                    <input
                                        type="checkbox"
                                        checked={settings?.autoCopyPrimary ?? false}
                                        onChange={(event) => void patchSettings({ autoCopyPrimary: event.target.checked })}
                                        disabled={settingsBusy}
                                    />
                                </label>
                                <label className="toggle-field">
                                    <span>紧凑结果视图</span>
                                    <input
                                        type="checkbox"
                                        checked={settings?.compactResultView ?? false}
                                        onChange={(event) => void patchSettings({ compactResultView: event.target.checked })}
                                        disabled={settingsBusy}
                                    />
                                </label>
                                <label className="field">
                                    <span>历史条数上限</span>
                                    <input
                                        type="number"
                                        min="10"
                                        max="200"
                                        value={settings?.maxHistoryItems ?? 40}
                                        onChange={(event) => void patchSettings({ maxHistoryItems: Math.max(10, Number(event.target.value) || 40) })}
                                        disabled={settingsBusy}
                                    />
                                </label>
                            </>
                        ) : (
                            <p className="detail-settings-note">需要调整默认方向、自动复制或历史条数时，再展开本地设置。</p>
                        )}
                    </section>
                </aside>
            </div>
        </main>
    )
}
