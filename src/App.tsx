import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import './App.css'
import { runTool } from './lib/desktop'
import type {
    ImageAsset,
    ImageFormat,
    ProcessResponse,
    ToolId,
    ToolRequest,
    WatermarkPosition,
} from './types'

const tools: Array<{
    id: ToolId
    icon: string
    label: string
    summary: string
    badge?: string
    requiresSource: boolean
}> = [
        {
            id: 'base64Encode',
            icon: '🔣',
            label: '转为 Base64',
            summary: '把当前图片重新编码为标准 Data URL，便于接口传输与嵌入。',
            badge: 'B64+',
            requiresSource: true,
        },
        {
            id: 'base64Decode',
            icon: '🖼️',
            label: 'Base64 转图像',
            summary: '粘贴 Base64 文本，直接还原成可继续编辑的图像。',
            badge: 'B64-',
            requiresSource: false,
        },
        {
            id: 'enhance',
            icon: '✨',
            label: '画质增强',
            summary: '通过亮度、对比度、锐化和饱和度做轻量增强。',
            badge: 'ENH',
            requiresSource: true,
        },
        {
            id: 'compress',
            icon: '📦',
            label: '图像压缩',
            summary: '调整尺寸和编码质量，快速输出更轻的图片。',
            badge: 'ZIP',
            requiresSource: true,
        },
        {
            id: 'watermark',
            icon: '💧',
            label: '增加水印',
            summary: '支持文字水印和图片水印，适合批量出图场景。',
            badge: 'WTM',
            requiresSource: true,
        },
        {
            id: 'crop',
            icon: '✂️',
            label: '裁切图像',
            summary: '输入像素区域，精确裁切图片指定部分。',
            badge: 'CRP',
            requiresSource: true,
        },
        {
            id: 'split',
            icon: '🧩',
            label: '分割图像',
            summary: '按照网格切分图片，适合九宫格和素材拆图。',
            badge: 'SPL',
            requiresSource: true,
        },
    ]

const watermarkPositions: Array<{ value: WatermarkPosition; label: string }> = [
    { value: 'topLeft', label: '左上' },
    { value: 'topCenter', label: '上中' },
    { value: 'topRight', label: '右上' },
    { value: 'centerLeft', label: '左中' },
    { value: 'center', label: '居中' },
    { value: 'centerRight', label: '右中' },
    { value: 'bottomLeft', label: '左下' },
    { value: 'bottomCenter', label: '下中' },
    { value: 'bottomRight', label: '右下' },
]

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value))
}

function toInteger(value: string, fallback: number) {
    const next = Number(value)
    if (!Number.isFinite(next)) return fallback
    return Math.trunc(next)
}

function toFloat(value: string, fallback: number) {
    const next = Number(value)
    if (!Number.isFinite(next)) return fallback
    return next
}

function getErrorMessage(error: unknown) {
    if (error instanceof Error && error.message) return error.message
    if (typeof error === 'string' && error.trim()) return error
    if (error && typeof error === 'object') {
        const maybeMessage = Reflect.get(error, 'message')
        if (typeof maybeMessage === 'string' && maybeMessage.trim()) return maybeMessage

        const maybeString = Reflect.get(error, 'toString')
        if (typeof maybeString === 'function') {
            const rendered = String(error)
            if (rendered && rendered !== '[object Object]') return rendered
        }
    }

    return '处理失败'
}

function App() {
    const sourceInputRef = useRef<HTMLInputElement | null>(null)
    const overlayInputRef = useRef<HTMLInputElement | null>(null)

    const [toolDirectoryOpen, setToolDirectoryOpen] = useState(true)
    const [selectedTool, setSelectedTool] = useState<ToolId>('base64Encode')
    const [sourceAsset, setSourceAsset] = useState<ImageAsset | null>(null)
    const [sourceHistory, setSourceHistory] = useState<ImageAsset[]>([])
    const [result, setResult] = useState<ProcessResponse | null>(null)
    const [status, setStatus] = useState('选择图片或输入 Base64，右侧配置参数后执行处理。')
    const [busy, setBusy] = useState(false)

    const [encodeFormat, setEncodeFormat] = useState<ImageFormat>('png')
    const [decodeInput, setDecodeInput] = useState('')
    const [decodeFormat, setDecodeFormat] = useState<'auto' | ImageFormat>('auto')
    const [enhance, setEnhance] = useState({ contrast: 16, brighten: 4, sharpen: 1.2, saturation: 1.08 })
    const [compress, setCompress] = useState({ format: 'jpeg' as ImageFormat, quality: 78, maxWidth: 1600 })
    const [watermarkMode, setWatermarkMode] = useState<'text' | 'image'>('text')
    const [watermarkText, setWatermarkText] = useState('Tool Box')
    const [watermarkScale, setWatermarkScale] = useState(24)
    const [watermarkOpacity, setWatermarkOpacity] = useState(0.28)
    const [watermarkMargin, setWatermarkMargin] = useState(28)
    const [watermarkPosition, setWatermarkPosition] = useState<WatermarkPosition>('bottomRight')
    const [watermarkOverlay, setWatermarkOverlay] = useState<ImageAsset | null>(null)
    const [crop, setCrop] = useState({ x: 0, y: 0, width: 1200, height: 1200 })
    const [split, setSplit] = useState({ rows: 2, cols: 2 })

    const selectedToolMeta = tools.find((tool) => tool.id === selectedTool)!

    const cropWidthMax = sourceAsset ? Math.max(1, sourceAsset.width - crop.x) : 1
    const cropHeightMax = sourceAsset ? Math.max(1, sourceAsset.height - crop.y) : 1
    const splitRowsMax = sourceAsset ? Math.max(1, sourceAsset.height) : 1
    const splitColsMax = sourceAsset ? Math.max(1, sourceAsset.width) : 1

    async function readFileAsDataUrl(file: File) {
        return new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result ?? ''))
            reader.onerror = () => reject(new Error('读取文件失败'))
            reader.readAsDataURL(file)
        })
    }

    async function readImageMetrics(dataUrl: string) {
        return new Promise<{ width: number; height: number }>((resolve, reject) => {
            const image = new Image()
            image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
            image.onerror = () => reject(new Error('无法解析图像尺寸'))
            image.src = dataUrl
        })
    }

    async function createImageAsset(file: File): Promise<ImageAsset> {
        const dataUrl = await readFileAsDataUrl(file)
        const { width, height } = await readImageMetrics(dataUrl)
        return {
            name: file.name,
            dataUrl,
            width,
            height,
            size: file.size,
            mimeType: file.type || 'image/png',
        }
    }

    function extensionFor(mimeType: string) {
        if (mimeType.includes('jpeg')) return 'jpg'
        if (mimeType.includes('png')) return 'png'
        if (mimeType.includes('webp')) return 'webp'
        return 'png'
    }

    function formatBytes(bytes: number | undefined) {
        if (!bytes) return '0 B'
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    }

    function syncSource(asset: ImageAsset, resetHistory = false) {
        const safeRows = clamp(2, 1, Math.max(1, asset.height))
        const safeCols = clamp(2, 1, Math.max(1, asset.width))
        setSourceAsset(asset)
        setCrop({ x: 0, y: 0, width: asset.width, height: asset.height })
        setSplit({ rows: safeRows, cols: safeCols })
        setResult(null)
        setStatus(`已载入 ${asset.name}，当前尺寸 ${asset.width} × ${asset.height}`)
        setSourceHistory((current) => (resetHistory ? [asset] : [...current, asset]))
    }

    function updateCrop(partial: Partial<typeof crop>) {
        setCrop((current) => {
            const next = { ...current, ...partial }
            if (!sourceAsset) {
                return {
                    x: Math.max(0, next.x),
                    y: Math.max(0, next.y),
                    width: Math.max(1, next.width),
                    height: Math.max(1, next.height),
                }
            }

            const x = clamp(next.x, 0, Math.max(0, sourceAsset.width - 1))
            const y = clamp(next.y, 0, Math.max(0, sourceAsset.height - 1))
            const width = clamp(next.width, 1, Math.max(1, sourceAsset.width - x))
            const height = clamp(next.height, 1, Math.max(1, sourceAsset.height - y))
            return { x, y, width, height }
        })
    }

    function updateSplit(partial: Partial<typeof split>) {
        setSplit((current) => {
            const next = { ...current, ...partial }
            if (!sourceAsset) {
                return {
                    rows: Math.max(1, next.rows),
                    cols: Math.max(1, next.cols),
                }
            }

            return {
                rows: clamp(next.rows, 1, Math.max(1, sourceAsset.height)),
                cols: clamp(next.cols, 1, Math.max(1, sourceAsset.width)),
            }
        })
    }

    async function handleSourceFile(file: File) {
        const asset = await createImageAsset(file)
        syncSource(asset, true)
    }

    async function handleOverlayFile(file: File) {
        const asset = await createImageAsset(file)
        setWatermarkOverlay(asset)
        setStatus(`已载入水印图 ${asset.name}`)
    }

    async function onSourceInputChange(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0]
        if (!file) return
        await handleSourceFile(file)
        event.target.value = ''
    }

    async function onOverlayInputChange(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0]
        if (!file) return
        await handleOverlayFile(file)
        event.target.value = ''
    }

    function downloadDataUrl(dataUrl: string, filename: string) {
        const anchor = document.createElement('a')
        anchor.href = dataUrl
        anchor.download = filename
        anchor.click()
    }

    async function copyPrimaryText() {
        if (!result?.primaryText) return
        await navigator.clipboard.writeText(result.primaryText)
        setStatus('结果文本已复制到剪贴板')
    }

    function undoSource() {
        if (sourceHistory.length < 2) {
            setStatus('当前没有可撤销的已应用结果')
            return
        }

        const nextHistory = sourceHistory.slice(0, -1)
        const previous = nextHistory[nextHistory.length - 1]
        setSourceHistory(nextHistory)
        setSourceAsset(previous)
        setCrop({ x: 0, y: 0, width: previous.width, height: previous.height })
        setSplit({ rows: clamp(2, 1, previous.height), cols: clamp(2, 1, previous.width) })
        setResult(null)
        setStatus(`已撤销，回到 ${previous.name}`)
    }

    function promoteResultToSource() {
        if (!result?.primaryDataUrl || !result.width || !result.height) {
            setStatus('当前结果无法继续编辑')
            return
        }

        const mimeType = result.mimeType ?? 'image/png'
        const nextSource: ImageAsset = {
            name: `derived-${Date.now()}.${extensionFor(mimeType)}`,
            dataUrl: result.primaryDataUrl,
            width: result.width,
            height: result.height,
            size: result.bytes,
            mimeType,
        }

        syncSource(nextSource)
        setStatus('结果已设为当前工作图像，可继续串联处理')
    }

    async function createTextWatermarkDataUrl() {
        const text = watermarkText.trim()
        if (!text) throw new Error('请输入水印文字')

        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (!context) throw new Error('浏览器无法创建水印画布')

        const fontSize = 56
        const fontFamily = '600 56px "Avenir Next", "PingFang SC", "Hiragino Sans GB", sans-serif'
        context.font = fontFamily
        const metrics = context.measureText(text)
        const paddingX = 48
        const paddingY = 28
        canvas.width = Math.ceil(metrics.width + paddingX * 2)
        canvas.height = Math.ceil(fontSize + paddingY * 2)

        const draw = canvas.getContext('2d')
        if (!draw) throw new Error('浏览器无法渲染水印画布')
        draw.clearRect(0, 0, canvas.width, canvas.height)
        draw.font = fontFamily
        draw.fillStyle = 'rgba(247, 248, 245, 1)'
        draw.textBaseline = 'middle'
        draw.shadowColor = 'rgba(12, 18, 28, 0.12)'
        draw.shadowBlur = 10
        draw.fillText(text, paddingX, canvas.height / 2)

        return canvas.toDataURL('image/png')
    }

    function getValidationError() {
        if (selectedToolMeta.requiresSource && !sourceAsset) {
            return '请先加载图片，再执行当前工具。'
        }

        switch (selectedTool) {
            case 'base64Encode':
                return null
            case 'base64Decode':
                return decodeInput.trim() ? null : '请输入要解码的 Base64 字符串。'
            case 'enhance':
                if (enhance.sharpen <= 0) return '锐化必须大于 0。'
                if (enhance.saturation <= 0) return '饱和度必须大于 0。'
                return null
            case 'compress':
                if (!Number.isFinite(compress.quality) || compress.quality < 1 || compress.quality > 100) {
                    return '压缩质量必须在 1 到 100 之间。'
                }
                if (!Number.isFinite(compress.maxWidth) || compress.maxWidth < 0) {
                    return '最大宽度不能小于 0。'
                }
                return null
            case 'watermark':
                if (watermarkMode === 'text' && !watermarkText.trim()) {
                    return '请输入水印文字。'
                }
                if (watermarkMode === 'image' && !watermarkOverlay) {
                    return '请选择水印图片。'
                }
                if (watermarkScale <= 0) return '缩放占比必须大于 0。'
                if (watermarkOpacity < 0 || watermarkOpacity > 1) return '透明度必须在 0 到 1 之间。'
                if (watermarkMargin < 0) return '边距不能小于 0。'
                return null
            case 'crop':
                if (!sourceAsset) return '请先加载图片。'
                if (crop.width < 1 || crop.height < 1) return '裁切宽高必须大于 0。'
                if (crop.x < 0 || crop.y < 0) return '裁切坐标不能为负数。'
                if (crop.x + crop.width > sourceAsset.width || crop.y + crop.height > sourceAsset.height) {
                    return `裁切区域不能超出图像边界 ${sourceAsset.width} × ${sourceAsset.height}。`
                }
                return null
            case 'split':
                if (!sourceAsset) return '请先加载图片。'
                if (split.rows < 1 || split.cols < 1) return '行数和列数必须大于 0。'
                if (split.rows > sourceAsset.height || split.cols > sourceAsset.width) {
                    return `行数不能超过 ${sourceAsset.height}，列数不能超过 ${sourceAsset.width}。`
                }
                return null
        }
    }

    function getToolHint() {
        switch (selectedTool) {
            case 'compress':
                return compress.maxWidth <= 0
                    ? '最大宽度填写 0 表示保持原始尺寸，仅调整编码方式和质量。'
                    : compress.format === 'jpeg'
                        ? 'JPEG 会真正使用质量滑杆，适合体积优先。'
                        : 'PNG / WebP 当前使用默认编码策略，质量滑杆主要用于 JPEG。'
            case 'crop':
                return sourceAsset
                    ? `当前图像 ${sourceAsset.width} × ${sourceAsset.height}，裁切宽度最多 ${cropWidthMax}，高度最多 ${cropHeightMax}。`
                    : '加载图片后可按像素精确裁切。'
            case 'split':
                return sourceAsset
                    ? `当前图像最多支持 ${splitRowsMax} 行、${splitColsMax} 列。`
                    : '加载图片后会根据像素尺寸动态限制行列数。'
            case 'watermark':
                return watermarkMode === 'image'
                    ? '图片水印推荐使用透明 PNG，位置和透明度会在本地后端统一处理。'
                    : '文字水印会先生成透明 PNG，再交给 Rust 后端合成。'
            default:
                return null
        }
    }

    const validationError = getValidationError()
    const toolHint = getToolHint()
    const canExecute = !busy
    const runtimeState = busy ? 'BUSY' : 'IDLE'
    const noticeTone = validationError ? 'error' : toolHint ? 'hint' : 'neutral'
    const noticeText = validationError ?? toolHint
    const sourceSummary = sourceAsset ? `${sourceAsset.width} × ${sourceAsset.height}` : 'No source'
    const resultSummary = result?.width && result?.height
        ? `${result.width} × ${result.height}`
        : result?.splitItems.length
            ? `${result.splitItems.length} Tiles`
            : 'No output'
    const assetName = sourceAsset?.name ?? '等待载入图像'
    const resultMeta = result?.mimeType ?? '尚无结果'

    async function buildRequest(): Promise<ToolRequest> {
        switch (selectedTool) {
            case 'base64Encode':
                if (!sourceAsset) throw new Error('请先选择图片')
                return {
                    kind: 'base64Encode',
                    sourceDataUrl: sourceAsset.dataUrl,
                    outputFormat: encodeFormat,
                }
            case 'base64Decode':
                if (!decodeInput.trim()) throw new Error('请输入 Base64 字符串')
                return {
                    kind: 'base64Decode',
                    base64Input: decodeInput.trim(),
                    outputFormat: decodeFormat === 'auto' ? null : decodeFormat,
                }
            case 'enhance':
                if (!sourceAsset) throw new Error('请先选择图片')
                return {
                    kind: 'enhance',
                    sourceDataUrl: sourceAsset.dataUrl,
                    contrast: enhance.contrast,
                    brighten: enhance.brighten,
                    sharpen: enhance.sharpen,
                    saturation: enhance.saturation,
                }
            case 'compress':
                if (!sourceAsset) throw new Error('请先选择图片')
                return {
                    kind: 'compress',
                    sourceDataUrl: sourceAsset.dataUrl,
                    outputFormat: compress.format,
                    quality: clamp(Math.trunc(compress.quality), 1, 100),
                    maxWidth: compress.maxWidth > 0 ? Math.trunc(compress.maxWidth) : null,
                }
            case 'watermark': {
                if (!sourceAsset) throw new Error('请先选择图片')
                const overlayDataUrl =
                    watermarkMode === 'image'
                        ? watermarkOverlay?.dataUrl
                        : await createTextWatermarkDataUrl()
                if (!overlayDataUrl) throw new Error('请先选择水印图片')
                return {
                    kind: 'watermark',
                    sourceDataUrl: sourceAsset.dataUrl,
                    overlayDataUrl,
                    position: watermarkPosition,
                    opacity: watermarkOpacity,
                    scalePercent: Math.max(1, Math.trunc(watermarkScale)),
                    margin: Math.max(0, Math.trunc(watermarkMargin)),
                }
            }
            case 'crop':
                if (!sourceAsset) throw new Error('请先选择图片')
                return {
                    kind: 'crop',
                    sourceDataUrl: sourceAsset.dataUrl,
                    x: Math.max(0, Math.trunc(crop.x)),
                    y: Math.max(0, Math.trunc(crop.y)),
                    width: Math.max(1, Math.trunc(crop.width)),
                    height: Math.max(1, Math.trunc(crop.height)),
                }
            case 'split':
                if (!sourceAsset) throw new Error('请先选择图片')
                return {
                    kind: 'split',
                    sourceDataUrl: sourceAsset.dataUrl,
                    rows: Math.max(1, Math.trunc(split.rows)),
                    cols: Math.max(1, Math.trunc(split.cols)),
                }
        }
    }

    async function runSelectedTool() {
        if (validationError) {
            setStatus(validationError)
            return
        }

        setBusy(true)
        setStatus(`正在执行 ${selectedToolMeta.label}...`)

        try {
            const request = await buildRequest()
            const response = await runTool(request)
            setResult(response)
            setStatus(response.notes[0] ?? `${selectedToolMeta.label} 已完成`)
        } catch (error) {
            setStatus(getErrorMessage(error))
        } finally {
            setBusy(false)
        }
    }

    async function exportPrimaryResult() {
        if (!result?.primaryDataUrl) {
            setStatus('当前结果没有可导出的主图像')
            return
        }

        const extension = extensionFor(result.mimeType ?? 'image/png')
        downloadDataUrl(result.primaryDataUrl, `tool-box-output.${extension}`)
        setStatus('主结果已导出')
    }

    function onDropSource(event: DragEvent<HTMLDivElement>) {
        event.preventDefault()
        const file = event.dataTransfer.files?.[0]
        if (!file || !file.type.startsWith('image/')) return
        void handleSourceFile(file)
    }

    function renderToolPanel() {
        switch (selectedTool) {
            case 'base64Encode':
                return (
                    <>
                        <section className="panel-section">
                            <h3>编码设置</h3>
                            <label className="field">
                                <span>输出格式</span>
                                <select value={encodeFormat} onChange={(event) => setEncodeFormat(event.target.value as ImageFormat)}>
                                    <option value="png">PNG</option>
                                    <option value="jpeg">JPEG</option>
                                    <option value="webp">WebP</option>
                                </select>
                            </label>
                        </section>
                        <section className="panel-section">
                            <div className="section-heading">
                                <h3>结果文本</h3>
                                <button type="button" className="ghost-button" onClick={() => void copyPrimaryText()} disabled={!result?.primaryText}>
                                    复制
                                </button>
                            </div>
                            <textarea className="result-textarea" value={result?.primaryText ?? ''} readOnly placeholder="执行后会在这里输出完整 Data URL" />
                        </section>
                    </>
                )
            case 'base64Decode':
                return (
                    <>
                        <section className="panel-section">
                            <h3>输入 Base64</h3>
                            <textarea
                                className="result-textarea"
                                value={decodeInput}
                                onChange={(event) => setDecodeInput(event.target.value)}
                                placeholder="支持 data:image/...;base64,xxx 或纯 Base64 字符串"
                            />
                        </section>
                        <section className="panel-section compact-grid">
                            <label className="field">
                                <span>输出格式</span>
                                <select value={decodeFormat} onChange={(event) => setDecodeFormat(event.target.value as 'auto' | ImageFormat)}>
                                    <option value="auto">自动检测</option>
                                    <option value="png">PNG</option>
                                    <option value="jpeg">JPEG</option>
                                    <option value="webp">WebP</option>
                                </select>
                            </label>
                        </section>
                    </>
                )
            case 'enhance':
                return (
                    <section className="panel-section stack-gap">
                        <h3>增强参数</h3>
                        <label className="field">
                            <span>对比度</span>
                            <input type="range" min="-30" max="40" value={enhance.contrast} onChange={(event) => setEnhance((current) => ({ ...current, contrast: Number(event.target.value) }))} />
                            <strong>{enhance.contrast}</strong>
                        </label>
                        <label className="field">
                            <span>亮度</span>
                            <input type="range" min="-40" max="40" value={enhance.brighten} onChange={(event) => setEnhance((current) => ({ ...current, brighten: Number(event.target.value) }))} />
                            <strong>{enhance.brighten}</strong>
                        </label>
                        <label className="field">
                            <span>锐化</span>
                            <input type="range" min="0.1" max="4" step="0.1" value={enhance.sharpen} onChange={(event) => setEnhance((current) => ({ ...current, sharpen: Number(event.target.value) }))} />
                            <strong>{enhance.sharpen.toFixed(1)}</strong>
                        </label>
                        <label className="field">
                            <span>饱和度</span>
                            <input type="range" min="0.1" max="1.6" step="0.02" value={enhance.saturation} onChange={(event) => setEnhance((current) => ({ ...current, saturation: Number(event.target.value) }))} />
                            <strong>{enhance.saturation.toFixed(2)}</strong>
                        </label>
                    </section>
                )
            case 'compress':
                return (
                    <section className="panel-section stack-gap">
                        <h3>压缩参数</h3>
                        <label className="field">
                            <span>输出格式</span>
                            <select value={compress.format} onChange={(event) => setCompress((current) => ({ ...current, format: event.target.value as ImageFormat }))}>
                                <option value="jpeg">JPEG</option>
                                <option value="png">PNG</option>
                                <option value="webp">WebP</option>
                            </select>
                        </label>
                        <label className="field">
                            <span>压缩质量</span>
                            <input type="range" min="1" max="100" value={compress.quality} onChange={(event) => setCompress((current) => ({ ...current, quality: clamp(toInteger(event.target.value, current.quality), 1, 100) }))} />
                            <strong>{compress.quality}%</strong>
                        </label>
                        <label className="field">
                            <span>最大宽度</span>
                            <input type="number" min="0" value={compress.maxWidth} onChange={(event) => setCompress((current) => ({ ...current, maxWidth: Math.max(0, toInteger(event.target.value, current.maxWidth)) }))} />
                        </label>
                    </section>
                )
            case 'watermark':
                return (
                    <>
                        <section className="panel-section stack-gap">
                            <div className="toggle-row">
                                <button type="button" className={watermarkMode === 'text' ? 'mode-button active' : 'mode-button'} onClick={() => setWatermarkMode('text')}>
                                    文字水印
                                </button>
                                <button type="button" className={watermarkMode === 'image' ? 'mode-button active' : 'mode-button'} onClick={() => setWatermarkMode('image')}>
                                    图片水印
                                </button>
                            </div>
                            {watermarkMode === 'text' ? (
                                <label className="field">
                                    <span>水印文字</span>
                                    <input value={watermarkText} onChange={(event) => setWatermarkText(event.target.value)} />
                                </label>
                            ) : (
                                <div className="upload-card">
                                    <div>
                                        <strong>{watermarkOverlay?.name ?? '尚未选择水印图'}</strong>
                                        <p>推荐透明 PNG。</p>
                                    </div>
                                    <button type="button" className="secondary-button" onClick={() => overlayInputRef.current?.click()}>
                                        选择水印图
                                    </button>
                                </div>
                            )}
                            <label className="field">
                                <span>缩放占比</span>
                                <input type="range" min="1" max="60" value={watermarkScale} onChange={(event) => setWatermarkScale(clamp(toInteger(event.target.value, watermarkScale), 1, 60))} />
                                <strong>{watermarkScale}%</strong>
                            </label>
                            <label className="field">
                                <span>透明度</span>
                                <input type="range" min="0" max="1" step="0.01" value={watermarkOpacity} onChange={(event) => setWatermarkOpacity(clamp(toFloat(event.target.value, watermarkOpacity), 0, 1))} />
                                <strong>{Math.round(watermarkOpacity * 100)}%</strong>
                            </label>
                            <label className="field">
                                <span>边距</span>
                                <input type="number" min="0" value={watermarkMargin} onChange={(event) => setWatermarkMargin(Math.max(0, toInteger(event.target.value, watermarkMargin)))} />
                            </label>
                        </section>
                        <section className="panel-section">
                            <h3>位置</h3>
                            <div className="position-grid">
                                {watermarkPositions.map((item) => (
                                    <button key={item.value} type="button" className={item.value === watermarkPosition ? 'position-button active' : 'position-button'} onClick={() => setWatermarkPosition(item.value)}>
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                        </section>
                    </>
                )
            case 'crop':
                return (
                    <section className="panel-section compact-grid">
                        <h3>裁切区域</h3>
                        <label className="field">
                            <span>X</span>
                            <input type="number" min="0" max={sourceAsset ? Math.max(0, sourceAsset.width - 1) : undefined} value={crop.x} onChange={(event) => updateCrop({ x: Math.max(0, toInteger(event.target.value, crop.x)) })} />
                        </label>
                        <label className="field">
                            <span>Y</span>
                            <input type="number" min="0" max={sourceAsset ? Math.max(0, sourceAsset.height - 1) : undefined} value={crop.y} onChange={(event) => updateCrop({ y: Math.max(0, toInteger(event.target.value, crop.y)) })} />
                        </label>
                        <label className="field">
                            <span>宽度</span>
                            <input type="number" min="1" max={sourceAsset ? cropWidthMax : undefined} value={crop.width} onChange={(event) => updateCrop({ width: Math.max(1, toInteger(event.target.value, crop.width)) })} />
                        </label>
                        <label className="field">
                            <span>高度</span>
                            <input type="number" min="1" max={sourceAsset ? cropHeightMax : undefined} value={crop.height} onChange={(event) => updateCrop({ height: Math.max(1, toInteger(event.target.value, crop.height)) })} />
                        </label>
                    </section>
                )
            case 'split':
                return (
                    <section className="panel-section compact-grid">
                        <h3>网格拆分</h3>
                        <label className="field">
                            <span>行数</span>
                            <input type="number" min="1" max={sourceAsset ? splitRowsMax : undefined} value={split.rows} onChange={(event) => updateSplit({ rows: Math.max(1, toInteger(event.target.value, split.rows)) })} />
                        </label>
                        <label className="field">
                            <span>列数</span>
                            <input type="number" min="1" max={sourceAsset ? splitColsMax : undefined} value={split.cols} onChange={(event) => updateSplit({ cols: Math.max(1, toInteger(event.target.value, split.cols)) })} />
                        </label>
                    </section>
                )
        }
    }

    return (
        <div className="app-shell">
            <input ref={sourceInputRef} type="file" accept="image/*" hidden onChange={(event) => void onSourceInputChange(event)} />
            <input ref={overlayInputRef} type="file" accept="image/*" hidden onChange={(event) => void onOverlayInputChange(event)} />

            <aside className="sidebar">
                <div className="brand-block">
                    <span className="brand-mark">TB</span>
                    <div className="brand-copy">
                        <h1>TOOL BOX</h1>
                        <span className="runtime-pill">LOCAL</span>
                    </div>
                </div>

                <div className="sidebar-section">
                    <div className="tool-directory">
                        <button
                            type="button"
                            className={toolDirectoryOpen ? 'directory-button active' : 'directory-button'}
                            onClick={() => setToolDirectoryOpen((current) => !current)}
                        >
                            <span className="directory-meta">
                                <span className="tool-icon">▣</span>
                                <span className="directory-label-group">
                                    <strong className="tool-label">图像工具</strong>
                                    <span className="directory-count">{tools.length} 项</span>
                                </span>
                            </span>
                            <span className="directory-chevron">{toolDirectoryOpen ? '−' : '+'}</span>
                        </button>

                        {toolDirectoryOpen ? (
                            <nav className="tool-list directory-children">
                                {tools.map((tool) => (
                                    <button
                                        key={tool.id}
                                        type="button"
                                        title={tool.summary}
                                        className={tool.id === selectedTool ? 'tool-button active' : 'tool-button'}
                                        onClick={() => {
                                            setSelectedTool(tool.id)
                                            setStatus(tool.summary)
                                        }}
                                    >
                                        <span className="tool-icon">{tool.icon}</span>
                                        <strong className="tool-label">{tool.label}</strong>
                                        <span className="tool-badge">{tool.badge ?? tool.id}</span>
                                    </button>
                                ))}
                            </nav>
                        ) : null}
                    </div>
                </div>

                <div className="sidebar-console">
                    <div className="console-row">
                        <span>STATE</span>
                        <strong>{runtimeState}</strong>
                    </div>
                    <div className="console-row">
                        <span>TOOL</span>
                        <strong>{selectedToolMeta.label}</strong>
                    </div>
                    <div className="console-row">
                        <span>SRC</span>
                        <strong>{sourceSummary}</strong>
                    </div>
                </div>
            </aside>

            <main className="workspace">
                <header className="topbar">
                    <div className="topbar-main">
                        <div className="title-row">
                            <h2>IMAGE OPS</h2>
                            <span className="active-tool-chip">
                                {selectedToolMeta.badge} / {selectedToolMeta.label}
                            </span>
                        </div>
                    </div>
                    <div className="toolbar-actions">
                        <button type="button" className="secondary-button" onClick={() => sourceInputRef.current?.click()}>
                            载入
                        </button>
                    </div>
                </header>

                <section className="signal-rack">
                    <article className="signal-cell">
                        <span>SRC</span>
                        <strong>{sourceSummary}</strong>
                        <small>{assetName}</small>
                    </article>
                    <article className="signal-cell">
                        <span>OUT</span>
                        <strong>{resultSummary}</strong>
                        <small>{formatBytes(result?.bytes)}</small>
                    </article>
                    <article className={`signal-cell ${noticeText ? `signal-${noticeTone}` : ''}`}>
                        <span>LOG</span>
                        <strong>{runtimeState}</strong>
                        <small>{status || noticeText || resultMeta}</small>
                    </article>
                </section>

                <div className="content-grid">
                    <section className="preview-column">
                        <div className="preview-stage" onDragOver={(event) => event.preventDefault()} onDrop={onDropSource}>
                            <article className="preview-card large">
                                <div className="card-header">
                                    <h3>源图预览</h3>
                                    {sourceAsset ? <span className="meta-chip">{sourceAsset.width} × {sourceAsset.height}</span> : null}
                                </div>
                                {sourceAsset ? (
                                    <img src={sourceAsset.dataUrl} alt={sourceAsset.name} className="preview-image" />
                                ) : (
                                    <div className="empty-state">
                                        <strong>DROP IMAGE</strong>
                                        <p>or load from toolbar</p>
                                    </div>
                                )}
                            </article>

                            <article className="preview-card side">
                                <div className="card-header">
                                    <h3>结果预览</h3>
                                    {result?.width && result?.height ? <span className="meta-chip">{result.width} × {result.height}</span> : null}
                                </div>

                                {result?.primaryDataUrl ? (
                                    <img src={result.primaryDataUrl} alt="处理结果" className="preview-image" />
                                ) : result?.splitItems.length ? (
                                    <div className="split-grid">
                                        {result.splitItems.map((item) => (
                                            <button key={item.name} type="button" className="split-tile" onClick={() => downloadDataUrl(item.dataUrl, item.name)}>
                                                <img src={item.dataUrl} alt={item.name} />
                                                <span>{item.name}</span>
                                            </button>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="empty-state subtle">
                                        <strong>OUTPUT</strong>
                                        <p>run current tool</p>
                                    </div>
                                )}
                            </article>
                        </div>
                    </section>

                    <aside className="panel">
                        <header className="panel-header">
                            <div className="panel-title-row">
                                <h3>{selectedToolMeta.label}</h3>
                                <span className="panel-chip">{selectedToolMeta.badge}</span>
                            </div>
                        </header>

                        {noticeText ? <p className={`notice ${noticeTone}`}>{noticeText}</p> : null}

                        {renderToolPanel()}

                        <section className="panel-section panel-actions">
                            <div className="utility-row">
                                <button type="button" className="secondary-button utility-button" onClick={undoSource} disabled={sourceHistory.length < 2}>
                                    回退
                                </button>
                                <button type="button" className="secondary-button utility-button" onClick={() => void exportPrimaryResult()} disabled={!result?.primaryDataUrl}>
                                    导出
                                </button>
                                <button type="button" className="secondary-button utility-button" onClick={promoteResultToSource} disabled={!result?.primaryDataUrl}>
                                    接管
                                </button>
                            </div>
                            <button type="button" className="primary-button block" onClick={() => void runSelectedTool()} disabled={!canExecute}>
                                {busy ? '运行中' : '运行'}
                            </button>
                        </section>
                    </aside>
                </div>
            </main>
        </div>
    )
}

export default App