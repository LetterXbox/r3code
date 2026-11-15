//! Header-only dimensions for the formats accepted by T3 Code's image viewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}
fn be16(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(i..i + 2)?.try_into().ok()?))
}
fn be32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?))
}
fn le16(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?))
}
fn le32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}
fn exif_rotated(b: &[u8], start: usize, end: usize) -> Option<bool> {
    let end = end.min(b.len());
    let data = b.get(start..end)?;
    if data.len() < 14 || data.get(..4)? != b"Exif" {
        return None;
    }
    let little = match data.get(6..8)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |i| if little { le16(data, i) } else { be16(data, i) };
    let u32_at = |i| if little { le32(data, i) } else { be32(data, i) };
    let ifd = 6usize.checked_add(u32_at(10)? as usize)?;
    let count = u16_at(ifd)? as usize;
    for i in 0..count {
        let entry = ifd.checked_add(2)?.checked_add(i.checked_mul(12)?)?;
        if entry.checked_add(12)? > data.len() {
            return None;
        }
        if u16_at(entry)? == 0x0112 {
            return Some((5..=8).contains(&u16_at(entry + 8)?));
        }
    }
    Some(false)
}
fn jpeg(b: &[u8]) -> Option<Dimensions> {
    if b.get(..2)? != [0xff, 0xd8] {
        return None;
    }
    let mut i = 2usize;
    let mut rotated = false;
    while i.checked_add(9)? <= b.len() {
        if b[i] != 0xff {
            return None;
        }
        let marker = b[i + 1];
        if marker == 0xff {
            i += 1;
            continue;
        }
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            let height = u32::from(be16(b, i + 5)?);
            let width = u32::from(be16(b, i + 7)?);
            return Some(if rotated {
                Dimensions {
                    width: height,
                    height: width,
                }
            } else {
                Dimensions { width, height }
            });
        }
        if matches!(marker, 0xd9 | 0xda) {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            i += 2;
            continue;
        }
        let length = usize::from(be16(b, i + 2)?);
        if length < 2 {
            return None;
        }
        let end = i.checked_add(2)?.checked_add(length)?;
        if marker == 0xe1 && !rotated {
            rotated = exif_rotated(b, i + 4, end).unwrap_or(false);
        }
        i = end;
    }
    None
}
pub fn read(b: &[u8]) -> Option<Dimensions> {
    let d = if b.len() >= 24 && b.get(..4) == Some(b"\x89PNG") && b.get(12..16) == Some(b"IHDR") {
        Dimensions {
            width: be32(b, 16)?,
            height: be32(b, 20)?,
        }
    } else if b.len() >= 10 && b.get(..4) == Some(b"GIF8") {
        Dimensions {
            width: u32::from(le16(b, 6)?),
            height: u32::from(le16(b, 8)?),
        }
    } else if b.get(..4) == Some(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        match b.get(12..16)? {
            b"VP8 " => Dimensions {
                width: u32::from(le16(b, 26)? & 0x3fff),
                height: u32::from(le16(b, 28)? & 0x3fff),
            },
            b"VP8L" => {
                let p = le32(b, 21)?;
                Dimensions {
                    width: (p & 0x3fff) + 1,
                    height: ((p >> 14) & 0x3fff) + 1,
                }
            }
            b"VP8X" => {
                let x = b.get(24..30)?;
                Dimensions {
                    width: u32::from(x[0]) + (u32::from(x[1]) << 8) + (u32::from(x[2]) << 16) + 1,
                    height: u32::from(x[3]) + (u32::from(x[4]) << 8) + (u32::from(x[5]) << 16) + 1,
                }
            }
            _ => return None,
        }
    } else {
        jpeg(b)?
    };
    (d.width > 0 && d.height > 0).then_some(d)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_headers_and_truncation() {
        let mut png = vec![0; 24];
        png[..4].copy_from_slice(b"\x89PNG");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&640u32.to_be_bytes());
        png[20..24].copy_from_slice(&480u32.to_be_bytes());
        assert_eq!(
            read(&png),
            Some(Dimensions {
                width: 640,
                height: 480
            })
        );
        assert_eq!(
            read(b"GIF89a\x02\x00\x03\x00"),
            Some(Dimensions {
                width: 2,
                height: 3
            })
        );
        assert_eq!(
            read(&[0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 3, 0, 2]),
            Some(Dimensions {
                width: 2,
                height: 3
            })
        );
        for n in 0..png.len() {
            assert!(read(&png[..n]).is_none());
        }
        assert!(read(b"RIFF\0\0\0\0WEBPVP8X").is_none());
    }
    #[test]
    fn jpeg_exif_orientation_rotates_dimensions() {
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1, 0, 34];
        jpeg.extend_from_slice(b"Exif\0\0II\x2a\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00\x00\x00\x00\x00");
        jpeg.extend_from_slice(&[0xff, 0xc0, 0, 7, 8, 0, 3, 0, 2]);
        assert_eq!(
            read(&jpeg),
            Some(Dimensions {
                width: 3,
                height: 2
            })
        );
    }
}
