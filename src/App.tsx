import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type PointerEvent } from 'react'
import './App.css'
import { runTool } from './lib/desktop'
import TranslateWorkspace from './workspaces/TranslateWorkspace'
import type {
    CropMode,
    CropPoint,
    ImageAsset,
    ImageFormat,
    ProcessResponse,
    ToolId,
    ToolRequest,
    WatermarkPosition,
    WorkspaceMode,
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

const cropModes: Array<{ value: CropMode; label: string; hint: string }> = [
    { value: 'rectangle', label: '矩形', hint: '适合标准截图和规则边界裁切。' },
    { value: 'ellipse', label: '椭圆', hint: '输出透明边缘，适合头像和圆角素材。' },
    { value: 'polygon', label: '折线', hint: '逐点连线闭合，适合不规则区域。' },
    { value: 'smoothPath', label: '曲线', hint: '逐点生成平滑闭合曲线，更接近弧形裁切。' },
]

type CropHandle = 'nw' | 'ne' | 'se' | 'sw'
type CropAspectMode = 'free' | 'current' | '1:1' | '4:3' | '16:9'

function getCropBoundsFromPoints(points: CropPoint[]) {
    if (points.length < 2) return null

    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const maxX = Math.max(...xs)
    const maxY = Math.max(...ys)

    return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX + 1),
        height: Math.max(1, maxY - minY + 1),
    }
}

function rectPointsFromCrop(rect: { x: number; y: number; width: number; height: number }): CropPoint[] {
    return [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
        { x: rect.x, y: rect.y + rect.height },
    ]
}

function buildSvgPath(points: Array<{ x: number; y: number }>, closed: boolean) {
    if (points.length < 2) return null
    return `${points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')}${closed ? ' Z' : ''}`
}

function catmullRomPoint(
    p0: { x: number; y: number },
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
    t: number,
) {
    const t2 = t * t
    const t3 = t2 * t
    return {
        x:
            0.5 *
            ((2 * p1.x)
                + (-p0.x + p2.x) * t
                + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
                + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
            0.5 *
            ((2 * p1.y)
                + (-p0.y + p2.y) * t
                + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
                + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    }
}

function sampleSmoothPath(points: Array<{ x: number; y: number }>, closed: boolean, steps = 14) {
    if (points.length < 3) return points

    if (closed) {
        const sampled: Array<{ x: number; y: number }> = []
        for (let index = 0; index < points.length; index += 1) {
            const p0 = points[(index + points.length - 1) % points.length]
            const p1 = points[index]
            const p2 = points[(index + 1) % points.length]
            const p3 = points[(index + 2) % points.length]
            for (let step = 0; step < steps; step += 1) {
                sampled.push(catmullRomPoint(p0, p1, p2, p3, step / steps))
            }
        }
        return sampled
    }

    const sampled: Array<{ x: number; y: number }> = []
    for (let index = 0; index < points.length - 1; index += 1) {
        const p0 = points[Math.max(0, index - 1)]
        const p1 = points[index]
        const p2 = points[index + 1]
        const p3 = points[Math.min(points.length - 1, index + 2)]
        for (let step = 0; step < steps; step += 1) {
            sampled.push(catmullRomPoint(p0, p1, p2, p3, step / steps))
        }
    }
    sampled.push(points[points.length - 1])

    return sampled
}

function getAspectRatioValue(mode: CropAspectMode, rect: { width: number; height: number }) {
    if (mode === 'free') return null
    if (mode === 'current') {
        return rect.height > 0 ? rect.width / rect.height : null
    }
    if (mode === '1:1') return 1
    if (mode === '4:3') return 4 / 3
    return 16 / 9
}

function applyAspectToPoint(anchor: CropPoint, point: CropPoint, aspectRatio: number | null): CropPoint {
    if (!aspectRatio) return point

    const deltaX = point.x - anchor.x
    const deltaY = point.y - anchor.y
    if (deltaX === 0 && deltaY === 0) return point

    const signX = deltaX >= 0 ? 1 : -1
    const signY = deltaY >= 0 ? 1 : -1
    let width = Math.abs(deltaX)
    let height = Math.abs(deltaY)

    if (width === 0) {
        width = height * aspectRatio
    }
    if (height === 0) {
        height = width / aspectRatio
    }

    if (width / height > aspectRatio) {
        width = height * aspectRatio
    } else {
        height = width / aspectRatio
    }

    return {
        x: Math.round(anchor.x + signX * width),
        y: Math.round(anchor.y + signY * height),
    }
}

function cropRectFromPoints(anchor: CropPoint, point: CropPoint, aspectRatio: number | null) {
    const nextPoint = applyAspectToPoint(anchor, point, aspectRatio)
    return {
        x: Math.round(Math.min(anchor.x, nextPoint.x)),
        y: Math.round(Math.min(anchor.y, nextPoint.y)),
        width: Math.max(1, Math.round(Math.abs(nextPoint.x - anchor.x))),
        height: Math.max(1, Math.round(Math.abs(nextPoint.y - anchor.y))),
    }
}

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

function fitContainedRect(frameWidth: number, frameHeight: number, imageWidth: number, imageHeight: number) {
    if (frameWidth <= 0 || frameHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
        return null
    }

    const scale = Math.min(frameWidth / imageWidth, frameHeight / imageHeight)
    const width = imageWidth * scale
    const height = imageHeight * scale

    return {
        left: (frameWidth - width) / 2,
        top: (frameHeight - height) / 2,
        width,
        height,
    }
}

function App() {
    const sourceInputRef = useRef<HTMLInputElement | null>(null)
    const overlayInputRef = useRef<HTMLInputElement | null>(null)
    const cropPreviewFrameRef = useRef<HTMLDivElement | null>(null)
    const cropDragStateRef = useRef<
        | {
            kind: 'draw-shape'
            pointerId: number
            anchor: CropPoint
        }
        | {
            kind: 'move-point'
            pointerId: number
            index: number
        }
        | {
            kind: 'resize-handle'
            pointerId: number
            handle: CropHandle
            anchor: CropPoint
        }
        | null
    >(null)

    const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('image')
    const [toolDirectoryOpen, setToolDirectoryOpen] = useState(true)
    const [selectedTool, setSelectedTool] = useState<ToolId>('base64Encode')
    const [sourceAsset, setSourceAsset] = useState<ImageAsset | null>(null)
    const [sourceHistory, setSourceHistory] = useState<ImageAsset[]>([])
    const [result, setResult] = useState<ProcessResponse | null>(null)
    const [comparePosition, setComparePosition] = useState(52)
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
    const [cropMode, setCropMode] = useState<CropMode>('rectangle')
    const [cropPoints, setCropPoints] = useState<CropPoint[]>([])
    const [cropPathClosed, setCropPathClosed] = useState(true)
    const [selectedCropPointIndex, setSelectedCropPointIndex] = useState<number | null>(null)
    const [cropAspectMode, setCropAspectMode] = useState<CropAspectMode>('free')
    const [split, setSplit] = useState({ rows: 2, cols: 2 })
    const [cropPreviewFrameSize, setCropPreviewFrameSize] = useState({ width: 0, height: 0 })

    const selectedToolMeta = tools.find((tool) => tool.id === selectedTool)!

    const cropWidthMax = sourceAsset ? Math.max(1, sourceAsset.width - crop.x) : 1
    const cropHeightMax = sourceAsset ? Math.max(1, sourceAsset.height - crop.y) : 1
    const splitRowsMax = sourceAsset ? Math.max(1, sourceAsset.height) : 1
    const splitColsMax = sourceAsset ? Math.max(1, sourceAsset.width) : 1
    const cropPreviewRect = sourceAsset
        ? fitContainedRect(cropPreviewFrameSize.width, cropPreviewFrameSize.height, sourceAsset.width, sourceAsset.height)
        : null
    const cropAspectRatio = getAspectRatioValue(cropAspectMode, crop)
    const freeformBounds = getCropBoundsFromPoints(cropPoints)
    const freeformMode = cropMode === 'polygon' || cropMode === 'smoothPath'
    const activeCropBounds = freeformMode && freeformBounds ? freeformBounds : crop
    const cropPreviewPoints = sourceAsset && cropPreviewRect
        ? cropPoints.map((point) => ({
            x: cropPreviewRect.left + (point.x / sourceAsset.width) * cropPreviewRect.width,
            y: cropPreviewRect.top + (point.y / sourceAsset.height) * cropPreviewRect.height,
        }))
        : []
    const cropOutlinePoints = cropMode === 'smoothPath' ? sampleSmoothPath(cropPreviewPoints, cropPathClosed) : cropPreviewPoints
    const cropSegmentButtons = freeformMode
        ? cropPreviewPoints.flatMap((point, index) => {
            if (cropPreviewPoints.length < 2 || (!cropPathClosed && index === cropPreviewPoints.length - 1)) {
                return []
            }

            const nextIndex = index === cropPreviewPoints.length - 1 ? 0 : index + 1
            const nextPoint = cropPreviewPoints[nextIndex]
            return [{
                key: `${index}-${nextIndex}`,
                index,
                x: (point.x + nextPoint.x) / 2,
                y: (point.y + nextPoint.y) / 2,
            }]
        })
        : []
    const cropOutlinePath = cropPreviewRect
        ? freeformMode
            ? buildSvgPath(cropOutlinePoints, cropPathClosed)
            : cropMode === 'ellipse'
                ? (() => {
                    const left = cropPreviewRect.left + (crop.x / sourceAsset!.width) * cropPreviewRect.width
                    const top = cropPreviewRect.top + (crop.y / sourceAsset!.height) * cropPreviewRect.height
                    const width = (crop.width / sourceAsset!.width) * cropPreviewRect.width
                    const height = (crop.height / sourceAsset!.height) * cropPreviewRect.height
                    const centerX = left + width / 2
                    const centerY = top + height / 2
                    const radiusX = width / 2
                    const radiusY = height / 2
                    return `M ${centerX - radiusX} ${centerY} A ${radiusX} ${radiusY} 0 1 0 ${centerX + radiusX} ${centerY} A ${radiusX} ${radiusY} 0 1 0 ${centerX - radiusX} ${centerY} Z`
                })()
                : (() => {
                    const left = cropPreviewRect.left + (crop.x / sourceAsset!.width) * cropPreviewRect.width
                    const top = cropPreviewRect.top + (crop.y / sourceAsset!.height) * cropPreviewRect.height
                    const width = (crop.width / sourceAsset!.width) * cropPreviewRect.width
                    const height = (crop.height / sourceAsset!.height) * cropPreviewRect.height
                    return `M ${left} ${top} H ${left + width} V ${top + height} H ${left} Z`
                })()
        : null
    const cropOutlineLabel = freeformMode
        ? `${cropPoints.length} 点 / ${activeCropBounds.width} × ${activeCropBounds.height}`
        : `${crop.width} × ${crop.height}`
    const cropPathStateLabel = freeformMode ? (cropPathClosed ? '闭合' : '开放') : null

    useEffect(() => {
        const element = cropPreviewFrameRef.current
        if (!element) return

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0]
            if (!entry) return
            setCropPreviewFrameSize({
                width: entry.contentRect.width,
                height: entry.contentRect.height,
            })
        })

        observer.observe(element)
        const rect = element.getBoundingClientRect()
        setCropPreviewFrameSize({ width: rect.width, height: rect.height })

        return () => observer.disconnect()
    }, [selectedTool, workspaceMode, sourceAsset?.dataUrl])

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
        setCropPoints([])
        setCropPathClosed(true)
        setSelectedCropPointIndex(null)
        setSplit({ rows: safeRows, cols: safeCols })
        setResult(null)
        setComparePosition(52)
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

    function clampCropPoint(point: CropPoint, allowEdge = false) {
        if (!sourceAsset) return point
        return {
            x: Math.round(clamp(point.x, 0, Math.max(0, sourceAsset.width - (allowEdge ? 0 : 1)))),
            y: Math.round(clamp(point.y, 0, Math.max(0, sourceAsset.height - (allowEdge ? 0 : 1)))),
        }
    }

    function applyCropMode(nextMode: CropMode) {
        setCropMode(nextMode)
        setSelectedCropPointIndex(null)
        if ((nextMode === 'polygon' || nextMode === 'smoothPath') && cropPoints.length < 3) {
            setCropPoints(rectPointsFromCrop(crop).map((point) => clampCropPoint(point)))
            setCropPathClosed(true)
        }
        if ((nextMode === 'rectangle' || nextMode === 'ellipse') && freeformBounds) {
            updateCrop(freeformBounds)
        }
    }

    function resetFreeformToRect() {
        setCropPoints(rectPointsFromCrop(crop).map((point) => clampCropPoint(point)))
        setCropPathClosed(true)
        setSelectedCropPointIndex(null)
    }

    function clearFreeformPoints() {
        setCropPoints([])
        setCropPathClosed(false)
        setSelectedCropPointIndex(null)
    }

    function insertCropPointAfter(index: number) {
        let insertedIndex: number | null = null

        setCropPoints((current) => {
            if (current.length < 2) return current
            if (!cropPathClosed && index >= current.length - 1) return current

            const nextIndex = index === current.length - 1 ? 0 : index + 1
            const midpoint = clampCropPoint({
                x: Math.round((current[index].x + current[nextIndex].x) / 2),
                y: Math.round((current[index].y + current[nextIndex].y) / 2),
            })
            insertedIndex = index + 1

            const next = [...current]
            next.splice(index + 1, 0, midpoint)
            return next
        })

        if (insertedIndex !== null) {
            setSelectedCropPointIndex(insertedIndex)
        }
    }

    function insertPointAfterSelected() {
        if (selectedCropPointIndex === null) return
        insertCropPointAfter(selectedCropPointIndex)
    }

    function deleteSelectedCropPoint() {
        if (selectedCropPointIndex === null) return

        let nextLength = 0
        setCropPoints((current) => {
            if (selectedCropPointIndex >= current.length) return current

            const next = current.filter((_, index) => index !== selectedCropPointIndex)
            nextLength = next.length
            return next
        })

        setSelectedCropPointIndex(null)
        if (nextLength < 3) {
            setCropPathClosed(false)
        }
    }

    function toggleCropPathClosed() {
        setCropPathClosed((current) => !current)
    }

    function applyCropPreset(preset: 'full' | 'square' | '4:3' | '16:9') {
        if (!sourceAsset) return

        if (preset === 'full') {
            updateCrop({ x: 0, y: 0, width: sourceAsset.width, height: sourceAsset.height })
            return
        }

        const aspect = preset === 'square' ? 1 : preset === '4:3' ? 4 / 3 : 16 / 9
        let nextWidth = sourceAsset.width
        let nextHeight = Math.round(nextWidth / aspect)

        if (nextHeight > sourceAsset.height) {
            nextHeight = sourceAsset.height
            nextWidth = Math.round(nextHeight * aspect)
        }

        updateCrop({
            x: Math.max(0, Math.floor((sourceAsset.width - nextWidth) / 2)),
            y: Math.max(0, Math.floor((sourceAsset.height - nextHeight) / 2)),
            width: Math.max(1, nextWidth),
            height: Math.max(1, nextHeight),
        })
    }

    function getCropPointFromPointer(clientX: number, clientY: number) {
        if (!sourceAsset || !cropPreviewRect || !cropPreviewFrameRef.current) return null

        const frameBounds = cropPreviewFrameRef.current.getBoundingClientRect()
        const relativeX = clientX - frameBounds.left
        const relativeY = clientY - frameBounds.top

        const clampedX = clamp(relativeX, cropPreviewRect.left, cropPreviewRect.left + cropPreviewRect.width)
        const clampedY = clamp(relativeY, cropPreviewRect.top, cropPreviewRect.top + cropPreviewRect.height)

        return {
            x: Math.round(((clampedX - cropPreviewRect.left) / cropPreviewRect.width) * sourceAsset.width),
            y: Math.round(((clampedY - cropPreviewRect.top) / cropPreviewRect.height) * sourceAsset.height),
        }
    }

    function handleCropPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (selectedTool !== 'crop' || !sourceAsset) return

        const point = getCropPointFromPointer(event.clientX, event.clientY)
        if (!point) return

        const previewFrame = cropPreviewFrameRef.current
        if (!previewFrame) return

        if (freeformMode) {
            const nextPoint = clampCropPoint(point)
            let nextIndex = cropPoints.length
            setCropPoints((current) => {
                nextIndex = current.length
                return [...current, nextPoint]
            })
            setSelectedCropPointIndex(nextIndex)
            cropDragStateRef.current = {
                kind: 'move-point',
                pointerId: event.pointerId,
                index: nextIndex,
            }
            previewFrame.setPointerCapture(event.pointerId)
            return
        }

        cropDragStateRef.current = {
            kind: 'draw-shape',
            pointerId: event.pointerId,
            anchor: clampCropPoint(point, true),
        }
        previewFrame.setPointerCapture(event.pointerId)
    }

    function handleCropPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (selectedTool !== 'crop' || !sourceAsset) return
        const dragState = cropDragStateRef.current
        if (!dragState || dragState.pointerId !== event.pointerId) return

        const point = getCropPointFromPointer(event.clientX, event.clientY)
        if (!point) return

        if (dragState.kind === 'move-point') {
            const nextPoint = clampCropPoint(point)
            setCropPoints((current) => current.map((item, index) => (index === dragState.index ? nextPoint : item)))
            setSelectedCropPointIndex(dragState.index)
            return
        }

        const nextRect = cropRectFromPoints(
            dragState.anchor,
            clampCropPoint(point, true),
            cropAspectRatio,
        )
        updateCrop(nextRect)
    }

    function handleCropPointerUp(event: PointerEvent<HTMLDivElement>) {
        const dragState = cropDragStateRef.current
        if (!dragState || dragState.pointerId !== event.pointerId) return

        cropDragStateRef.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
        }
    }

    function handleCropPointPointerDown(index: number, event: PointerEvent<HTMLButtonElement>) {
        if (!cropPreviewFrameRef.current) return

        event.stopPropagation()
        setSelectedCropPointIndex(index)
        cropDragStateRef.current = {
            kind: 'move-point',
            pointerId: event.pointerId,
            index,
        }
        cropPreviewFrameRef.current.setPointerCapture(event.pointerId)
    }

    function handleCropHandlePointerDown(handle: CropHandle, event: PointerEvent<HTMLButtonElement>) {
        if (!cropPreviewFrameRef.current) return

        event.stopPropagation()

        const anchors: Record<CropHandle, CropPoint> = {
            nw: { x: crop.x + crop.width, y: crop.y + crop.height },
            ne: { x: crop.x, y: crop.y + crop.height },
            se: { x: crop.x, y: crop.y },
            sw: { x: crop.x + crop.width, y: crop.y },
        }

        cropDragStateRef.current = {
            kind: 'resize-handle',
            pointerId: event.pointerId,
            handle,
            anchor: anchors[handle],
        }
        cropPreviewFrameRef.current.setPointerCapture(event.pointerId)
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
        setCropPoints([])
        setCropPathClosed(true)
        setSelectedCropPointIndex(null)
        setSplit({ rows: clamp(2, 1, previous.height), cols: clamp(2, 1, previous.width) })
        setResult(null)
        setComparePosition(52)
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
                if (freeformMode && cropPoints.length < 3) return '自由裁切至少需要 3 个锚点。'
                if (freeformMode && !cropPathClosed) return '自由裁切路径尚未闭合，请先闭合后再运行。'
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
                if (!sourceAsset) return '加载图片后可按像素精确裁切。'
                if (freeformMode) {
                    if (!cropPathClosed) {
                        return '当前是开放路径，可以继续加点和插点；运行前需要先闭合路径。'
                    }
                    return cropMode === 'smoothPath'
                        ? '点击增加锚点，拖动锚点塑形，运行时会生成平滑闭合曲线并输出透明背景 PNG。'
                        : '点击增加锚点，拖动锚点微调，运行时会自动闭合折线路径并输出透明背景 PNG。'
                }
                return `当前图像 ${sourceAsset.width} × ${sourceAsset.height}，裁切宽度最多 ${cropWidthMax}，高度最多 ${cropHeightMax}。`
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
    const hasComparablePreview = Boolean(sourceAsset && result?.primaryDataUrl)
    const activePreviewLabel = selectedTool === 'crop'
        ? '裁切编辑'
        : hasComparablePreview
            ? '拖拽对比'
            : result?.primaryDataUrl || result?.splitItems.length
            ? '结果预览'
            : '图像预览'
    const activePreviewMeta = selectedTool === 'crop'
        ? `${cropModes.find((item) => item.value === cropMode)?.label ?? '裁切'}${cropPathStateLabel ? ` / ${cropPathStateLabel}` : ''} / ${cropOutlineLabel}`
        : hasComparablePreview
            ? `${comparePosition}% / ${100 - comparePosition}%`
            : result?.primaryDataUrl
            ? result?.width && result?.height
                ? `${result.width} × ${result.height}`
                : null
            : result?.splitItems.length
                ? `${result.splitItems.length} 项`
                : sourceAsset
                    ? `${sourceAsset.width} × ${sourceAsset.height}`
                    : null

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
                    x: Math.max(0, Math.trunc(activeCropBounds.x)),
                    y: Math.max(0, Math.trunc(activeCropBounds.y)),
                    width: Math.max(1, Math.trunc(activeCropBounds.width)),
                    height: Math.max(1, Math.trunc(activeCropBounds.height)),
                    mode: cropMode,
                    points: freeformMode
                        ? cropPoints.map((point) => ({ x: Math.trunc(point.x), y: Math.trunc(point.y) }))
                        : [],
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
                        <div className="crop-mode-grid">
                            {cropModes.map((mode) => (
                                <button key={mode.value} type="button" className={cropMode === mode.value ? 'mode-button active' : 'mode-button'} onClick={() => applyCropMode(mode.value)}>
                                    {mode.label}
                                </button>
                            ))}
                        </div>
                        <p className="crop-helper-text">{cropModes.find((item) => item.value === cropMode)?.hint}</p>
                        {!freeformMode ? (
                            <label className="field crop-aspect-field">
                                <span>锁定比例</span>
                                <select value={cropAspectMode} onChange={(event) => setCropAspectMode(event.target.value as CropAspectMode)}>
                                    <option value="free">自由</option>
                                    <option value="current">当前比例</option>
                                    <option value="1:1">1:1</option>
                                    <option value="4:3">4:3</option>
                                    <option value="16:9">16:9</option>
                                </select>
                            </label>
                        ) : null}
                        <div className="crop-preset-row">
                            <button type="button" className="secondary-button utility-button" onClick={() => applyCropPreset('full')} disabled={!sourceAsset}>
                                整图
                            </button>
                            <button type="button" className="secondary-button utility-button" onClick={() => applyCropPreset('square')} disabled={!sourceAsset}>
                                1:1
                            </button>
                            <button type="button" className="secondary-button utility-button" onClick={() => applyCropPreset('4:3')} disabled={!sourceAsset}>
                                4:3
                            </button>
                            <button type="button" className="secondary-button utility-button" onClick={() => applyCropPreset('16:9')} disabled={!sourceAsset}>
                                16:9
                            </button>
                        </div>
                        {freeformMode ? (
                            <>
                                <div className="crop-freeform-actions">
                                    <button type="button" className={cropPathClosed ? 'mode-button active' : 'mode-button'} onClick={toggleCropPathClosed} disabled={cropPoints.length < 2}>
                                        {cropPathClosed ? '打开路径' : '闭合路径'}
                                    </button>
                                    <button type="button" className="secondary-button utility-button" onClick={insertPointAfterSelected} disabled={selectedCropPointIndex === null || (!cropPathClosed && selectedCropPointIndex === cropPoints.length - 1)}>
                                        在选中点后插入
                                    </button>
                                    <button type="button" className="secondary-button utility-button" onClick={deleteSelectedCropPoint} disabled={selectedCropPointIndex === null}>
                                        删除选中点
                                    </button>
                                    <button type="button" className="secondary-button utility-button" onClick={resetFreeformToRect} disabled={!sourceAsset}>
                                        以当前框建轮廓
                                    </button>
                                    <button type="button" className="secondary-button utility-button" onClick={clearFreeformPoints} disabled={!cropPoints.length}>
                                        清空锚点
                                    </button>
                                </div>
                                <div className="crop-freeform-summary">
                                    <span>路径 {cropPathClosed ? '闭合' : '开放'}</span>
                                    <span>锚点 {cropPoints.length}</span>
                                    <span>选中 {selectedCropPointIndex === null ? '无' : selectedCropPointIndex + 1}</span>
                                    <span>边界 X {activeCropBounds.x}</span>
                                    <span>边界 Y {activeCropBounds.y}</span>
                                    <span>{activeCropBounds.width} × {activeCropBounds.height}</span>
                                </div>
                            </>
                        ) : (
                            <>
                                <p className="crop-helper-text">可以直接在左侧预览图上拖拽选区，四角拖拽手柄可二次微调。</p>
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
                            </>
                        )}
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

                <div className="workspace-switch">
                    <button
                        type="button"
                        className={workspaceMode === 'image' ? 'workspace-switch-button active' : 'workspace-switch-button'}
                        onClick={() => setWorkspaceMode('image')}
                    >
                        图像工具箱
                    </button>
                    <button
                        type="button"
                        className={workspaceMode === 'translate' ? 'workspace-switch-button active' : 'workspace-switch-button'}
                        onClick={() => setWorkspaceMode('translate')}
                    >
                        离线翻译
                    </button>
                </div>

                <div className="sidebar-section">
                    {workspaceMode === 'image' ? (
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
                    ) : (
                        <div className="translate-sidebar-stack">
                            <article className="sidebar-note-card">
                                <span className="tool-icon">字</span>
                                <div className="sidebar-note-copy">
                                    <strong>中英互译</strong>
                                    <p>面向单词和短语，优先离线词典与短语表。</p>
                                </div>
                            </article>
                            <article className="sidebar-note-card">
                                <span className="tool-icon">离</span>
                                <div className="sidebar-note-copy">
                                    <strong>本地直用</strong>
                                    <p>无额外模型进程，查询命令直接由 Rust 词典服务处理。</p>
                                </div>
                            </article>
                            <article className="sidebar-note-card">
                                <span className="tool-icon">藏</span>
                                <div className="sidebar-note-copy">
                                    <strong>收藏与历史</strong>
                                    <p>结果支持收藏、回放和本地设置持久化。</p>
                                </div>
                            </article>
                        </div>
                    )}
                </div>

                <div className="sidebar-console">
                    <div className="console-row">
                        <span>STATE</span>
                        <strong>{workspaceMode === 'image' ? runtimeState : 'LEXICON'}</strong>
                    </div>
                    <div className="console-row">
                        <span>{workspaceMode === 'image' ? 'TOOL' : 'MODE'}</span>
                        <strong>{workspaceMode === 'image' ? selectedToolMeta.label : '离线翻译'}</strong>
                    </div>
                    <div className="console-row">
                        <span>{workspaceMode === 'image' ? 'SRC' : 'SCOPE'}</span>
                        <strong>{workspaceMode === 'image' ? sourceSummary : '词语 / 短语'}</strong>
                    </div>
                </div>
            </aside>

            {workspaceMode === 'image' ? (
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
                            <div className="preview-stage single" onDragOver={(event) => event.preventDefault()} onDrop={onDropSource}>
                                <article className="preview-card large single-preview-card">
                                    <div className="card-header">
                                        <h3>{activePreviewLabel}</h3>
                                        {activePreviewMeta ? <span className="meta-chip">{activePreviewMeta}</span> : null}
                                    </div>
                                    {selectedTool === 'crop' && sourceAsset && cropPreviewRect ? (
                                        <div
                                            ref={cropPreviewFrameRef}
                                            className="crop-preview-shell"
                                            onPointerDown={handleCropPointerDown}
                                            onPointerMove={handleCropPointerMove}
                                            onPointerUp={handleCropPointerUp}
                                            onPointerCancel={handleCropPointerUp}
                                        >
                                            <img src={sourceAsset.dataUrl} alt={sourceAsset.name} className="preview-image crop-preview-image" />
                                            {cropOutlinePath ? (
                                                <svg className="crop-vector-overlay" viewBox={`0 0 ${cropPreviewFrameSize.width} ${cropPreviewFrameSize.height}`} preserveAspectRatio="none">
                                                    {freeformMode ? (
                                                        cropPathClosed ? (
                                                            <path
                                                                d={`M 0 0 H ${cropPreviewFrameSize.width} V ${cropPreviewFrameSize.height} H 0 Z ${cropOutlinePath}`}
                                                                className="crop-overlay-fill"
                                                                fillRule="evenodd"
                                                            />
                                                        ) : null
                                                    ) : (
                                                        <path
                                                            d={`M 0 0 H ${cropPreviewFrameSize.width} V ${cropPreviewFrameSize.height} H 0 Z ${cropOutlinePath}`}
                                                            className="crop-overlay-fill"
                                                            fillRule="evenodd"
                                                        />
                                                    )}
                                                    <path d={cropOutlinePath} className={cropMode === 'ellipse' ? 'crop-outline ellipse' : 'crop-outline'} />
                                                </svg>
                                            ) : null}
                                            {!freeformMode ? (
                                                <div
                                                    className={cropMode === 'ellipse' ? 'crop-selection-box ellipse' : 'crop-selection-box'}
                                                    style={{
                                                        left: cropPreviewRect.left + (crop.x / sourceAsset.width) * cropPreviewRect.width,
                                                        top: cropPreviewRect.top + (crop.y / sourceAsset.height) * cropPreviewRect.height,
                                                        width: (crop.width / sourceAsset.width) * cropPreviewRect.width,
                                                        height: (crop.height / sourceAsset.height) * cropPreviewRect.height,
                                                    }}
                                                >
                                                    <div className="crop-selection-label">{cropOutlineLabel}</div>
                                                    <button type="button" aria-label="调整左上角" className="crop-handle crop-handle-nw" onPointerDown={(event) => handleCropHandlePointerDown('nw', event)} />
                                                    <button type="button" aria-label="调整右上角" className="crop-handle crop-handle-ne" onPointerDown={(event) => handleCropHandlePointerDown('ne', event)} />
                                                    <button type="button" aria-label="调整右下角" className="crop-handle crop-handle-se" onPointerDown={(event) => handleCropHandlePointerDown('se', event)} />
                                                    <button type="button" aria-label="调整左下角" className="crop-handle crop-handle-sw" onPointerDown={(event) => handleCropHandlePointerDown('sw', event)} />
                                                </div>
                                            ) : (
                                                <>
                                                    {cropSegmentButtons.map((segment) => (
                                                        <button
                                                            key={segment.key}
                                                            type="button"
                                                            className="crop-segment-button"
                                                            style={{ left: segment.x, top: segment.y }}
                                                            onPointerDown={(event) => {
                                                                event.stopPropagation()
                                                                insertCropPointAfter(segment.index)
                                                            }}
                                                        >
                                                            +
                                                        </button>
                                                    ))}
                                                    {cropPreviewPoints.map((point, index) => (
                                                        <button
                                                            key={`${point.x}-${point.y}-${index}`}
                                                            type="button"
                                                            className={selectedCropPointIndex === index ? 'crop-anchor-dot active' : 'crop-anchor-dot'}
                                                            style={{ left: point.x, top: point.y }}
                                                            onPointerDown={(event) => handleCropPointPointerDown(index, event)}
                                                        >
                                                            <span>{index + 1}</span>
                                                        </button>
                                                    ))}
                                                    {freeformBounds ? (
                                                        <div
                                                            className="crop-floating-badge"
                                                            style={{
                                                                left: cropPreviewRect.left + (freeformBounds.x / sourceAsset.width) * cropPreviewRect.width,
                                                                top: cropPreviewRect.top + (freeformBounds.y / sourceAsset.height) * cropPreviewRect.height,
                                                            }}
                                                        >
                                                            {cropOutlineLabel}
                                                        </div>
                                                    ) : null}
                                                </>
                                            )}
                                        </div>
                                    ) : hasComparablePreview && sourceAsset && result?.primaryDataUrl ? (
                                        <div className="compare-preview-shell">
                                            <div className="compare-preview-frame">
                                                <img src={sourceAsset.dataUrl} alt={sourceAsset.name} className="preview-image compare-base-image" />
                                                <div className="compare-overlay" style={{ width: `${comparePosition}%` }}>
                                                    <img src={result.primaryDataUrl} alt="处理结果" className="preview-image compare-result-image" />
                                                </div>
                                                <div className="compare-divider" style={{ left: `${comparePosition}%` }}>
                                                    <span className="compare-divider-handle">↔</span>
                                                </div>
                                            </div>
                                            <label className="compare-slider-row">
                                                <span>原图</span>
                                                <input
                                                    type="range"
                                                    min="0"
                                                    max="100"
                                                    value={comparePosition}
                                                    onChange={(event) => setComparePosition(Number(event.target.value))}
                                                />
                                                <span>结果</span>
                                            </label>
                                        </div>
                                    ) : result?.primaryDataUrl ? (
                                        <img src={result.primaryDataUrl} alt="处理结果" className="preview-image" />
                                    ) : result?.splitItems.length ? (
                                        <div className="split-grid single-preview-grid">
                                            {result.splitItems.map((item) => (
                                                <button key={item.name} type="button" className="split-tile" onClick={() => downloadDataUrl(item.dataUrl, item.name)}>
                                                    <img src={item.dataUrl} alt={item.name} />
                                                    <span>{item.name}</span>
                                                </button>
                                            ))}
                                        </div>
                                    ) : sourceAsset ? (
                                        <img src={sourceAsset.dataUrl} alt={sourceAsset.name} className="preview-image" />
                                    ) : (
                                        <div className="empty-state">
                                            <strong>DROP IMAGE</strong>
                                            <p>or load from toolbar</p>
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
            ) : (
                <TranslateWorkspace />
            )}
        </div>
    )
}

export default App