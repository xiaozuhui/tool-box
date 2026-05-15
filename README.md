# Tool Box

基于 Tauri + React + TypeScript 的本地桌面工具箱。当前包含两个并列工作区：图像工具箱，以及面向中英单词/短语查询的离线翻译工作台。

## 已实现工具

- 图片转 Base64
- Base64 转图像
- 轻量画质增强
- 图像压缩与缩放
- 文字/图片水印
- 精确裁切
- 网格分割

## 已实现翻译能力

- 中译英、英译中
- 单词与短语查询
- 自动识别输入语言
- 短语优先、单词回退
- 模糊匹配与英文词形回退
- 收藏、历史、本地设置
- 完全离线运行，无额外模型进程

## 技术结构

- 前端：React + Vite + TypeScript
- 桌面壳：Tauri
- 后端：Rust + image crate
- 离线翻译：Rust + SQLite（应用启动时由内置种子词库初始化本地数据库）
- 交互方式：前端通过 Tauri invoke 调用图像处理命令和离线词典命令

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

运行后端测试：

```bash
cd src-tauri
cargo test
```

重建离线词典资源：

```bash
npm run dictionary:build
```

## 说明

- 当前“画质增强”是本地轻量增强链路，不依赖 ONNX。
- 水印工具采用前端生成文字水印图或导入图片水印图，再由 Rust 后端合成。
- 分割工具当前为规则网格分割，适合作为首版工具箱能力。
- 离线翻译工作台当前内置一套可扩展的默认词库，词条覆盖范围取决于种子数据；词典引擎、收藏、历史和设置能力已经完整接入。
- 本地词典数据库保存在应用数据目录中，首次启动会从内置种子词库初始化，无需单独下载或启动额外服务。
- 词典源目录位于 dictionary-src；可以通过 manifest 和扩展数据包组合生成 src-tauri/resources/dictionary_seed.json。
- 当前查询结果会返回排序理由、建议表达、别名和构建元信息，便于继续扩展正式词典包和工作台体验。
