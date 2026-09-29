// app/shell-tauri/src-tauri/src/pictures.rs
// The first non-text bytes a project has ever held.
//
// FILES BESIDE THE STORE, AND THE DATABASE HOLDS A NAME -- decided before any
// code, from a survey of six subsystems, and this module does not restate the
// argument. The short of
// it: a recovery point is `VACUUM INTO` of the whole project file, taken on a
// timer, kept up to forty-eight times and once per archive with no prune ever,
// so fifty photographs inside the database are a 48x byte multiplier on a
// novelist's photo library. And `salvage::read_docs` reads a body as a `String`,
// so a row that is not valid text is a loss that is never written out at all --
// which is already pinned by a test that stores `x'FFFE0000'` deliberately.
//
// THE PAGE NEVER NAMES A PATH, IN EITHER DIRECTION. A picture is attached from a
// file the writer chooses in an OS dialog, in the HOST, under a uuid the host
// generates; the page is handed a thumbnail and a state word. So there is no
// inbound path to validate. What IS validated is every name READ BACK out of the
// file, because a damaged project, a foreign tool or a hand-edited row can hold
// any string in that column.
//
// THE WEB PROCESS NEVER SEES AN ORIGINAL. One 4000x3000 photograph decoded is
// roughly 48 MB, and `peak_rss_mb` sums VmRSS over the WHOLE process tree --
// main, webview and helpers. Decoding a full-resolution original to render a
// list would put that inside the webview's half of the sum. The full decode
// happens ONCE, here, at attach time, at a moment the writer is already waiting
// on a file dialog; every render afterwards reads a cached thumbnail bounded at
// THUMB_MAX on its longest side.
//
// THE THUMBNAIL FILE IS AN OPTIMIZATION, NOT A SECOND SOURCE OF TRUTH, which is
// the mirror watcher's rule in another surface. The original is the record. A
// thumbnail that has been deleted is regenerated on the next read rather than
// reported as damage, so nothing about the writer's picture depends on a cache
// file surviving.
//
// THE DECODERS ARE THIRD PARTY AND THE ARITHMETIC IS OURS. `png` was already in
// this build's lock twice (tauri and wry pull it), so declaring it unifies with
// a compilation unit that is already there -- the argument Cargo.toml already
// makes for `webkit2gtk`. `zune-jpeg` adds exactly two packages. `image` was
// measured and rejected: with `default-features = false, features =
// ["jpeg", "png"]` it locks SIX, two of which (`moxcms`, `pxfm`) are colour
// management and SIMD libm carrying 104 files of `unsafe` between them, to
// render a 256 px thumbnail. What it would have bought is `thumbnail()` and a
// `Limits` guard; the box filter below is arithmetic this crate can test and
// mutate, and the pixel ceiling is a check read off the HEADER before any buffer
// is allocated, which is stronger than a limit handed to a facade.
#[cfg(target_os = "linux")]
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The suffix appended to the project file's stem to name its picture
/// directory: `the-harbour.db` -> `the-harbour.pictures/`.
pub const PICTURES_SUFFIX: &str = ".pictures";

/// What a cached thumbnail is called: `<uuid>.jpg` -> `<uuid>.thumb.png`.
///
/// Derived from the stored name rather than stored anywhere, so there is one
/// place that decides it and no second column free to disagree.
pub const THUMB_SUFFIX: &str = ".thumb.png";

/// The longest side of a thumbnail, in pixels.
pub const THUMB_MAX: u32 = 256;

/// The longest side of a FULL-SIZE view, in pixels.
///
/// SLICE 038 LEFT "there is no way to see a picture full size" OPEN, and this is
/// the bound that closes it without giving up the rule the whole module is built
/// on. The web process must never hold a decoded original -- one 4000x3000
/// photograph is roughly 48 MB and `peak_rss_mb` sums the whole process tree --
/// so "full size" here means a picture bounded at 1600 px on its long side,
/// which is about 7.7 MB decoded and a few megabytes as a PNG, held only while
/// the viewer is open. That is a picture a writer can actually look at and a
/// cost this application can state.
///
/// IT IS NOT CACHED, unlike the thumbnail, and the asymmetry is the read rate.
/// A thumbnail is read on every selection, so a file that saves that decode pays
/// for itself immediately; a full view is read when somebody asks to look
/// properly, which is rare, and caching it would double the disk a picture costs
/// for a read almost nobody takes.
pub const FULL_MAX: u32 = 1600;

/// The largest file this application will read as a picture.
///
/// CHECKED ON THE METADATA, before a byte is read. A photograph off a modern
/// camera is single-digit megabytes; this is generous for that and still bounds
/// what one bad file can make the host allocate.
pub const MAX_PICTURE_BYTES: u64 = 16 * 1024 * 1024;

/// The most pixels this application will decode.
///
/// READ OFF THE HEADER, before any pixel buffer exists. This is the
/// decompression bomb: a hundred-kilobyte PNG can DECLARE 30000x30000, and a
/// decoder handed one allocates gigabytes before it fails. Fifty megapixels is
/// past any camera a novelist is photographing their characters with.
pub const MAX_PICTURE_PIXELS: u64 = 50_000_000;

/// The two formats a picture may be in.
///
/// BY CONTENT, NEVER BY EXTENSION. The stored extension is derived from what the
/// bytes actually are, so a `.png` that is really a JPEG is stored as `.jpg` and
/// a `.png` that is really a shell script is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpeg,
}

impl Format {
    /// The extension a stored original of this format is written under.
    pub fn extension(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpeg => "jpg",
        }
    }

    /// The MIME type a data URI of this format carries.
    pub fn mime(self) -> &'static str {
        match self {
            Format::Png => "image/png",
            Format::Jpeg => "image/jpeg",
        }
    }
}

/// Why a file was not accepted as a picture. Each variant is a sentence the
/// writer can act on, not a code.
#[derive(Debug)]
pub enum PictureError {
    TooLarge { bytes: u64, limit: u64 },
    UnknownFormat,
    TooManyPixels { pixels: u64, limit: u64 },
    Decode(String),
    Io(String),
}

impl std::fmt::Display for PictureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PictureError::TooLarge { bytes, limit } => write!(
                f,
                "that file is {bytes} bytes and the largest picture this book will take is {limit}"
            ),
            PictureError::UnknownFormat => {
                write!(f, "that file is not a PNG or a JPEG, whatever it is called")
            }
            PictureError::TooManyPixels { pixels, limit } => write!(
                f,
                "that picture says it is {pixels} pixels and the largest this book will read is {limit}"
            ),
            PictureError::Decode(e) => write!(f, "that picture could not be read: {e}"),
            PictureError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// What the panel is told about one member's picture. FOUR STATES AND A TAG,
/// never an empty string: "there is no picture" and "the picture is gone" are
/// different things to say to a writer, and a page given one empty answer for
/// both would have to guess.
pub const VIEW_NONE: &str = "none";
pub const VIEW_PRESENT: &str = "present";
/// The column names a file that is not in the directory. The column is NOT
/// cleared: a writer whose external drive is unmounted has not asked to forget
/// which photograph they chose.
pub const VIEW_MISSING: &str = "missing";
/// The file is there and could not be read -- or the column holds something
/// that is not a name this application would ever have written.
pub const VIEW_UNREADABLE: &str = "unreadable";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PictureView {
    /// One of the four words above.
    pub state: String,
    /// A `data:` URI of the THUMBNAIL, and only when `state` is `present`.
    pub data_uri: Option<String>,
}

/// Where this project's pictures live: `<stem>.pictures/`, beside the project
/// file.
///
/// FROM THE STORE PATH ALONE -- not from `data_home`, not from a library slug --
/// and that is load-bearing three times. `salvage` is handed a bare `.db` path
/// and no data home, so a directory it could not derive is a directory it could
/// not recover from. A book can live in a folder the writer picked (031), and
/// their photographs belong beside their book rather than in an
/// application-owned area they will never find. And `projects::list` filters
/// `p.is_file()`, so a directory sitting in the library is invisible to the
/// listing that walks it.
///
/// It is also NOT under `mirror_dir`, which is what leaves
/// `mirror::walk_for_unmatched` untouched by construction rather than by an
/// exclusion list it would have to be taught.
pub fn dir_for(project_db: &Path) -> PathBuf {
    let stem = project_db
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "project".to_string());
    let parent = project_db.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{stem}{PICTURES_SUFFIX}"))
}

/// Whether `name` is something this application could have written into a
/// picture directory, and therefore something it may join to one.
///
/// THE CHECK IS ON THE NAME, exactly as `projects::import_name_ok` is, and for
/// the same reason: a name with no separator and no `..` cannot address anything
/// outside the one directory it is joined to, so there is nothing here for a
/// race to invalidate -- unlike an `exists()` probe or a canonicalize-and-compare.
///
/// LOWERCASE EXTENSIONS ONLY. Every name this application writes is
/// `<uuid>.png` or `<uuid>.jpg`; accepting `.PNG` would widen the set for a
/// value only a foreign tool could have written, and refusing it says so
/// honestly through `unreadable` rather than reading a stranger's file.
pub fn is_stored_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('.') {
        return false;
    }
    // `\` as well as `/`: it is not a separator on this platform, and a name
    // carrying one has still been composed somewhere this function cannot see.
    // `\0` truncates at the syscall boundary, so `x.png\0/../y` must not read as
    // ending in `.png`.
    //
    // THIS SCAN AND NOTHING ELSE, exactly as `projects::import_name_ok` ends up.
    // A first draft also refused any name CONTAINING `..`, and that check was
    // deleted rather than kept: traversal needs `..` to be a whole path
    // COMPONENT, which needs a separator, which is already refused -- so no
    // input could kill it. A guard nothing can reach is worse than none, because
    // a reader credits it for the refusal. `a..b.png` is an ordinary filename
    // and joining it to a directory addresses a file inside that directory.
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return false;
    }
    name.ends_with(".png") || name.ends_with(".jpg")
}

/// The cached thumbnail's name for a stored original, or None when the original
/// is not a name this application would have written.
///
/// THE CHECKED ENTRY POINT, for a caller that has not already gated. A caller
/// that HAS gated uses `thumb_of` -- see there for why the two exist.
pub fn thumb_name(stored: &str) -> Option<String> {
    is_stored_name(stored).then(|| thumb_of(stored))
}

/// The cached thumbnail's name for a name `is_stored_name` has already accepted.
///
/// SEPARATE FROM `thumb_name` BECAUSE A MUTATION PROVED IT HAD TO BE. `view`
/// gated with `is_stored_name` and then took `thumb_name`, which gates AGAIN --
/// so deleting `view`'s own check SURVIVED the whole suite: the two rules refuse
/// the same input and cover for each other, which is the recorded shape where a
/// mutation is the only thing that can see it. One gate per path now, and the
/// one on the traversal path is `view`'s own.
///
/// Every accepted name ends in a four-character extension, so the stem is what
/// precedes it. Reachable only behind `is_stored_name`, which is what makes the
/// slice safe.
fn thumb_of(stored: &str) -> String {
    let stem = &stored[..stored.len() - 4];
    format!("{stem}{THUMB_SUFFIX}")
}

/// What the first bytes of a file say it is.
///
/// The PNG signature is eight bytes and is unambiguous. JPEG is `FF D8 FF`: the
/// start-of-image marker followed by the first byte of whatever marker comes
/// next, which every JPEG in the wild has. Nothing else is accepted, and a file
/// too short to carry either is not a picture.
pub fn sniff(head: &[u8]) -> Option<Format> {
    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if head.starts_with(&PNG) {
        return Some(Format::Png);
    }
    if head.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(Format::Jpeg);
    }
    None
}

/// A decoded picture: eight-bit RGB, three bytes per pixel, no alpha.
///
/// ALPHA IS DROPPED ONTO WHITE at decode. A thumbnail is composited against the
/// panel either way, and carrying a fourth channel through the box filter and
/// into the encoder would be a third of the work for a difference the writer
/// cannot see at 256 px.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgb {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` bytes, row major.
    pub pixels: Vec<u8>,
}

/// Decode a picture to eight-bit RGB, refusing one whose HEADER declares more
/// pixels than this build will hold.
///
/// THE CEILING IS CHECKED BETWEEN THE HEADER AND THE BUFFER, in both arms. Both
/// decoders read the dimensions before any pixel storage exists, which is the
/// only place the check is worth anything: after the allocation the damage is
/// done, and before the parse there is no number to check.
fn decode(bytes: &[u8], format: Format) -> Result<Rgb, PictureError> {
    match format {
        Format::Png => decode_png(bytes),
        Format::Jpeg => decode_jpeg(bytes),
    }
}

/// The pixel ceiling, in the one place both arms consult it.
fn checked_pixels(width: u32, height: u32) -> Result<(), PictureError> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels > MAX_PICTURE_PIXELS {
        return Err(PictureError::TooManyPixels {
            pixels,
            limit: MAX_PICTURE_PIXELS,
        });
    }
    Ok(())
}

/// Alpha composited onto WHITE, in the one place every arm consults it. See
/// `Rgb`: a thumbnail sits on the panel either way, and carrying a fourth
/// channel through the filter and the encoder buys a difference nobody can see
/// at 256 px.
fn over_white(value: u8, alpha: u8) -> u8 {
    let a = u16::from(alpha);
    ((u16::from(value) * a + 255 * (255 - a)) / 255) as u8
}

fn decode_png(bytes: &[u8]) -> Result<Rgb, PictureError> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    // Palettes expanded, sixteen-bit channels dropped to eight, tRNS turned
    // into a real alpha channel. Everything below then has four shapes to
    // handle rather than the format's full matrix.
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder
        .read_info()
        .map_err(|e| PictureError::Decode(e.to_string()))?;
    let (width, height) = {
        let info = reader.info();
        (info.width, info.height)
    };
    checked_pixels(width, height)?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| PictureError::Decode("the picture's size does not fit in memory".into()))?;
    let mut buf = vec![0u8; size];
    let frame = reader
        .next_frame(&mut buf)
        .map_err(|e| PictureError::Decode(e.to_string()))?;
    let stride = frame.line_size;
    let mut pixels = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for y in 0..height as usize {
        let row = &buf[y * stride..y * stride + stride];
        match frame.color_type {
            png::ColorType::Rgb => pixels.extend_from_slice(&row[..width as usize * 3]),
            png::ColorType::Rgba => {
                for p in row[..width as usize * 4].chunks_exact(4) {
                    pixels.extend_from_slice(&[
                        over_white(p[0], p[3]),
                        over_white(p[1], p[3]),
                        over_white(p[2], p[3]),
                    ]);
                }
            }
            png::ColorType::Grayscale => {
                for p in &row[..width as usize] {
                    pixels.extend_from_slice(&[*p, *p, *p]);
                }
            }
            png::ColorType::GrayscaleAlpha => {
                for p in row[..width as usize * 2].chunks_exact(2) {
                    let v = over_white(p[0], p[1]);
                    pixels.extend_from_slice(&[v, v, v]);
                }
            }
            // `normalize_to_color8` expands a palette, so this is unreachable
            // through the transformation above. It is an error rather than a
            // silent black picture, because a decoder that stopped expanding
            // palettes must announce itself.
            other => {
                return Err(PictureError::Decode(format!(
                    "this build cannot read a {other:?} PNG"
                )))
            }
        }
    }
    Ok(Rgb {
        width,
        height,
        pixels,
    })
}

fn decode_jpeg(bytes: &[u8]) -> Result<Rgb, PictureError> {
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    let mut decoder = zune_jpeg::JpegDecoder::new(std::io::Cursor::new(bytes));
    decoder
        .decode_headers()
        .map_err(|e| PictureError::Decode(e.to_string()))?;
    let info = decoder
        .info()
        .ok_or_else(|| PictureError::Decode("the picture has no header".into()))?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    checked_pixels(width, height)?;
    let out = decoder
        .decode()
        .map_err(|e| PictureError::Decode(e.to_string()))?;
    // The decoder's own answer about what it produced, never an assumption: a
    // grayscale JPEG comes back one component wide and reading it as three
    // would render a third of the picture, stretched, in false colour.
    let space = decoder
        .output_colorspace()
        .ok_or_else(|| PictureError::Decode("the picture has no colour space".into()))?;
    let pixels = match space {
        ColorSpace::RGB => out,
        ColorSpace::Luma => out.iter().flat_map(|v| [*v, *v, *v]).collect(),
        other => {
            return Err(PictureError::Decode(format!(
                "this build cannot read a {other:?} JPEG"
            )))
        }
    };
    Ok(Rgb {
        width,
        height,
        pixels,
    })
}

/// Scale so the longest side is at most `max`, by averaging each source block.
///
/// A BOX FILTER AND NOT NEAREST NEIGHBOUR. At a 15:1 reduction nearest
/// neighbour keeps one pixel in two hundred and twenty-five, so a face becomes
/// whichever pixels the arithmetic happened to land on -- visible as aliasing
/// on hair, cloth and anything with a repeating pattern, which is most of a
/// photograph.
///
/// IT NEVER ENLARGES. A picture already inside the bound is returned unchanged
/// rather than resampled to the ceiling, so a small drawing stays exactly the
/// bytes the writer chose and no round trip through the filter can soften it.
fn box_scale(src: &Rgb, max: u32) -> Rgb {
    let longest = src.width.max(src.height);
    if longest <= max || longest == 0 || src.width == 0 || src.height == 0 {
        return src.clone();
    }
    // `.max(1)` on both: a very wide, one-pixel-tall picture rounds its short
    // side to zero, and an image with no rows is not a smaller image.
    let width = ((u64::from(src.width) * u64::from(max)) / u64::from(longest)).max(1) as u32;
    let height = ((u64::from(src.height) * u64::from(max)) / u64::from(longest)).max(1) as u32;
    let mut pixels = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for y in 0..height {
        // Half-open source bands, computed from the OUTPUT index at both ends,
        // so every source row belongs to exactly one output row and none is
        // read twice or skipped.
        let y0 = (u64::from(y) * u64::from(src.height) / u64::from(height)) as usize;
        let y1 = ((u64::from(y) + 1) * u64::from(src.height) / u64::from(height)) as usize;
        let y1 = y1.max(y0 + 1);
        for x in 0..width {
            let x0 = (u64::from(x) * u64::from(src.width) / u64::from(width)) as usize;
            let x1 = ((u64::from(x) + 1) * u64::from(src.width) / u64::from(width)) as usize;
            let x1 = x1.max(x0 + 1);
            let mut sum = [0u64; 3];
            let mut n = 0u64;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = (sy * src.width as usize + sx) * 3;
                    sum[0] += u64::from(src.pixels[i]);
                    sum[1] += u64::from(src.pixels[i + 1]);
                    sum[2] += u64::from(src.pixels[i + 2]);
                    n += 1;
                }
            }
            pixels.push((sum[0] / n) as u8);
            pixels.push((sum[1] / n) as u8);
            pixels.push((sum[2] / n) as u8);
        }
    }
    Rgb {
        width,
        height,
        pixels,
    }
}

/// The thumbnail's bytes: PNG, whatever the original was, so the render path
/// has one encoder and one MIME type.
fn encode_png(img: &Rgb) -> Result<Vec<u8>, PictureError> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, img.width, img.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| PictureError::Decode(e.to_string()))?;
        writer
            .write_image_data(&img.pixels)
            .map_err(|e| PictureError::Decode(e.to_string()))?;
    }
    Ok(out)
}

/// RFC 4648 base64, for the data URI.
///
/// FIFTEEN LINES RATHER THAN A DEPENDENCY, which is `store::hash64`'s argument
/// for hand-writing FNV: this is a fixed alphabet and a fixed padding rule with
/// published test vectors, so a crate would add a supply chain for something
/// that cannot drift.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Take a picture into this project: check it, retain the writer's bytes under
/// a fresh name, and cache a thumbnail beside them. Returns the name the
/// database stores.
///
/// THE ORIGINAL IS COPIED, NOT RE-ENCODED. The writer keeps their photograph;
/// this application keeps a thumbnail of it. Re-encoding would quietly make the
/// stored picture worse than the one they chose.
///
/// COPIED RATHER THAN REFERENCED, and the record only implied it. A referenced
/// path is a path outside anything this application owns, so the book loses a
/// face the day the writer tidies their downloads or unplugs a drive -- and it
/// would be an ABSOLUTE path in the database, which is what "a relative path and
/// nothing else" forbids and what would leak a private path into a recovery
/// manifest and a salvage output. Within this directory only, equal originals
/// may share a hard-linked inode after exact-byte verification; each attachment
/// still has a fresh name and its own thumbnail. This is best effort: concurrent
/// first attaches may both copy, and a filesystem that cannot link falls back.
///
/// THE CEILING IS READ OFF THE METADATA FIRST, so a refusal for size costs one
/// `stat` rather than a copy of the file it is refusing.
pub fn attach(dir: &Path, source: &Path) -> Result<String, PictureError> {
    let bytes = std::fs::metadata(source)
        .map_err(|e| PictureError::Io(format!("{}: {e}", source.display())))?
        .len();
    if bytes > MAX_PICTURE_BYTES {
        return Err(PictureError::TooLarge {
            bytes,
            limit: MAX_PICTURE_BYTES,
        });
    }
    let data = std::fs::read(source)
        .map_err(|e| PictureError::Io(format!("{}: {e}", source.display())))?;
    let format = sniff(&data).ok_or(PictureError::UnknownFormat)?;
    // DECODED BEFORE ANYTHING IS WRITTEN. A file this build cannot render must
    // not become a picture the panel then reports as unreadable forever.
    let thumb = encode_png(&box_scale(&decode(&data, format)?, THUMB_MAX))?;

    let name = format!("{}.{}", uuid::Uuid::now_v7(), format.extension());
    // The thumbnail's own name is derived, so `is_stored_name` has just accepted
    // the name this builds -- there is no second rule here.
    let thumb_at = thumb_name(&name).ok_or(PictureError::UnknownFormat)?;
    std::fs::create_dir_all(dir)
        .map_err(|e| PictureError::Io(format!("{}: {e}", dir.display())))?;
    let original = dir.join(&name);
    #[cfg(target_os = "linux")]
    let linked = link_existing_original(dir, &name, format, &data)?;
    #[cfg(not(target_os = "linux"))]
    let linked = false;
    if !linked {
        write_new_original(&original, &data)?;
    }
    // THE ORIGINAL FIRST, THE CACHE SECOND. A thumbnail with no original behind
    // it is a file nothing can regenerate or delete; an original with no
    // thumbnail is regenerated on the next read.
    if let Err(e) = std::fs::write(dir.join(&thumb_at), &thumb) {
        eprintln!("pictures: could not cache {thumb_at}: {e}");
    }
    Ok(name)
}

/// Link one verified stored original to this attachment's fresh name. The
/// candidate is linked before it is read, so a replacement after enumeration
/// cannot make the returned name refer to bytes this attach did not validate.
#[cfg(target_os = "linux")]
fn link_existing_original(
    dir: &Path,
    name: &str,
    format: Format,
    data: &[u8],
) -> Result<bool, PictureError> {
    let directory_entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!(
                "pictures: could not enumerate {} for deduplication: {e}",
                dir.display()
            );
            return Ok(false);
        }
    };
    let mut entries = Vec::new();
    for entry in directory_entries {
        match entry {
            Ok(entry) => entries.push(entry),
            Err(e) => eprintln!("pictures: could not inspect a deduplication candidate: {e}"),
        }
    }
    entries.sort_by_key(|entry| entry.file_name());
    let destination = dir.join(name);
    for entry in entries {
        let candidate_name = entry.file_name();
        let Some(candidate_name) = candidate_name.to_str() else {
            continue;
        };
        if !is_stored_name(candidate_name)
            || candidate_name.ends_with(THUMB_SUFFIX)
            || !candidate_name.ends_with(format.extension())
        {
            continue;
        }
        let candidate = entry.path();
        let metadata = match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(e) => {
                eprintln!(
                    "pictures: could not inspect {} for deduplication: {e}",
                    candidate.display()
                );
                continue;
            }
        };
        if !metadata.file_type().is_file() || metadata.len() != data.len() as u64 {
            continue;
        }
        if let Err(e) = std::fs::hard_link(&candidate, &destination) {
            eprintln!(
                "pictures: could not link {} for deduplication: {e}",
                candidate.display()
            );
            return Ok(false);
        }
        let linked = read_verified_new_entry(&destination, data);
        if matches!(linked, Ok(true)) {
            return Ok(true);
        }
        if let Err(e) = std::fs::remove_file(&destination) {
            return Err(PictureError::Io(format!("{}: {e}", destination.display())));
        }
        match linked {
            Ok(false) => eprintln!("pictures: rejected mismatched deduplication candidate"),
            Err(e) => eprintln!("pictures: could not verify linked deduplication candidate: {e}"),
            Ok(true) => unreachable!(),
        }
    }
    Ok(false)
}

/// Read only the fresh linked entry, with one extra byte to distinguish an
/// exact match from a candidate that grew after the length filter.
#[cfg(target_os = "linux")]
fn read_verified_new_entry(path: &Path, data: &[u8]) -> std::io::Result<bool> {
    if !std::fs::symlink_metadata(path)?.file_type().is_file() {
        return Ok(false);
    }
    let mut read = Vec::with_capacity(data.len() + 1);
    std::fs::File::open(path)?
        .take(data.len() as u64 + 1)
        .read_to_end(&mut read)?;
    Ok(read.len() == data.len() && read == data)
}

/// The fallback never truncates: a rejected hard link must be gone before a
/// new exclusive destination can hold the validated source bytes.
fn write_new_original(path: &Path, data: &[u8]) -> Result<(), PictureError> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| PictureError::Io(format!("{}: {e}", path.display())))?;
    file.write_all(data)
        .map_err(|e| PictureError::Io(format!("{}: {e}", path.display())))
}

/// What to show for a member's picture: one of four states, and a thumbnail
/// only when there is one.
///
/// IT MAY WRITE, and the name does not say so on purpose being worse than the
/// comment saying so here: a missing thumbnail is REGENERATED from the original
/// rather than reported. The cache is an optimization and the original is the
/// record -- the mirror watcher's rule in another surface -- so nothing about
/// the writer's picture depends on a cache file surviving.
pub fn view(dir: &Path, stored: Option<&str>) -> PictureView {
    fn tagged(state: &str) -> PictureView {
        PictureView {
            state: state.to_string(),
            data_uri: None,
        }
    }
    let Some(name) = stored else {
        return tagged(VIEW_NONE);
    };
    // A name this application would never have written is UNREADABLE, not
    // missing: it is the one answer that is true whether or not something exists
    // at the end of it, and it is what stops a traversal being answered at all.
    if !is_stored_name(name) {
        return tagged(VIEW_UNREADABLE);
    }
    // `thumb_of` and not `thumb_name`: the gate above is the gate, and a second
    // one here would cover for it -- see `thumb_of`.
    let thumb_at = thumb_of(name);
    if let Ok(cached) = std::fs::read(dir.join(&thumb_at)) {
        return PictureView {
            state: VIEW_PRESENT.to_string(),
            data_uri: Some(format!(
                "data:{};base64,{}",
                Format::Png.mime(),
                base64(&cached)
            )),
        };
    }
    // `render_original` and not four arms restated here: `full` needs the same
    // read, the same sniff, the same decode and the same encoder at a different
    // bound, and two copies of that sequence are two places a format can be
    // added to. It assumes a validated name, which the gate above is.
    let thumb = match render_original(dir, name, THUMB_MAX) {
        Ok(bytes) => bytes,
        Err(state) => return tagged(state),
    };
    if let Err(e) = std::fs::write(dir.join(&thumb_at), &thumb) {
        eprintln!("pictures: could not cache {thumb_at}: {e}");
    }
    PictureView {
        state: VIEW_PRESENT.to_string(),
        data_uri: Some(format!(
            "data:{};base64,{}",
            Format::Png.mime(),
            base64(&thumb)
        )),
    }
}

/// Take a picture's files out of the directory, original and cache.
///
/// BEST EFFORT AND NEVER FATAL. The database row is the record and the file is
/// its consequence, so a file that will not delete is a directory that is larger
/// than it should be -- reported on stderr, exactly as a recovery point that
/// could not be pruned is, and far better than a delete that fails and leaves
/// the writer's row naming a picture they asked to remove.
///
/// A NAME THAT IS NOT ONE OF OURS DELETES NOTHING. `is_stored_name` is the same
/// gate `view` takes, so a value a foreign tool wrote into that column cannot
/// address a file this function then unlinks.
pub fn remove(dir: &Path, stored: &str) {
    let Some(thumb_at) = thumb_name(stored) else {
        eprintln!("pictures: {stored:?} is not a picture this build wrote; nothing was deleted");
        return;
    };
    for name in [stored.to_string(), thumb_at] {
        let path = dir.join(&name);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(&path) {
                eprintln!("pictures: could not delete {}: {e}", path.display());
            }
        }
    }
}

/// What a picture's HEADER says it measures, without decoding a pixel.
///
/// PURE, over bytes, so it is testable and mutatable -- `dimensions` is the
/// half that touches a filesystem and this is the half that decides. Both
/// decoders read the dimensions before any pixel storage exists, which is the
/// same step `decode` takes and stops at.
///
/// THE PIXEL CEILING APPLIES HERE TOO. A file whose header declares more than
/// this build will decode has no size worth reporting: `view` is going to answer
/// `unreadable` for it, and a figure this function handed out would be a
/// measurement of a picture nothing in the application can show.
pub fn header_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let (width, height) = match sniff(bytes)? {
        Format::Png => {
            let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
            let reader = decoder.read_info().ok()?;
            let info = reader.info();
            (info.width, info.height)
        }
        Format::Jpeg => {
            let mut decoder = zune_jpeg::JpegDecoder::new(std::io::Cursor::new(bytes));
            decoder.decode_headers().ok()?;
            let info = decoder.info()?;
            (u32::from(info.width), u32::from(info.height))
        }
    };
    checked_pixels(width, height).ok()?;
    Some((width, height))
}

/// What the stored ORIGINAL measures, or None when there is nothing readable
/// there.
///
/// THE ORIGINAL AND NOT THE THUMBNAIL, which is the whole point of the figure: a
/// cover is judged on the pixels the writer actually has, and every thumbnail in
/// this application is 256 px on its long side and would judge every cover as
/// far too small.
pub fn dimensions(dir: &Path, stored: &str) -> Option<(u32, u32)> {
    if !is_stored_name(stored) {
        return None;
    }
    header_size(&std::fs::read(dir.join(stored)).ok()?)
}

/// The original, decoded, scaled to `max` and re-encoded, or which of the two
/// broken states it is in.
///
/// IT ASSUMES A VALIDATED NAME and says so, exactly as `thumb_of` does and for
/// the same recorded reason: `view` gated with `is_stored_name` and then called
/// something that gated again, so deleting `view`'s own check survived the whole
/// suite -- two rules refusing one input cover for each other. One gate per
/// path, and the gate lives on the path.
fn render_original(dir: &Path, name: &str, max: u32) -> Result<Vec<u8>, &'static str> {
    let Ok(data) = std::fs::read(dir.join(name)) else {
        return Err(VIEW_MISSING);
    };
    let Some(format) = sniff(&data) else {
        return Err(VIEW_UNREADABLE);
    };
    let Ok(decoded) = decode(&data, format) else {
        return Err(VIEW_UNREADABLE);
    };
    encode_png(&box_scale(&decoded, max)).map_err(|_| VIEW_UNREADABLE)
}

/// A picture at `FULL_MAX`: the same four states as `view`, and a `data:` URI
/// big enough to look at.
///
/// CUT FRESH AND CACHED NOWHERE -- see `FULL_MAX`. It also never reads the
/// thumbnail cache, which would answer instantly with the 256 px picture the
/// writer pressed the control precisely because they could not see.
pub fn full(dir: &Path, stored: Option<&str>) -> PictureView {
    fn tagged(state: &str) -> PictureView {
        PictureView {
            state: state.to_string(),
            data_uri: None,
        }
    }
    let Some(name) = stored else {
        return tagged(VIEW_NONE);
    };
    if !is_stored_name(name) {
        return tagged(VIEW_UNREADABLE);
    }
    match render_original(dir, name, FULL_MAX) {
        Ok(bytes) => PictureView {
            state: VIEW_PRESENT.to_string(),
            data_uri: Some(format!(
                "data:{};base64,{}",
                Format::Png.mime(),
                base64(&bytes)
            )),
        },
        Err(state) => tagged(state),
    }
}

/// A stored picture's ORIGINAL bytes and what they are, or None.
///
/// THE BYTES THE WRITER CHOSE, NOT A RENDERING OF THEM, and it is the one read
/// in this module that is neither the thumbnail nor `full`. An EPUB carries a
/// cover as a FILE, so re-encoding it would spend the writer's resolution to
/// produce a picture nothing asked for -- and 038's bounds already cap what can
/// be in that directory at 16 MB and 50 megapixels, so there is no new ceiling
/// to argue about.
///
/// The format is SNIFFED rather than taken off the extension, for this module's
/// founding reason: the stored extension is what the sniff decided when the file
/// was attached, and a file a later hand replaced must be answered as what it
/// now is or refused.
pub fn original(dir: &Path, stored: &str) -> Option<(Format, Vec<u8>)> {
    if !is_stored_name(stored) {
        return None;
    }
    let bytes = std::fs::read(dir.join(stored)).ok()?;
    let format = sniff(&bytes)?;
    Some((format, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::{symlink, MetadataExt};
    use std::path::Path;
    use tempfile::tempdir;

    // The fixtures. Produced once with Pillow and checked in, because a picture
    // this build's own encoder wrote would check the decoder against the
    // encoder -- the recorded "a reader built from the emitter checks the
    // exporter against itself" shape. `two-halves` is 6x4, the left three
    // columns pure red and the right three pure blue, so a downscale can be
    // read by COLOUR rather than by byte count.
    const PNG: &[u8] = include_bytes!("../fixtures/two-halves.png");
    const JPEG: &[u8] = include_bytes!("../fixtures/two-halves.jpg");
    /// A 66-byte PNG whose IHDR DECLARES 30000x30000 and which carries no pixel
    /// data at all. The decompression bomb, in the smallest form that reaches
    /// the check.
    const BOMB: &[u8] = include_bytes!("../fixtures/declares-a-bomb.png");
    /// 2x1 RGBA: one opaque black pixel and one fully transparent black one.
    const ALPHA: &[u8] = include_bytes!("../fixtures/black-and-clear.png");
    /// 600x400, so it is LARGER than `THUMB_MAX` on both sides. Every other
    /// fixture here is smaller than the bound, which makes `box_scale` a no-op
    /// on all of them -- and a mutation caching a full-resolution thumbnail
    /// survived the whole suite because of it.
    const WIDE: &[u8] = include_bytes!("../fixtures/wider-than-a-thumbnail.png");
    /// 1800x1200, so it is larger than `FULL_MAX` on its long side. `WIDE` is
    /// over the THUMBNAIL bound and under the full-view one, which makes
    /// `box_scale` a no-op inside `full` for it -- 038's M23, one bound out.
    const HUGE: &[u8] = include_bytes!("../fixtures/wider-than-a-full-view.png");

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn the_pictures_directory_sits_beside_the_project_file() {
        assert_eq!(
            dir_for(Path::new("/books/the-harbour.db")),
            Path::new("/books/the-harbour.pictures")
        );
        // A path with no directory part still answers, relative to the cwd,
        // rather than panicking on `parent()`.
        assert_eq!(dir_for(Path::new("p.db")), Path::new("p.pictures"));
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn the_pictures_directory_is_not_inside_the_mirror_tree() {
        // BY CONSTRUCTION rather than by an exclusion, which is the whole
        // argument for putting it beside the store -- so it is asserted rather
        // than left as a remark. `mirror::walk_for_unmatched` reports every file
        // under the mirror root that the manifest did not write; a picture
        // directory in there is N stray reports on every open, forever.
        let data = Path::new("/data");
        let mirror = crate::projects::mirror_dir(data, None, "the-harbour");
        let pictures = dir_for(&crate::projects::library_dir(data).join("the-harbour.db"));
        assert!(
            !pictures.starts_with(&mirror),
            "{} is under {}",
            pictures.display(),
            mirror.display()
        );
    }

    #[test]
    fn a_stored_name_is_a_bare_filename_with_a_known_extension() {
        assert!(is_stored_name("0198c0de-dead.png"));
        assert!(is_stored_name("0198c0de-dead.jpg"));

        assert!(!is_stored_name(""));
        assert!(!is_stored_name("x.gif"));
        assert!(!is_stored_name("x.PNG"));
        assert!(!is_stored_name("x.png.txt"));
        assert!(!is_stored_name(".hidden.png"));
        assert!(!is_stored_name("../x.png"));
        assert!(!is_stored_name("a/b.png"));
        assert!(!is_stored_name("a\\b.png"));
        assert!(!is_stored_name("x.png\0/../y.png"));

        // ACCEPTED, and the comment in `is_stored_name` is why: `..` is only a
        // traversal when it is a whole path component, which needs a separator,
        // which is refused above. `dir.join("a..b.png")` is a file in `dir`.
        assert!(is_stored_name("a..b.png"));
    }

    #[test]
    fn a_traversing_name_cannot_reach_a_readable_picture_outside_the_directory() {
        // THE FIXTURE IS THE POINT. A refusal test whose input would also fail
        // because the file is not there proves nothing -- every path-refusal
        // test in this repo has that exposure. So a REAL, READABLE, correctly
        // formatted picture is planted exactly where the traversal points, and
        // a second one is planted inside the directory so the fixture cannot
        // pass by the directory being empty.
        let root = tempdir().unwrap();
        let dir = root.path().join("book.pictures");
        std::fs::create_dir(&dir).unwrap();
        write(root.path(), "decoy.png", PNG);
        let good = attach(&dir, &write(root.path(), "real.png", PNG)).unwrap();
        assert_eq!(view(&dir, Some(&good)).state, VIEW_PRESENT);

        let reached = view(&dir, Some("../decoy.png"));

        assert_eq!(reached.state, VIEW_UNREADABLE);
        assert_eq!(reached.data_uri, None);
    }

    #[test]
    fn a_thumbnail_name_comes_from_the_stored_name_and_a_bad_one_has_none() {
        assert_eq!(thumb_name("abc.jpg").as_deref(), Some("abc.thumb.png"));
        assert_eq!(thumb_name("abc.png").as_deref(), Some("abc.thumb.png"));
        assert_eq!(thumb_name("../abc.png"), None);
    }

    #[test]
    fn the_content_decides_the_format_and_the_extension_does_not() {
        assert_eq!(sniff(PNG), Some(Format::Png));
        assert_eq!(sniff(JPEG), Some(Format::Jpeg));
        assert_eq!(sniff(b"#!/bin/sh\nrm -rf /\n"), None);
        assert_eq!(sniff(b"\x89PN"), None);
        // EACH SIGNATURE ONE BYTE SHORT OF ITSELF, and each with a plausible
        // byte in the place the check looks at. Without these the fixtures above
        // are refused by the first byte and every later byte of both patterns is
        // asserted by nothing -- which a mutation dropping the JPEG marker's
        // third byte proved.
        assert_eq!(sniff(&[0xff, 0xd8, 0x00, 0x10]), None);
        assert_eq!(
            sniff(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x00]),
            None
        );
    }

    #[test]
    fn a_jpeg_called_png_is_stored_as_a_jpeg_and_a_script_called_png_is_refused() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");

        let stored = attach(&dir, &write(root.path(), "photo.png", JPEG)).unwrap();
        assert!(stored.ends_with(".jpg"), "{stored}");
        assert_eq!(view(&dir, Some(&stored)).state, VIEW_PRESENT);

        let refused = attach(&dir, &write(root.path(), "evil.png", b"#!/bin/sh\n"));
        assert!(matches!(refused, Err(PictureError::UnknownFormat)));
    }

    #[test]
    fn a_file_over_the_byte_ceiling_is_refused() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        // A real PNG signature in front, so the refusal cannot be the sniff.
        let mut big = PNG.to_vec();
        big.resize(MAX_PICTURE_BYTES as usize + 1, 0);

        let refused = attach(&dir, &write(root.path(), "huge.png", &big));

        assert!(
            matches!(refused, Err(PictureError::TooLarge { limit, .. }) if limit == MAX_PICTURE_BYTES),
            "{refused:?}"
        );
        // AND NOTHING WAS WRITTEN. A refusal that had already copied the file
        // would have spent the cost the ceiling exists to avoid.
        assert!(!dir.exists());
    }

    #[test]
    fn a_header_declaring_more_pixels_than_the_ceiling_is_refused() {
        // 30000 x 30000 is 900 megapixels and 2.7 GB of RGB. The file is 66
        // bytes, so no size ceiling can catch it and no decoder should be asked
        // to try -- the refusal is read off the HEADER.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");

        let refused = attach(&dir, &write(root.path(), "bomb.png", BOMB));

        assert!(
            matches!(refused, Err(PictureError::TooManyPixels { pixels, limit })
                if pixels == 900_000_000 && limit == MAX_PICTURE_PIXELS),
            "{refused:?}"
        );
    }

    #[test]
    fn the_box_filter_averages_the_source_block_and_keeps_the_aspect() {
        // 6x4, red left half and blue right half. Scaled to a longest side of 2
        // that is 2x1: one pixel per half, each the average of a 3x4 block of
        // one colour. A nearest-neighbour or a wrongly indexed filter gives a
        // different colour, not merely a different size.
        let src = Rgb {
            width: 6,
            height: 4,
            pixels: (0..24)
                .flat_map(|i| {
                    if i % 6 < 3 {
                        [255u8, 0, 0]
                    } else {
                        [0, 0, 255]
                    }
                })
                .collect(),
        };

        let out = box_scale(&src, 2);

        assert_eq!((out.width, out.height), (2, 1));
        assert_eq!(out.pixels, vec![255, 0, 0, 0, 0, 255]);
    }

    #[test]
    fn the_box_filter_averages_a_block_that_is_not_one_colour() {
        // THE TEST THAT TELLS A BOX FILTER FROM NEAREST NEIGHBOUR. Every block
        // in the fixture above is one colour, so both implementations agree
        // there and the assertion is about the aspect rather than the filter.
        // Here the two source pixels differ and the average is a colour NEITHER
        // of them is.
        let src = Rgb {
            width: 2,
            height: 1,
            pixels: vec![0, 0, 0, 254, 254, 254],
        };

        let out = box_scale(&src, 1);

        assert_eq!((out.width, out.height), (1, 1));
        assert_eq!(out.pixels, vec![127, 127, 127]);
    }

    #[test]
    fn a_transparent_pixel_is_composited_onto_white_and_not_carried_through() {
        // Two pixels: opaque black, and black at zero alpha. Carried through
        // unchanged both are black, and a picture with a transparent background
        // would render as a black rectangle in the panel. The decoder drops
        // alpha onto white -- see `Rgb` -- so the second is white.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let stored = attach(&dir, &write(root.path(), "alpha.png", ALPHA)).unwrap();

        // Read the thumbnail back rather than the decoder's own answer: what
        // matters is what reaches the panel, and the box filter sits between.
        let thumb = std::fs::read(dir.join(thumb_name(&stored).unwrap())).unwrap();
        let decoded = decode(&thumb, Format::Png).unwrap();

        assert_eq!((decoded.width, decoded.height), (2, 1));
        assert_eq!(decoded.pixels, vec![0, 0, 0, 255, 255, 255]);
    }

    #[test]
    fn the_box_filter_never_enlarges() {
        let src = Rgb {
            width: 2,
            height: 1,
            pixels: vec![1, 2, 3, 4, 5, 6],
        };

        let out = box_scale(&src, 256);

        assert_eq!(out, src);
    }

    #[test]
    fn attach_copies_the_original_bytes_verbatim_and_writes_a_thumbnail_beside_it() {
        // VERBATIM is the claim: the writer keeps their photograph, not this
        // application's re-encoding of it.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");

        let stored = attach(&dir, &write(root.path(), "photo.jpg", JPEG)).unwrap();

        assert_eq!(std::fs::read(dir.join(&stored)).unwrap(), JPEG);
        let thumb = dir.join(thumb_name(&stored).unwrap());
        assert!(thumb.exists(), "{}", thumb.display());
        // The thumbnail is a PNG regardless of what the original was, so there
        // is one encoder and one MIME type on the render path.
        assert_eq!(sniff(&std::fs::read(&thumb).unwrap()), Some(Format::Png));
    }

    #[test]
    fn the_cached_thumbnail_is_bounded_and_the_original_beside_it_is_not() {
        // THE MEMORY RULE, AND NOTHING ELSE HERE ASSERTED IT. What crosses to
        // the page is this file, and a full-resolution copy cached under a name
        // called "thumb" is the whole defect: `peak_rss_mb` sums the webview,
        // and one 4000x3000 photograph decoded is ~48 MB of a 750 MB budget.
        //
        // A mutation dropping `box_scale` from `attach` SURVIVED the first
        // pass, because every other fixture in this file is smaller than
        // THUMB_MAX and the filter is a no-op on all of them.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");

        let stored = attach(&dir, &write(root.path(), "wide.png", WIDE)).unwrap();

        let thumb = decode(
            &std::fs::read(dir.join(thumb_name(&stored).unwrap())).unwrap(),
            Format::Png,
        )
        .unwrap();
        assert_eq!((thumb.width, thumb.height), (THUMB_MAX, 170));
        // AND THE ORIGINAL IS UNTOUCHED beside it, at its own size, which is
        // the other half of the claim: the writer keeps their photograph and
        // this application keeps a thumbnail of it.
        assert_eq!(std::fs::read(dir.join(&stored)).unwrap(), WIDE);
        let original = decode(WIDE, Format::Png).unwrap();
        assert_eq!((original.width, original.height), (600, 400));
    }

    #[test]
    fn duplicate_attachments_have_independent_names_and_original_bytes() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let source = write(root.path(), "photo.jpg", JPEG);

        let a = attach(&dir, &source).unwrap();
        let b = attach(&dir, &source).unwrap();

        assert_ne!(a, b);
        assert_eq!(std::fs::read(dir.join(&a)).unwrap(), JPEG);
        assert_eq!(std::fs::read(dir.join(&b)).unwrap(), JPEG);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn duplicate_attachments_share_original_bytes_but_keep_source_and_caches_independent() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let source = write(root.path(), "photo.jpg", JPEG);
        let a = attach(&dir, &source).unwrap();
        let b = attach(&dir, &source).unwrap();

        assert_eq!(
            std::fs::metadata(dir.join(&a)).unwrap().ino(),
            std::fs::metadata(dir.join(&b)).unwrap().ino()
        );
        assert_ne!(
            std::fs::metadata(&source).unwrap().ino(),
            std::fs::metadata(dir.join(&a)).unwrap().ino()
        );
        assert_ne!(
            std::fs::metadata(dir.join(thumb_of(&a))).unwrap().ino(),
            std::fs::metadata(dir.join(thumb_of(&b))).unwrap().ino()
        );

        remove(&dir, &a);
        assert_eq!(std::fs::read(dir.join(&b)).unwrap(), JPEG);
        assert_eq!(view(&dir, Some(&b)).state, VIEW_PRESENT);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_same_length_different_candidate_does_not_hide_a_later_exact_candidate() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        std::fs::create_dir_all(&dir).unwrap();
        let source_bytes = encode_png(&Rgb {
            width: 1,
            height: 1,
            pixels: vec![1, 2, 3],
        })
        .unwrap();
        let different = encode_png(&Rgb {
            width: 1,
            height: 1,
            pixels: vec![4, 5, 6],
        })
        .unwrap();
        assert_eq!(source_bytes.len(), different.len());
        let rejected = dir.join("a-mismatch.png");
        let exact = dir.join("z-exact.png");
        std::fs::write(&rejected, &different).unwrap();
        std::fs::write(&exact, &source_bytes).unwrap();

        let stored = attach(&dir, &write(root.path(), "source.png", &source_bytes)).unwrap();

        assert_eq!(std::fs::read(&rejected).unwrap(), different);
        assert_eq!(
            std::fs::metadata(dir.join(&stored)).unwrap().ino(),
            std::fs::metadata(&exact).unwrap().ino()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn thumbnails_and_symlinks_are_not_deduplication_candidates() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        std::fs::create_dir_all(&dir).unwrap();
        let thumbnail = dir.join("ignored.thumb.png");
        std::fs::write(&thumbnail, PNG).unwrap();
        let source = write(root.path(), "outside.png", PNG);
        symlink(&source, dir.join("ignored-link.png")).unwrap();

        let stored = attach(&dir, &source).unwrap();

        assert_ne!(
            std::fs::metadata(dir.join(&stored)).unwrap().ino(),
            std::fs::metadata(&thumbnail).unwrap().ino()
        );
        assert_ne!(
            std::fs::metadata(dir.join(&stored)).unwrap().ino(),
            std::fs::metadata(&source).unwrap().ino()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn exclusive_copy_refuses_an_existing_hard_link_without_changing_its_original() {
        let root = tempdir().unwrap();
        let source = write(root.path(), "source.png", PNG);
        let destination = root.path().join("destination.png");
        std::fs::hard_link(&source, &destination).unwrap();

        assert!(write_new_original(&destination, JPEG).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), PNG);
        assert_eq!(std::fs::read(&destination).unwrap(), PNG);
    }

    #[test]
    fn a_view_of_nothing_is_none_and_carries_no_data() {
        let root = tempdir().unwrap();
        assert_eq!(
            view(root.path(), None),
            PictureView {
                state: VIEW_NONE.to_string(),
                data_uri: None,
            }
        );
    }

    #[test]
    fn a_view_of_a_file_that_is_gone_says_missing() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let stored = attach(&dir, &write(root.path(), "photo.png", PNG)).unwrap();
        std::fs::remove_file(dir.join(&stored)).unwrap();
        std::fs::remove_file(dir.join(thumb_name(&stored).unwrap())).unwrap();

        let seen = view(&dir, Some(&stored));

        assert_eq!(seen.state, VIEW_MISSING);
        assert_eq!(seen.data_uri, None);
    }

    #[test]
    fn a_view_of_bytes_that_are_not_a_picture_says_unreadable() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.png"), b"this is not a picture").unwrap();

        let seen = view(&dir, Some("x.png"));

        assert_eq!(seen.state, VIEW_UNREADABLE);
        assert_eq!(seen.data_uri, None);
    }

    #[test]
    fn a_deleted_thumbnail_is_regenerated_rather_than_reported_as_damage() {
        // THE CACHE IS AN OPTIMIZATION AND THE ORIGINAL IS THE RECORD, which is
        // the mirror watcher's rule in another surface. A writer who cleared
        // their picture directory of everything they did not recognise must not
        // thereby lose the picture they DO have.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let stored = attach(&dir, &write(root.path(), "photo.png", PNG)).unwrap();
        let thumb = dir.join(thumb_name(&stored).unwrap());
        std::fs::remove_file(&thumb).unwrap();

        let seen = view(&dir, Some(&stored));

        assert_eq!(seen.state, VIEW_PRESENT);
        assert!(seen.data_uri.unwrap().starts_with("data:image/png;base64,"));
        assert!(thumb.exists(), "the regenerated thumbnail was not kept");
    }

    #[test]
    fn a_present_view_carries_the_thumbnail_and_never_the_original() {
        // The whole memory rule, asserted rather than argued: what crosses to
        // the page is the CACHE, so a page holding a data URI holds kilobytes
        // rather than a decoded photograph.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let stored = attach(&dir, &write(root.path(), "photo.jpg", JPEG)).unwrap();
        let thumb = std::fs::read(dir.join(thumb_name(&stored).unwrap())).unwrap();

        let seen = view(&dir, Some(&stored));

        assert_eq!(seen.state, VIEW_PRESENT);
        assert_eq!(
            seen.data_uri.unwrap(),
            format!("data:image/png;base64,{}", base64(&thumb))
        );
    }

    #[test]
    fn remove_takes_the_original_and_the_thumbnail_and_leaves_the_rest() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let gone = attach(&dir, &write(root.path(), "a.png", PNG)).unwrap();
        let kept = attach(&dir, &write(root.path(), "b.png", PNG)).unwrap();

        remove(&dir, &gone);

        assert!(!dir.join(&gone).exists());
        assert!(!dir.join(thumb_name(&gone).unwrap()).exists());
        assert!(dir.join(&kept).exists());
        assert!(dir.join(thumb_name(&kept).unwrap()).exists());
    }

    #[test]
    fn remove_of_a_name_that_is_not_ours_touches_nothing() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let kept = attach(&dir, &write(root.path(), "a.png", PNG)).unwrap();
        write(root.path(), "decoy.png", PNG);

        remove(&dir, "../decoy.png");

        assert!(root.path().join("decoy.png").exists());
        assert!(dir.join(&kept).exists());
    }

    #[test]
    fn the_header_says_what_a_picture_measures_without_decoding_a_pixel() {
        assert_eq!(header_size(WIDE), Some((600, 400)));
        assert_eq!(header_size(PNG), Some((6, 4)));
        // A JPEG as well, so neither arm is the one that happens to be read.
        assert_eq!(header_size(JPEG), Some((6, 4)));
        assert_eq!(header_size(b"#!/bin/sh\n"), None);
    }

    #[test]
    fn a_header_declaring_more_pixels_than_the_ceiling_reports_no_size() {
        // The bomb again, one function further out: a file this build will not
        // decode has no size worth reporting, because `view` is going to answer
        // `unreadable` for it and a figure handed out here would measure a
        // picture nothing in the application can show.
        assert_eq!(header_size(BOMB), None);
    }

    #[test]
    fn the_measured_size_is_the_originals_and_not_the_thumbnails() {
        // THE WHOLE POINT OF THE FIGURE. Every thumbnail in this application is
        // 256 px on its long side, so a `dimensions` that read the cache would
        // judge every cover in every book as far too small for print.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let stored = attach(&dir, &write(root.path(), "wide.png", WIDE)).unwrap();
        // The cache exists and is 256 px wide, which is what makes this test
        // able to fail.
        let cached = decode(
            &std::fs::read(dir.join(thumb_name(&stored).unwrap())).unwrap(),
            Format::Png,
        )
        .unwrap();
        assert_eq!(cached.width, THUMB_MAX);

        assert_eq!(dimensions(&dir, &stored), Some((600, 400)));
    }

    #[test]
    fn a_name_that_is_not_ours_measures_nothing_and_reaches_no_file() {
        // The fixture is the point, `a_traversing_name_cannot_reach_a_readable_
        // picture_outside_the_directory`'s rule: a REAL, readable, correctly
        // formatted picture is planted exactly where the traversal points.
        let root = tempdir().unwrap();
        let dir = root.path().join("book.pictures");
        std::fs::create_dir(&dir).unwrap();
        write(root.path(), "decoy.png", WIDE);

        assert_eq!(dimensions(&dir, "../decoy.png"), None);
    }

    #[test]
    fn a_full_view_is_bigger_than_the_thumbnail_and_is_still_bounded() {
        // THE MEMORY RULE AT THE SECOND BOUND. `wider-than-a-thumbnail` is
        // 600x400 -- over THUMB_MAX and UNDER FULL_MAX -- so with that fixture
        // alone `box_scale` is a no-op inside `full` and a mutation deleting the
        // bound survives. That is 038's own M23 one bound further out, which is
        // why this fixture is 1800x1200.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let stored = attach(&dir, &write(root.path(), "big.png", HUGE)).unwrap();

        let seen = full(&dir, Some(&stored));

        assert_eq!(seen.state, VIEW_PRESENT);
        let uri = seen
            .data_uri
            .expect("a present full view carries a picture");
        let prefix = "data:image/png;base64,";
        assert!(
            uri.starts_with(prefix),
            "{}",
            &uri[..prefix.len().min(uri.len())]
        );
        let bytes = decode_base64(&uri[prefix.len()..]);
        let shown = decode(&bytes, Format::Png).unwrap();
        assert_eq!((shown.width, shown.height), (FULL_MAX, 1066));
        // AND IT IS THE PICTURE and not a stretched thumbnail: the left half is
        // black and the right half white, which says the arithmetic did not
        // lose the image while the size above says which bound it used.
        assert_eq!(&shown.pixels[..3], &[0, 0, 0]);
        let last = shown.pixels.len() - 3;
        assert_eq!(&shown.pixels[last..], &[255, 255, 255]);
    }

    #[test]
    fn a_full_view_caches_nothing_beside_the_picture() {
        // The other half of `FULL_MAX`'s claim: a rare read must not double what
        // a picture costs on disk. Exactly two files exist afterwards -- the
        // original and the thumbnail `attach` wrote.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let stored = attach(&dir, &write(root.path(), "big.png", HUGE)).unwrap();
        let before = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(before, 2, "attach writes the original and the thumbnail");

        assert_eq!(full(&dir, Some(&stored)).state, VIEW_PRESENT);

        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), before);
    }

    #[test]
    fn a_full_view_does_not_answer_out_of_the_thumbnail_cache() {
        // A `full` that read the cache would answer instantly with the 256 px
        // picture the writer pressed the control precisely because they could
        // not see. Removing the ORIGINAL and leaving the cache makes the two
        // implementations answer differently, which no fixture with both files
        // present can do.
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        let stored = attach(&dir, &write(root.path(), "wide.png", WIDE)).unwrap();
        std::fs::remove_file(dir.join(&stored)).unwrap();
        assert!(dir.join(thumb_name(&stored).unwrap()).exists());

        assert_eq!(full(&dir, Some(&stored)).state, VIEW_MISSING);
    }

    #[test]
    fn a_full_view_answers_the_same_four_states_as_the_panels() {
        let root = tempdir().unwrap();
        let dir = root.path().join("p.pictures");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(full(&dir, None).state, VIEW_NONE);
        assert_eq!(full(&dir, Some("gone.png")).state, VIEW_MISSING);
        std::fs::write(dir.join("x.png"), b"this is not a picture").unwrap();
        assert_eq!(full(&dir, Some("x.png")).state, VIEW_UNREADABLE);
    }

    #[test]
    fn a_full_view_of_a_traversing_name_cannot_reach_a_readable_picture() {
        // ITS OWN GATE, and the fixture that makes the gate falsifiable. `view`
        // has this test and `full` needs its own: a gate deleted from one path
        // is invisible while the other path still refuses the same input, which
        // is the recorded shape a mutation is the only thing that sees.
        let root = tempdir().unwrap();
        let dir = root.path().join("book.pictures");
        std::fs::create_dir(&dir).unwrap();
        write(root.path(), "decoy.png", PNG);
        let good = attach(&dir, &write(root.path(), "real.png", PNG)).unwrap();
        assert_eq!(full(&dir, Some(&good)).state, VIEW_PRESENT);

        let reached = full(&dir, Some("../decoy.png"));

        assert_eq!(reached.state, VIEW_UNREADABLE);
        assert_eq!(reached.data_uri, None);
    }

    /// RFC 4648 decoding, for the tests alone: a test that read a picture back
    /// through this file's own `base64` would be checking the encoder against
    /// itself, which is the recorded reader-built-from-the-emitter shape.
    fn decode_base64(text: &str) -> Vec<u8> {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut acc: u32 = 0;
        let mut bits = 0;
        for c in text.bytes() {
            if c == b'=' {
                break;
            }
            let v = ALPHABET
                .iter()
                .position(|a| *a == c)
                .expect("a base64 character") as u32;
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn base64_matches_the_known_encoding_including_its_padding() {
        // RFC 4648 section 10's own vectors, which is the only ground truth
        // worth having for an encoder written here.
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // The two characters that separate base64 from base64url, over the
        // byte pair that produces them.
        assert_eq!(base64(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn the_original_bytes_come_back_as_they_were_stored() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("in.png");
        std::fs::write(&source, PNG).unwrap();
        let store = dir.path().join("pics");
        std::fs::create_dir_all(&store).unwrap();
        let name = attach(&store, &source).unwrap();
        let (format, bytes) = original(&store, &name).unwrap();
        assert_eq!(format, Format::Png);
        assert_eq!(bytes, PNG);
    }

    #[test]
    fn an_original_is_refused_for_a_name_this_application_would_not_have_written() {
        // `is_stored_name`'s gate on this path too, and its OWN test rather
        // than a claim: this is the third caller that joins a name out of the
        // file to a directory, and the recorded defect was two callers covering
        // for each other's check.
        // THE FILE MUST ACTUALLY BE THERE, and the first draft's was not --
        // so deleting the gate SURVIVED: an ungated read of a name pointing at
        // nothing fails at the filesystem and answers None for the wrong
        // reason. The recorded shape where two rules refuse the same input and
        // cover for each other, third instance in this module.
        let dir = tempdir().unwrap();
        let store = dir.path().join("pictures");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(dir.path().join("secret.png"), PNG).unwrap();
        assert!(original(&store, "../secret.png").is_none());
        // The control: the SAME bytes under a name this application would have
        // written are read, so the refusal above is about the name.
        std::fs::write(store.join("0198c0de-0000-7000-8000-000000000001.png"), PNG).unwrap();
        assert!(original(&store, "0198c0de-0000-7000-8000-000000000001.png").is_some());
    }

    #[test]
    fn an_original_that_is_no_longer_a_picture_is_refused_rather_than_carried() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.png"), b"not a picture at all").unwrap();
        assert!(original(dir.path(), "a.png").is_none());
    }
}
