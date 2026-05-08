use std::io::Cursor;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
enum ToolError {
    #[error("无效的 Base64 输入")]
    InvalidBase64,
    #[error("请求参数无效: {0}")]
    InvalidInput(String),
    #[error("图像处理失败: {0}")]
    Image(#[from] image::ImageError),
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OutputFormat {
    Png,
    Jpeg,
    Webp,
}

impl OutputFormat {
    fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Png => "PNG",
            Self::Jpeg => "JPEG",
            Self::Webp => "WebP",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum WatermarkPosition {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

impl WatermarkPosition {
    fn label(self) -> &'static str {
        match self {
            Self::TopLeft => "topLeft",
            Self::TopCenter => "topCenter",
            Self::TopRight => "topRight",
            Self::CenterLeft => "centerLeft",
            Self::Center => "center",
            Self::CenterRight => "centerRight",
            Self::BottomLeft => "bottomLeft",
            Self::BottomCenter => "bottomCenter",
            Self::BottomRight => "bottomRight",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ToolRequest {
    Base64Encode {
        #[serde(rename = "sourceDataUrl")]
        source_data_url: String,
        #[serde(rename = "outputFormat")]
        output_format: OutputFormat,
    },
    Base64Decode {
        #[serde(rename = "base64Input")]
        base64_input: String,
        #[serde(rename = "outputFormat")]
        output_format: Option<OutputFormat>,
    },
    Enhance {
        #[serde(rename = "sourceDataUrl")]
        source_data_url: String,
        contrast: f32,
        brighten: i32,
        sharpen: f32,
        saturation: f32,
    },
    Compress {
        #[serde(rename = "sourceDataUrl")]
        source_data_url: String,
        #[serde(rename = "outputFormat")]
        output_format: OutputFormat,
        quality: u8,
        #[serde(rename = "maxWidth")]
        max_width: Option<u32>,
    },
    Watermark {
        #[serde(rename = "sourceDataUrl")]
        source_data_url: String,
        #[serde(rename = "overlayDataUrl")]
        overlay_data_url: String,
        position: WatermarkPosition,
        opacity: f32,
        #[serde(rename = "scalePercent")]
        scale_percent: u32,
        margin: u32,
    },
    Crop {
        #[serde(rename = "sourceDataUrl")]
        source_data_url: String,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    Split {
        #[serde(rename = "sourceDataUrl")]
        source_data_url: String,
        rows: u32,
        cols: u32,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitItem {
    name: String,
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessResponse {
    primary_data_url: Option<String>,
    primary_text: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    bytes: usize,
    mime_type: Option<String>,
    notes: Vec<String>,
    split_items: Vec<SplitItem>,
}

#[tauri::command]
fn process_tool(request: ToolRequest) -> Result<ProcessResponse, String> {
    handle_request(request).map_err(|error| error.to_string())
}

fn handle_request(request: ToolRequest) -> Result<ProcessResponse, ToolError> {
    match request {
        ToolRequest::Base64Encode {
            source_data_url,
            output_format,
        } => {
            let image = load_image_from_data_url(&source_data_url)?;
            let (bytes, mime_type) = encode_image(&image, output_format, 92)?;
            let (width, height) = image.dimensions();
            let data_url = to_data_url(&mime_type, &bytes);
            Ok(ProcessResponse {
                primary_data_url: Some(data_url.clone()),
                primary_text: Some(data_url),
                width: Some(width),
                height: Some(height),
                bytes: bytes.len(),
                mime_type: Some(mime_type.clone()),
                notes: vec![format!("已编码为 {} Data URL", output_format.label())],
                split_items: vec![],
            })
        }
        ToolRequest::Base64Decode {
            base64_input,
            output_format,
        } => {
            let bytes = decode_base64_payload(&base64_input)?;
            let image = image::load_from_memory(&bytes)?;
            let format = output_format.unwrap_or_else(|| detect_format(&bytes));
            let (encoded_bytes, mime_type) = encode_image(&image, format, 92)?;
            let (width, height) = image.dimensions();
            Ok(ProcessResponse {
                primary_data_url: Some(to_data_url(&mime_type, &encoded_bytes)),
                primary_text: None,
                width: Some(width),
                height: Some(height),
                bytes: encoded_bytes.len(),
                mime_type: Some(mime_type.clone()),
                notes: vec![format!("已从 Base64 还原为 {} 图像", format.label())],
                split_items: vec![],
            })
        }
        ToolRequest::Enhance {
            source_data_url,
            contrast,
            brighten,
            sharpen,
            saturation,
        } => {
            ensure_positive("锐化", sharpen)?;
            ensure_positive("饱和度", saturation)?;

            let mut image = load_image_from_data_url(&source_data_url)?;
            image = image.brighten(brighten);
            image = image.adjust_contrast(contrast);
            image = image.unsharpen(sharpen, 1);
            let saturated = apply_saturation(image.to_rgba8(), saturation);
            let output = DynamicImage::ImageRgba8(saturated);
            let (bytes, mime_type) = encode_image(&output, OutputFormat::Png, 100)?;
            let (width, height) = output.dimensions();
            Ok(ProcessResponse {
                primary_data_url: Some(to_data_url(&mime_type, &bytes)),
                primary_text: None,
                width: Some(width),
                height: Some(height),
                bytes: bytes.len(),
                mime_type: Some(mime_type),
                notes: vec![
                    format!(
                        "对比度 {}, 亮度 {}, 锐化 {:.1}, 饱和度 {:.2}",
                        contrast, brighten, sharpen, saturation
                    ),
                    "这是轻量增强链路，适合桌面本地快速处理。".into(),
                ],
                split_items: vec![],
            })
        }
        ToolRequest::Compress {
            source_data_url,
            output_format,
            quality,
            max_width,
        } => {
            ensure_quality(quality)?;
            if matches!(max_width, Some(0)) {
                return Err(ToolError::InvalidInput("最大宽度必须大于 0".into()));
            }

            let image = load_image_from_data_url(&source_data_url)?;
            let resized = resize_to_max_width(image, max_width);
            let (bytes, mime_type) = encode_image(&resized, output_format, quality)?;
            let (width, height) = resized.dimensions();
            let mut notes = vec![
                format!("已输出为 {}", output_format.label()),
                format!("结果尺寸 {} × {}", width, height),
            ];

            if matches!(output_format, OutputFormat::Jpeg) {
                notes.insert(1, format!("JPEG 质量 {}%", quality));
            } else {
                notes.insert(
                    1,
                    "当前 quality 参数主要影响 JPEG，PNG/WebP 使用默认编码策略。".into(),
                );
            }

            Ok(ProcessResponse {
                primary_data_url: Some(to_data_url(&mime_type, &bytes)),
                primary_text: None,
                width: Some(width),
                height: Some(height),
                bytes: bytes.len(),
                mime_type: Some(mime_type),
                notes,
                split_items: vec![],
            })
        }
        ToolRequest::Watermark {
            source_data_url,
            overlay_data_url,
            position,
            opacity,
            scale_percent,
            margin,
        } => {
            ensure_unit_interval("透明度", opacity)?;
            if scale_percent == 0 {
                return Err(ToolError::InvalidInput("缩放占比必须大于 0".into()));
            }

            let base = load_image_from_data_url(&source_data_url)?.to_rgba8();
            let overlay = load_image_from_data_url(&overlay_data_url)?.to_rgba8();
            let mut canvas = base.clone();
            let overlay = scale_overlay(&overlay, base.width(), scale_percent);
            let overlay = apply_opacity(overlay, opacity);
            let (x, y) = resolve_position(
                position,
                canvas.width(),
                canvas.height(),
                overlay.width(),
                overlay.height(),
                margin,
            );
            image::imageops::overlay(&mut canvas, &overlay, x as i64, y as i64);
            let output = DynamicImage::ImageRgba8(canvas);
            let (bytes, mime_type) = encode_image(&output, OutputFormat::Png, 100)?;
            let (width, height) = output.dimensions();
            Ok(ProcessResponse {
                primary_data_url: Some(to_data_url(&mime_type, &bytes)),
                primary_text: None,
                width: Some(width),
                height: Some(height),
                bytes: bytes.len(),
                mime_type: Some(mime_type),
                notes: vec![format!(
                    "已添加水印，位置 {}，透明度 {:.0}%",
                    position.label(),
                    opacity * 100.0
                )],
                split_items: vec![],
            })
        }
        ToolRequest::Crop {
            source_data_url,
            x,
            y,
            width,
            height,
        } => {
            let image = load_image_from_data_url(&source_data_url)?;
            let (img_width, img_height) = image.dimensions();

            if width == 0 || height == 0 {
                return Err(ToolError::InvalidInput("裁切宽高必须大于 0".into()));
            }

            let right = x
                .checked_add(width)
                .ok_or_else(|| ToolError::InvalidInput("裁切区域超出图像范围".into()))?;
            let bottom = y
                .checked_add(height)
                .ok_or_else(|| ToolError::InvalidInput("裁切区域超出图像范围".into()))?;

            if x >= img_width || y >= img_height || right > img_width || bottom > img_height {
                return Err(ToolError::InvalidInput("裁切区域超出图像范围".into()));
            }

            let cropped = image.crop_imm(x, y, width, height);
            let (bytes, mime_type) = encode_image(&cropped, OutputFormat::Png, 100)?;
            Ok(ProcessResponse {
                primary_data_url: Some(to_data_url(&mime_type, &bytes)),
                primary_text: None,
                width: Some(width),
                height: Some(height),
                bytes: bytes.len(),
                mime_type: Some(mime_type),
                notes: vec![format!("已裁切区域 ({}, {}) {} × {}", x, y, width, height)],
                split_items: vec![],
            })
        }
        ToolRequest::Split {
            source_data_url,
            rows,
            cols,
        } => {
            if rows == 0 || cols == 0 {
                return Err(ToolError::InvalidInput("行数和列数必须大于 0".into()));
            }

            let image = load_image_from_data_url(&source_data_url)?;
            let (width, height) = image.dimensions();

            if rows > height || cols > width {
                return Err(ToolError::InvalidInput(
                    "分割行列数不能超过图像像素尺寸，请减小 rows 或 cols".into(),
                ));
            }

            let mut split_items = Vec::new();
            let mut total_bytes = 0usize;
            let cell_width = width / cols;
            let cell_height = height / rows;

            for row in 0..rows {
                for col in 0..cols {
                    let left = col * cell_width;
                    let top = row * cell_height;
                    let current_width = if col == cols - 1 {
                        width - left
                    } else {
                        cell_width
                    };
                    let current_height = if row == rows - 1 {
                        height - top
                    } else {
                        cell_height
                    };
                    let tile = image.crop_imm(left, top, current_width, current_height);
                    let (bytes, mime_type) = encode_image(&tile, OutputFormat::Png, 100)?;
                    total_bytes += bytes.len();
                    split_items.push(SplitItem {
                        name: format!("tile-r{}-c{}.png", row + 1, col + 1),
                        data_url: to_data_url(&mime_type, &bytes),
                        width: current_width,
                        height: current_height,
                    });
                }
            }

            Ok(ProcessResponse {
                primary_data_url: None,
                primary_text: None,
                width: Some(width),
                height: Some(height),
                bytes: total_bytes,
                mime_type: None,
                notes: vec![format!(
                    "已切分为 {} 行 × {} 列，共 {} 张",
                    rows,
                    cols,
                    split_items.len()
                )],
                split_items,
            })
        }
    }
}

fn ensure_quality(quality: u8) -> Result<(), ToolError> {
    if (1..=100).contains(&quality) {
        Ok(())
    } else {
        Err(ToolError::InvalidInput(
            "质量参数必须在 1 到 100 之间".into(),
        ))
    }
}

fn ensure_positive(label: &str, value: f32) -> Result<(), ToolError> {
    if value > 0.0 {
        Ok(())
    } else {
        Err(ToolError::InvalidInput(format!("{}必须大于 0", label)))
    }
}

fn ensure_unit_interval(label: &str, value: f32) -> Result<(), ToolError> {
    if (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(ToolError::InvalidInput(format!(
            "{}必须在 0 到 1 之间",
            label
        )))
    }
}

fn decode_base64_payload(input: &str) -> Result<Vec<u8>, ToolError> {
    let payload = if let Some((_, body)) = input.trim().split_once(',') {
        body
    } else {
        input.trim()
    };

    let cleaned = payload
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    STANDARD
        .decode(cleaned)
        .map_err(|_| ToolError::InvalidBase64)
}

fn load_image_from_data_url(input: &str) -> Result<DynamicImage, ToolError> {
    let bytes = decode_base64_payload(input)?;
    Ok(image::load_from_memory(&bytes)?)
}

fn detect_format(bytes: &[u8]) -> OutputFormat {
    match image::guess_format(bytes).unwrap_or(ImageFormat::Png) {
        ImageFormat::Jpeg => OutputFormat::Jpeg,
        ImageFormat::WebP => OutputFormat::Webp,
        _ => OutputFormat::Png,
    }
}

fn encode_image(
    image: &DynamicImage,
    format: OutputFormat,
    quality: u8,
) -> Result<(Vec<u8>, String), ToolError> {
    match format {
        OutputFormat::Png => {
            let mut cursor = Cursor::new(Vec::new());
            image.write_to(&mut cursor, ImageFormat::Png)?;
            Ok((cursor.into_inner(), format.mime_type().into()))
        }
        OutputFormat::Jpeg => {
            let mut output = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut output, quality);
            encoder.encode_image(image)?;
            Ok((output, format.mime_type().into()))
        }
        OutputFormat::Webp => {
            let mut cursor = Cursor::new(Vec::new());
            image.write_to(&mut cursor, ImageFormat::WebP)?;
            Ok((cursor.into_inner(), format.mime_type().into()))
        }
    }
}

fn to_data_url(mime_type: &str, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", mime_type, STANDARD.encode(bytes))
}

fn resize_to_max_width(image: DynamicImage, max_width: Option<u32>) -> DynamicImage {
    let Some(max_width) = max_width else {
        return image;
    };
    let (width, height) = image.dimensions();
    if width <= max_width {
        return image;
    }
    let ratio = max_width as f32 / width as f32;
    let next_height = (height as f32 * ratio).round() as u32;
    image.resize(max_width, next_height.max(1), FilterType::Lanczos3)
}

fn apply_saturation(mut image: RgbaImage, factor: f32) -> RgbaImage {
    for pixel in image.pixels_mut() {
        let red = pixel[0] as f32;
        let green = pixel[1] as f32;
        let blue = pixel[2] as f32;
        let luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
        pixel[0] = (luminance + (red - luminance) * factor).clamp(0.0, 255.0) as u8;
        pixel[1] = (luminance + (green - luminance) * factor).clamp(0.0, 255.0) as u8;
        pixel[2] = (luminance + (blue - luminance) * factor).clamp(0.0, 255.0) as u8;
    }
    image
}

fn scale_overlay(overlay: &RgbaImage, base_width: u32, scale_percent: u32) -> RgbaImage {
    let target_width = ((base_width as f32) * (scale_percent as f32 / 100.0)).round() as u32;
    if target_width == 0 || target_width >= overlay.width() {
        return overlay.clone();
    }
    let ratio = target_width as f32 / overlay.width() as f32;
    let target_height = ((overlay.height() as f32) * ratio).round() as u32;
    image::imageops::resize(
        overlay,
        target_width,
        target_height.max(1),
        FilterType::Lanczos3,
    )
}

fn apply_opacity(mut overlay: RgbaImage, opacity: f32) -> RgbaImage {
    for pixel in overlay.pixels_mut() {
        pixel[3] = ((pixel[3] as f32) * opacity).round().clamp(0.0, 255.0) as u8;
    }
    overlay
}

fn resolve_position(
    position: WatermarkPosition,
    base_width: u32,
    base_height: u32,
    overlay_width: u32,
    overlay_height: u32,
    margin: u32,
) -> (u32, u32) {
    let x = match position {
        WatermarkPosition::TopLeft
        | WatermarkPosition::CenterLeft
        | WatermarkPosition::BottomLeft => margin,
        WatermarkPosition::TopCenter
        | WatermarkPosition::Center
        | WatermarkPosition::BottomCenter => base_width.saturating_sub(overlay_width) / 2,
        WatermarkPosition::TopRight
        | WatermarkPosition::CenterRight
        | WatermarkPosition::BottomRight => base_width.saturating_sub(overlay_width + margin),
    };

    let y = match position {
        WatermarkPosition::TopLeft | WatermarkPosition::TopCenter | WatermarkPosition::TopRight => {
            margin
        }
        WatermarkPosition::CenterLeft
        | WatermarkPosition::Center
        | WatermarkPosition::CenterRight => base_height.saturating_sub(overlay_height) / 2,
        WatermarkPosition::BottomLeft
        | WatermarkPosition::BottomCenter
        | WatermarkPosition::BottomRight => base_height.saturating_sub(overlay_height + margin),
    };

    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_image_data_url(width: u32, height: u32, color: [u8; 4]) -> String {
        let image =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(width, height, image::Rgba(color)));
        let (bytes, mime_type) = encode_image(&image, OutputFormat::Png, 100).unwrap();
        to_data_url(&mime_type, &bytes)
    }

    #[test]
    fn base64_decode_accepts_plain_payload_without_prefix() {
        let source = sample_image_data_url(4, 4, [255, 0, 0, 255]);
        let raw_base64 = source.split_once(',').unwrap().1.to_string();

        let response = handle_request(ToolRequest::Base64Decode {
            base64_input: raw_base64,
            output_format: None,
        })
        .unwrap();

        assert_eq!(response.width, Some(4));
        assert_eq!(response.height, Some(4));
        assert!(response
            .primary_data_url
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn compress_resizes_image_to_max_width() {
        let source = sample_image_data_url(12, 6, [0, 128, 255, 255]);

        let response = handle_request(ToolRequest::Compress {
            source_data_url: source,
            output_format: OutputFormat::Jpeg,
            quality: 80,
            max_width: Some(4),
        })
        .unwrap();

        assert_eq!(response.width, Some(4));
        assert_eq!(response.height, Some(2));
        assert!(response.bytes > 0);
    }

    #[test]
    fn crop_rejects_overflowing_bounds_instead_of_panicking() {
        let source = sample_image_data_url(4, 4, [0, 255, 0, 255]);

        let error = handle_request(ToolRequest::Crop {
            source_data_url: source,
            x: 1,
            y: 1,
            width: u32::MAX,
            height: 1,
        })
        .unwrap_err();

        assert!(matches!(error, ToolError::InvalidInput(_)));
    }

    #[test]
    fn split_rejects_more_columns_than_pixels() {
        let source = sample_image_data_url(4, 4, [0, 0, 255, 255]);

        let error = handle_request(ToolRequest::Split {
            source_data_url: source,
            rows: 2,
            cols: 5,
        })
        .unwrap_err();

        assert!(matches!(error, ToolError::InvalidInput(_)));
    }

    #[test]
    fn split_reports_total_output_bytes() {
        let source = sample_image_data_url(6, 6, [120, 80, 20, 255]);

        let response = handle_request(ToolRequest::Split {
            source_data_url: source,
            rows: 2,
            cols: 3,
        })
        .unwrap();

        let total_decoded_bytes: usize = response
            .split_items
            .iter()
            .map(|item| decode_base64_payload(&item.data_url).unwrap().len())
            .sum();

        assert_eq!(response.split_items.len(), 6);
        assert_eq!(response.bytes, total_decoded_bytes);
        assert!(response.bytes > response.split_items.len());
    }

    #[test]
    fn tool_request_accepts_frontend_camel_case_fields() {
        let source = sample_image_data_url(4, 4, [255, 255, 255, 255]);

        let request: ToolRequest = serde_json::from_value(serde_json::json!({
            "kind": "base64Encode",
            "sourceDataUrl": source,
            "outputFormat": "png"
        }))
        .unwrap();

        match request {
            ToolRequest::Base64Encode {
                source_data_url,
                output_format,
            } => {
                assert!(source_data_url.starts_with("data:image/png;base64,"));
                assert!(matches!(output_format, OutputFormat::Png));
            }
            _ => panic!("unexpected request variant"),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![process_tool])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
