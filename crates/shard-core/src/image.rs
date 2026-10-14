//! 图片类型识别。
//!
//! 以文件头为准，扩展名只在嗅探不出时兜底：附件按内容哈希命名，旧版附件还有丢了
//! 扩展名的（`…-b858-png`），扩展名本身不可信。

/// 资料库认作图片的扩展名（小写）。
pub const IMAGE_EXTENSIONS: &[&str] = &[
    "avif", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "webp",
];

pub fn is_image_extension(extension: &str) -> bool {
    let lower = extension.to_ascii_lowercase();
    IMAGE_EXTENSIONS.contains(&lower.as_str())
}

pub fn is_image_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(is_image_extension)
}

pub fn image_mime_type_from_extension(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "avif" => Some("image/avif"),
        "gif" => Some("image/gif"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

pub fn image_extension_for_mime_type(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/avif" => Some("avif"),
        "image/gif" => Some("gif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/svg+xml" => Some("svg"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

pub fn sniff_image_mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if let Some(mime_type) = sniff_iso_media(bytes) {
        return Some(mime_type);
    }
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    if trimmed.starts_with("<svg")
        || (trimmed.starts_with("<?xml")
            || trimmed.starts_with("<!--")
            || trimmed.starts_with("<!DOCTYPE svg"))
            && trimmed.contains("<svg")
    {
        return Some("image/svg+xml");
    }
    None
}

/// 文件头优先，嗅探不出再看扩展名。
pub fn image_mime_type(path: &std::path::Path, bytes: &[u8]) -> Option<&'static str> {
    sniff_image_mime_type(bytes).or_else(|| {
        path.extension()
            .and_then(|extension| extension.to_str())
            .and_then(image_mime_type_from_extension)
    })
}

/// HEIF 家族（HEIC/AVIF）是 ISO BMFF 容器：`ftyp` 盒的主品牌与兼容品牌说明编码。
fn sniff_iso_media(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return None;
    }
    let box_size = u32::from_be_bytes(bytes[0..4].try_into().ok()?) as usize;
    let end = box_size.clamp(16, bytes.len().min(256));
    let major = &bytes[8..12];
    let compatible = bytes[16..end].chunks_exact(4);
    let brands = std::iter::once(major).chain(compatible);
    let mut heif = false;
    for brand in brands {
        match brand {
            b"avif" | b"avis" => return Some("image/avif"),
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" => return Some("image/heic"),
            b"mif1" | b"msf1" => heif = true,
            _ => {}
        }
    }
    heif.then_some("image/heif")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ftyp(major: &[u8; 4], compatible: &[&[u8; 4]]) -> Vec<u8> {
        let size = 16 + compatible.len() * 4;
        let mut bytes = (size as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(major);
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        for brand in compatible {
            bytes.extend_from_slice(*brand);
        }
        bytes.extend_from_slice(&[0; 32]);
        bytes
    }

    #[test]
    fn sniffs_common_formats() {
        assert_eq!(sniff_image_mime_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff_image_mime_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff_image_mime_type(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image_mime_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image_mime_type(b"\xef\xbb\xbf <svg xmlns='x'/>"), Some("image/svg+xml"));
        assert_eq!(
            sniff_image_mime_type(b"<?xml version='1.0'?><!-- c --><svg/>"),
            Some("image/svg+xml")
        );
        assert_eq!(
            sniff_image_mime_type(b"<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x\"><svg/>"),
            Some("image/svg+xml")
        );
        assert_eq!(sniff_image_mime_type(b"<html><svg/></html>"), None);
        assert_eq!(sniff_image_mime_type(b"plain text"), None);
    }

    #[test]
    fn sniffs_heif_family_by_brand() {
        assert_eq!(sniff_image_mime_type(&ftyp(b"heic", &[b"mif1"])), Some("image/heic"));
        assert_eq!(sniff_image_mime_type(&ftyp(b"mif1", &[b"heic"])), Some("image/heic"));
        assert_eq!(sniff_image_mime_type(&ftyp(b"avif", &[b"mif1"])), Some("image/avif"));
        assert_eq!(sniff_image_mime_type(&ftyp(b"mif1", &[b"avif", b"miaf"])), Some("image/avif"));
        assert_eq!(sniff_image_mime_type(&ftyp(b"mif1", &[b"miaf"])), Some("image/heif"));
        // 视频同为 ISO BMFF，不能当图片。
        assert_eq!(sniff_image_mime_type(&ftyp(b"isom", &[b"mp41"])), None);
        assert_eq!(sniff_image_mime_type(&ftyp(b"qt  ", &[])), None);
    }

    #[test]
    fn falls_back_to_extension_only_when_sniffing_fails() {
        let path = std::path::Path::new("a.svg");
        assert_eq!(image_mime_type(path, b"   "), Some("image/svg+xml"));
        // 扩展名说 jpg、内容是 png：以内容为准。
        assert_eq!(
            image_mime_type(std::path::Path::new("a.jpg"), b"\x89PNG\r\n\x1a\n"),
            Some("image/png")
        );
        assert_eq!(image_mime_type(std::path::Path::new("a.txt"), b"hello"), None);
        assert!(is_image_extension("HEIC"));
        assert!(!is_image_extension("pdf"));
    }
}
