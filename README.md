# Tool Box

基于 Tauri + React + TypeScript 的桌面图像功能箱，参考“左侧工具导航 + 中间预览工作区 + 右侧参数面板”的工作台结构来实现。

## 已实现工具

- 图片转 Base64
- Base64 转图像
- 轻量画质增强
- 图像压缩与缩放
- 文字/图片水印
- 精确裁切
- 网格分割

## 技术结构

- 前端：React + Vite + TypeScript
- 桌面壳：Tauri
- 后端：Rust + image crate
- 交互方式：前端通过 Tauri invoke 调用统一的 Rust 图像处理命令

## 开发命令

```bash
npm install
npm run tauri:dev
```

仅验证前端构建：

```bash
npm run build
```

仅验证 Rust 后端：

```bash
cd src-tauri
cargo check
```

## 说明

- 当前“画质增强”是本地轻量增强链路，不依赖 ONNX。
- 水印工具采用前端生成文字水印图或导入图片水印图，再由 Rust 后端合成。
- 分割工具当前为规则网格分割，适合作为首版工具箱能力。
