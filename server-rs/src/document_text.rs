//! Best-effort extraction of supported document text into atomic sidecars.
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_INPUT: u64 = 16 * 1024 * 1024;
const MAX_OUTPUT: usize = 1_000_000;
const TRUNCATED: &str = "\n\n[Extracted text truncated at document extraction limits.]";
#[derive(Default)]
struct State {
    active: usize,
    running: std::collections::HashSet<PathBuf>,
    failures: HashMap<PathBuf, Option<Instant>>,
    order: VecDeque<PathBuf>,
}
fn state() -> &'static (Mutex<State>, Condvar) {
    static STATE: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(State::default()), Condvar::new()))
}
fn sidecar(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".txt");
    s.into()
}

/// Never fails the enclosing upload or dispatch when extraction fails.
pub fn ensure(path: &Path) -> Option<PathBuf> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ![
        "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "epub", "ipynb",
    ]
    .contains(&ext.as_str())
    {
        return None;
    }
    let dest = sidecar(path);
    if dest.is_file() {
        return Some(dest);
    }
    if fs::metadata(path).ok()?.len() > MAX_INPUT {
        return None;
    }
    let (lock, cv) = state();
    let mut s = lock.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if dest.is_file() {
            return Some(dest);
        }
        if let Some(until) = s.failures.get(path) {
            if until.is_none_or(|t| t > Instant::now()) {
                return None;
            }
        }
        if s.active < 2 && !s.running.contains(path) {
            break;
        }
        s = cv.wait(s).unwrap_or_else(|e| e.into_inner());
    }
    s.active += 1;
    s.running.insert(path.to_owned());
    drop(s);
    let result = run_worker(path, &ext).and_then(|text| {
        let mut temp = dest.as_os_str().to_owned();
        temp.push(format!(".{}.part", uuid::Uuid::new_v4()));
        let temp = PathBuf::from(temp);
        let result = fs::write(&temp, text).and_then(|_| fs::rename(&temp, &dest));
        let _ = fs::remove_file(temp);
        result.map_err(|_| false)
    });
    let mut s = lock.lock().unwrap_or_else(|e| e.into_inner());
    s.active -= 1;
    s.running.remove(path);
    if let Err(permanent) = result {
        s.failures.insert(
            path.to_owned(),
            if permanent {
                None
            } else {
                Some(Instant::now() + Duration::from_secs(1))
            },
        );
        s.order.retain(|p| p != path);
        s.order.push_back(path.to_owned());
        while s.order.len() > 1024 {
            if let Some(old) = s.order.pop_front() {
                s.failures.remove(&old);
            }
        }
    }
    cv.notify_all();
    if result.is_ok() {
        Some(dest)
    } else {
        None
    }
}
// The parser runs in a child so malformed documents cannot stall the server.
#[cfg(not(test))]
fn run_worker(path: &Path, ext: &str) -> Result<String, bool> {
    use std::{
        process::{Command, Stdio},
        thread,
    };
    let output_path =
        std::env::temp_dir().join(format!("t3-document-{}.out", uuid::Uuid::new_v4()));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .map_err(|_| false)?;
    let mut command = Command::new(std::env::current_exe().map_err(|_| false)?);
    command
        .arg("__document-text")
        .arg(path)
        .arg(format!(".{ext}"))
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                let limit = libc::rlimit {
                    rlim_cur: 192 * 1024 * 1024,
                    rlim_max: 192 * 1024 * 1024,
                };
                if libc::setrlimit(libc::RLIMIT_AS, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let result = (|| {
        let mut child = command.spawn().map_err(|_| false)?;
        let start = Instant::now();
        loop {
            if fs::metadata(&output_path).map_err(|_| false)?.len() > 4 * 1024 * 1024 + 1024
                || start.elapsed() >= Duration::from_secs(15)
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err(false);
            }
            if let Some(status) = child.try_wait().map_err(|_| false)? {
                if !status.success() {
                    return Err(status.code() == Some(2));
                }
                let bytes = fs::read(&output_path).map_err(|_| false)?;
                if bytes.len() > 4 * 1024 * 1024 + 1024 {
                    return Err(false);
                }
                return String::from_utf8(bytes).map_err(|_| false);
            }
            thread::sleep(Duration::from_millis(10));
        }
    })();
    let _ = fs::remove_file(output_path);
    result
}
#[cfg(test)]
fn run_worker(path: &Path, ext: &str) -> Result<String, bool> {
    extract(path, ext)
}

/// Entry point for the hidden document worker. Error true means a permanent rejection.
pub fn worker(path: &Path, extension: &str) -> Result<String, bool> {
    let ext = extension.strip_prefix('.').ok_or(true)?;
    if ![
        "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "epub", "ipynb",
    ]
    .contains(&ext)
    {
        return Err(true);
    }
    extract(path, ext)
}
fn extract(path: &Path, ext: &str) -> Result<String, bool> {
    let meta = fs::metadata(path).map_err(|_| false)?;
    if meta.len() > MAX_INPUT {
        return Ok(TRUNCATED.trim_start().to_owned());
    }
    if ext == "rtf" {
        return extract_rtf(path);
    }
    if ext != "ipynb" {
        return extract_archive(path, ext);
    }
    let data = fs::read(path).map_err(|_| false)?;
    let json: serde_json::Value = serde_json::from_slice(&data).map_err(|_| true)?;
    let cells = json.get("cells").and_then(|v| v.as_array()).ok_or(true)?;
    let mut out = String::new();
    let mut truncated = false;
    fn content(v: &serde_json::Value) -> String {
        if let Some(s) = v.as_str() {
            s.to_owned()
        } else if let Some(a) = v.as_array() {
            a.iter().filter_map(|v| v.as_str()).collect()
        } else {
            String::new()
        }
    }
    let ansi = regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap();
    for (i, cell) in cells.iter().enumerate() {
        if i == 10_000 {
            truncated = true;
            break;
        }
        let cell_kind = match cell["cell_type"].as_str() {
            Some("code") => "code",
            Some("raw") => "raw",
            _ => "markdown",
        };
        out.push_str(&format!("## Cell {} ({cell_kind})\n", i + 1));
        out.push_str(&content(&cell["source"]));
        if let Some(outputs) = cell["outputs"].as_array() {
            out.push_str("\nOutput:\n");
            for item in outputs {
                if !item["text"].is_null() {
                    out.push_str(&ansi.replace_all(&content(&item["text"]), ""));
                } else if !item["data"]["text/plain"].is_null() {
                    out.push_str(&ansi.replace_all(&content(&item["data"]["text/plain"]), ""));
                } else if item["output_type"] == "error" {
                    out.push_str(item["ename"].as_str().unwrap_or(""));
                    out.push_str(": ");
                    out.push_str(item["evalue"].as_str().unwrap_or(""));
                    out.push('\n');
                    if let Some(lines) = item["traceback"].as_array() {
                        for line in lines {
                            out.push_str(&ansi.replace_all(line.as_str().unwrap_or(""), ""));
                            out.push('\n');
                        }
                    }
                }
                out.push('\n');
            }
        }
        out.push_str("\n\n");
        if out.len() >= MAX_OUTPUT && out.chars().count() >= MAX_OUTPUT {
            truncated = true;
            break;
        }
    }
    if out.len() >= MAX_OUTPUT && out.chars().count() >= MAX_OUTPUT {
        out = out.chars().take(MAX_OUTPUT).collect();
        truncated = true;
    }
    let out = out.replace('\0', "");
    let re = regex::Regex::new(r"\n(?:[ \t]*\n){2,}").unwrap();
    let mut out = re.replace_all(&out, "\n\n").trim().to_owned();
    if truncated {
        out.push_str(TRUNCATED);
    }
    if out.is_empty() {
        Err(true)
    } else {
        Ok(out)
    }
}

fn extract_rtf(path: &Path) -> Result<String, bool> {
    let data = fs::read(path).map_err(|_| false)?;
    if !data.starts_with(b"{\\rtf") {
        return Err(true);
    }
    let mut out = String::new();
    let mut stack = Vec::new();
    let (mut skip, mut deleted, mut uc, mut fallback) = (false, false, 1usize, 0usize);
    let mut encoding = encoding_rs::WINDOWS_1252;
    let mut i = 0usize;
    let mut truncated = false;
    while i < data.len() {
        let c = data[i];
        i += 1;
        match c {
            b'{' => {
                if stack.len() >= 128 {
                    truncated = true;
                    break;
                }
                stack.push((skip, deleted, uc));
            }
            b'}' => {
                if let Some((s, d, u)) = stack.pop() {
                    skip = s;
                    deleted = d;
                    uc = u;
                } else {
                    return Err(true);
                }
            }
            b'\\' if i < data.len() => {
                let c = data[i];
                i += 1;
                if c.is_ascii_alphabetic() {
                    let start = i - 1;
                    while i < data.len() && data[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    let word = &data[start..i];
                    let start_num = i;
                    if i < data.len() && data[i] == b'-' {
                        i += 1;
                    }
                    while i < data.len() && data[i].is_ascii_digit() {
                        i += 1;
                    }
                    let num = std::str::from_utf8(&data[start_num..i])
                        .ok()
                        .and_then(|s| s.parse::<i32>().ok());
                    if i < data.len() && data[i] == b' ' {
                        i += 1;
                    }
                    if matches!(
                        word,
                        b"fonttbl"
                            | b"colortbl"
                            | b"stylesheet"
                            | b"info"
                            | b"pict"
                            | b"object"
                            | b"fldinst"
                            | b"header"
                            | b"headerf"
                            | b"headerl"
                            | b"headerr"
                            | b"footer"
                            | b"footerf"
                            | b"footerl"
                            | b"footerr"
                    ) {
                        skip = true;
                    }
                    if word == b"deleted" {
                        deleted = num != Some(0);
                    } else if word == b"plain" {
                        deleted = false;
                    }
                    if word == b"uc" {
                        uc = num.filter(|n| *n >= 0).ok_or(true)? as usize;
                    }
                    if word == b"mac" || (word == b"ansicpg" && num == Some(10000)) {
                        encoding = encoding_rs::MACINTOSH;
                    } else if word == b"ansicpg" && !matches!(num, Some(874 | 1250..=1258)) {
                        return Err(true);
                    } else if word == b"ansicpg" {
                        let label = format!("windows-{}", num.ok_or(true)?);
                        encoding =
                            encoding_rs::Encoding::for_label(label.as_bytes()).ok_or(true)?;
                    }
                    if word == b"bin" {
                        let n = num.filter(|n| *n >= 0).ok_or(true)? as usize;
                        i = i.checked_add(n).filter(|n| *n <= data.len()).ok_or(true)?;
                    } else if word == b"u" {
                        if !(skip || deleted) {
                            if let Some(ch) = num.and_then(|n| char::from_u32((n as u16) as u32)) {
                                out.push(ch);
                            }
                        }
                        fallback = uc;
                    } else if fallback > 0 {
                        fallback -= 1;
                    } else {
                        let hidden = skip || deleted;
                        if !hidden && matches!(word, b"par" | b"line" | b"sect" | b"page" | b"column") {
                            out.push('\n');
                        } else if !hidden && word == b"tab" {
                            out.push('\t');
                        } else if !skip && word == b"row" {
                            out.push('\n');
                        } else if !skip && word == b"cell" {
                            out.push('\t');
                        } else if !hidden {
                            match word {
                                b"endash" => out.push('–'),
                                b"emdash" => out.push('—'),
                                b"enspace" => out.push('\u{2002}'),
                                b"emspace" => out.push('\u{2003}'),
                                b"qmspace" => out.push('\u{2005}'),
                                b"lquote" => out.push('‘'),
                                b"rquote" => out.push('’'),
                                b"ldblquote" => out.push('“'),
                                b"rdblquote" => out.push('”'),
                                b"bullet" => out.push('•'),
                                _ => {}
                            }
                        }
                    }
                } else {
                    let mut ch = match c {
                        b'\\' | b'{' | b'}' => Some(c as char),
                        b'~' => Some('\u{a0}'),
                        b'_' => Some('\u{2011}'),
                        b'\n' | b'\r' => Some('\n'),
                        b'*' => {
                            skip = true;
                            None
                        }
                        _ => None,
                    };
                    if c == b'\'' {
                        if i + 2 > data.len() {
                            return Err(true);
                        }
                        let hex = std::str::from_utf8(&data[i..i + 2]).map_err(|_| true)?;
                        let byte = u8::from_str_radix(hex, 16).map_err(|_| true)?;
                        let bytes = [byte];
                        let (decoded, _, _) = encoding.decode(&bytes);
                        ch = decoded.chars().next();
                        i += 2;
                    }
                    if c == b'\r' && data.get(i) == Some(&b'\n') {
                        i += 1;
                    }
                    if fallback > 0 {
                        fallback -= 1;
                    } else if !(skip || deleted) {
                        if let Some(ch) = ch {
                            out.push(ch);
                        }
                    }
                }
            }
            b'\r' | b'\n' => {}
            _ => {
                if fallback > 0 {
                    fallback -= 1;
                } else if !(skip || deleted) {
                    let bytes = [c];
                    let (decoded, _, _) = encoding.decode(&bytes);
                    out.push_str(&decoded);
                }
            }
        }
        if out.len() >= MAX_OUTPUT && out.chars().count() >= MAX_OUTPUT {
            out = out.chars().take(MAX_OUTPUT).collect();
            truncated = true;
            break;
        }
    }
    let out = out.replace('\0', "");
    let re = regex::Regex::new(r"\n(?:[ \t]*\n){2,}").unwrap();
    let mut out = re.replace_all(&out, "\n\n").trim().to_owned();
    if truncated {
        out.push_str(TRUNCATED);
    }
    if out.is_empty() {
        Err(true)
    } else {
        Ok(out)
    }
}

// Bound both archive metadata and actual decompression; never extract archive paths to disk.
fn extract_archive(path: &Path, ext: &str) -> Result<String, bool> {
    let file = fs::File::open(path).map_err(|_| false)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| true)?;
    if zip.len() > 2048 {
        return Ok(TRUNCATED.trim_start().to_owned());
    }
    let mut names = Vec::new();
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|_| true)?;
        let n = f.name().to_owned();
        let selected = match ext {
            "docx" => n == "word/document.xml",
            "odt" | "ods" | "odp" => n == "content.xml",
            "pptx" => {
                n.strip_prefix("ppt/slides/slide")
                    .and_then(|name| name.strip_suffix(".xml"))
                    .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
            }
            "xlsx" => n.starts_with("xl/worksheets/sheet") && n.ends_with(".xml"),
            "epub" => n.ends_with(".xhtml") || n.ends_with(".html") || n.ends_with(".htm"),
            _ => false,
        };
        if selected {
            names.push(n);
        }
    }
    names.sort_by(|a, b| natural_cmp(a, b));
    let mut labels: HashMap<String, String> = HashMap::new();
    let mut slide_notes: HashMap<String, String> = HashMap::new();
    let mut styles = Vec::new();
    let mut date_system = "1900";
    if ext == "pptx" {
        if let (Some(presentation), Some(rels)) = (
            read_part(&mut zip, "ppt/presentation.xml"),
            read_part(&mut zip, "ppt/_rels/presentation.xml.rels"),
        ) {
            let relationships = relationship_targets(&rels);
            names = xml_attributes_at(&presentation, b"sldId", Some(&[b"presentation", b"sldIdLst"]))
                .into_iter()
                .filter_map(|a| {
                    relationships
                        .get(a.get("r:id")?)
                        .map(|t| archive_path("ppt", t))
                })
                .collect();
            for name in &names {
                let (base, filename) = name.rsplit_once('/').unwrap_or(("", name));
                let rel_path = format!("{base}/_rels/{filename}.rels");
                if let Some(rels) = read_part(&mut zip, &rel_path) {
                    if let Some(target) = xml_attributes(&rels, b"Relationship")
                        .into_iter()
                        .find(|a| {
                            a.get("Type").is_some_and(|t| t.ends_with("/notesSlide"))
                                && a.get("TargetMode").is_none_or(|v| v != "External")
                        })
                        .and_then(|a| a.get("Target").cloned())
                    {
                        slide_notes.insert(name.clone(), archive_path(base, &target));
                    }
                }
            }
        }
    }
    if ext == "xlsx" {
        if let (Some(workbook), Some(rels)) = (
            read_part(&mut zip, "xl/workbook.xml"),
            read_part(&mut zip, "xl/_rels/workbook.xml.rels"),
        ) {
            let relationships = relationship_targets(&rels);
            if xml_attributes(&workbook, b"workbookPr")
                .first()
                .and_then(|a| a.get("date1904"))
                .is_some_and(|v| v == "1" || v == "true")
            {
                date_system = "1904";
            }
            let sheets = xml_attributes(&workbook, b"sheet");
            names.clear();
            for attrs in sheets {
                if let (Some(name), Some(id)) = (attrs.get("name"), attrs.get("r:id")) {
                    if let Some(target) = relationships.get(id) {
                        let path = archive_path("xl", target);
                        labels.insert(path.clone(), name.clone());
                        names.push(path);
                    }
                }
            }
        }
    } else if ext == "epub" {
        if let Some(container) = read_part(&mut zip, "META-INF/container.xml") {
            if let Some(package) = xml_attributes(&container, b"rootfile")
                .first()
                .and_then(|a| a.get("full-path"))
                .cloned()
            {
                if let Some(opf) = read_part(&mut zip, &package) {
                    let manifest: HashMap<_, _> = xml_attributes(&opf, b"item")
                        .into_iter()
                        .filter_map(|a| Some((a.get("id")?.clone(), a.get("href")?.clone())))
                        .collect();
                    let base = package.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
                    names = xml_attributes(&opf, b"itemref")
                        .into_iter()
                        .filter_map(|a| {
                            let href = manifest.get(a.get("idref")?)?.split('#').next()?;
                            let decoded = percent_encoding::percent_decode_str(href)
                                .decode_utf8()
                                .ok()?;
                            Some(archive_path(base, &decoded))
                        })
                        .collect();
                }
            }
        }
    }
    if names.is_empty() {
        return Err(true);
    }
    if ext == "xlsx" {
        if let Some(bytes) = read_part(&mut zip, "xl/styles.xml") {
            styles = xlsx_styles(&bytes);
        }
    }
    let mut shared = Vec::new();
    if ext == "xlsx" {
        if let Ok(mut f) = zip.by_name("xl/sharedStrings.xml") {
            if f.size() > 32 * 1024 * 1024
                || f.size() > f.compressed_size().saturating_mul(200).max(1024)
            {
                return Ok(TRUNCATED.trim_start().to_owned());
            }
            let mut bytes = Vec::new();
            f.read_to_end(&mut bytes).map_err(|_| true)?;
            shared = xlsx_shared(&bytes).map_err(|_| true)?;
        }
    }
    let mut out = String::new();
    let mut expanded = 0u64;
    let mut truncated = false;
    for (i, name) in names.iter().enumerate() {
        let mut f = match zip.by_name(name) {
            Ok(f) => f,
            Err(_) => {
                out.push_str(&format!(
                    "\n[Skipped document part: {} (missing or invalid XML).]\n",
                    name
                ));
                continue;
            }
        };
        let size = f.size();
        if size > 32 * 1024 * 1024
            || size > f.compressed_size().saturating_mul(200).max(1024)
            || expanded.saturating_add(size) > 32 * 1024 * 1024
        {
            truncated = true;
            break;
        }
        expanded += size;
        let mut bytes = Vec::new();
        (&mut f)
            .take(size + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| true)?;
        if bytes.len() as u64 > size {
            truncated = true;
            break;
        }
        drop(f);
        if ext == "pptx" {
            out.push_str(&format!("\n\n## Slide {}\n", i + 1));
        }
        if ext == "epub" {
            out.push_str(&format!("\n\n## Chapter {}\n", i + 1));
        }
        if ext == "xlsx" {
            out.push_str(&format!(
                "\n## Sheet: {}\n",
                labels
                    .get(name)
                    .cloned()
                    .unwrap_or_else(|| (i + 1).to_string())
            ));
        }
        let parsed = if ext == "xlsx" {
            xlsx_sheet(&bytes, &shared, &styles, date_system, &mut out)
        } else {
            xml_text_with_kind(&bytes, &mut out, matches!(ext, "odt" | "ods" | "odp"))
        };
        match parsed {
            Ok(limited) => {
                if limited {
                    truncated = true;
                    break;
                }
            }
            Err(()) => out.push_str(&format!(
                "\n[Skipped document part: {} (missing or invalid XML).]\n",
                name
            )),
        }
        if let Some(note) = slide_notes.get(name) {
            if let Some(bytes) = read_part(&mut zip, note) {
                out.push_str("\nNotes:\n");
                if xml_text(&bytes, &mut out).unwrap_or(false) {
                    truncated = true;
                    break;
                }
            }
        }
        if out.chars().count() >= MAX_OUTPUT {
            truncated = true;
            break;
        }
    }
    if out.chars().count() >= MAX_OUTPUT {
        out = out.chars().take(MAX_OUTPUT).collect();
        truncated = true;
    }
    let out = out.replace('\0', "");
    let re = regex::Regex::new(r"\n(?:[ \t]*\n){2,}").unwrap();
    let mut out = re.replace_all(&out, "\n\n").trim().to_owned();
    if truncated {
        out.push_str(TRUNCATED);
    }
    if out.is_empty() {
        Err(true)
    } else {
        Ok(out)
    }
}

fn read_part(zip: &mut zip::ZipArchive<fs::File>, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    if f.size() > 32 * 1024 * 1024 || f.size() > f.compressed_size().saturating_mul(200).max(1024) {
        return None;
    }
    let mut data = Vec::new();
    f.read_to_end(&mut data).ok()?;
    Some(data)
}
fn xml_attributes(bytes: &[u8], tag: &[u8]) -> Vec<HashMap<String, String>> {
    xml_attributes_at(bytes, tag, None)
}

fn xml_attributes_at(
    bytes: &[u8],
    tag: &[u8],
    parents: Option<&[&[u8]]>,
) -> Vec<HashMap<String, String>> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_reader(bytes);
    let mut result = Vec::new();
    let mut path = Vec::<Vec<u8>>::new();
    loop {
        match reader.read_event() {
            Ok(event @ (Event::Start(_) | Event::Empty(_))) => {
                let started = matches!(&event, Event::Start(_));
                let (Event::Start(e) | Event::Empty(e)) = event else { unreachable!() };
                let local = e.local_name();
                let name = local.as_ref();
                let selected = name == tag
                    && parents.is_none_or(|parents| path.iter().map(Vec::as_slice).eq(parents.iter().copied()));
                if parents.is_some() && started {
                    path.push(name.to_vec());
                }
                if !selected {
                    continue;
                }
                let mut attrs = HashMap::new();
                for a in e.attributes().flatten() {
                    if let (Ok(key), Ok(value)) =
                        (std::str::from_utf8(a.key.as_ref()), a.unescape_value())
                    {
                        attrs.insert(key.to_owned(), value.into_owned());
                    }
                }
                result.push(attrs);
            }
            Ok(Event::End(_)) if parents.is_some() => {
                path.pop();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    result
}
fn relationship_targets(bytes: &[u8]) -> HashMap<String, String> {
    xml_attributes(bytes, b"Relationship")
        .into_iter()
        .filter(|a| a.get("TargetMode").is_none_or(|v| v != "External"))
        .filter_map(|a| Some((a.get("Id")?.clone(), a.get("Target")?.clone())))
        .collect()
}
fn archive_path(base: &str, target: &str) -> String {
    let joined = if target.starts_with('/') {
        target.trim_start_matches('/').to_owned()
    } else {
        format!("{base}/{target}")
    };
    let mut parts = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn xlsx_shared(bytes: &[u8]) -> Result<Vec<String>, ()> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_reader(bytes);
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut nodes = 0usize;
    loop {
        match reader.read_event().map_err(|_| ())? {
            Event::Start(e) => {
                nodes += 1;
                if nodes > 200_000 {
                    return Err(());
                }
                match e.local_name().as_ref() {
                    b"si" => current.clear(),
                    b"t" => in_text = true,
                    _ => {}
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"si" => strings.push(std::mem::take(&mut current)),
                b"t" => in_text = false,
                _ => {}
            },
            Event::Text(e) if in_text => current.push_str(&e.unescape().map_err(|_| ())?),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(strings)
}
fn xlsx_styles(bytes: &[u8]) -> Vec<(String, Option<String>)> {
    use quick_xml::{events::Event, Reader};
    let formats: HashMap<String, String> = xml_attributes(bytes, b"numFmt")
        .into_iter()
        .filter_map(|a| Some((a.get("numFmtId")?.clone(), a.get("formatCode")?.clone())))
        .collect();
    let mut reader = Reader::from_reader(bytes);
    let mut inside = false;
    let mut result = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"cellXfs" => inside = true,
            Ok(Event::End(e)) if e.local_name().as_ref() == b"cellXfs" => inside = false,
            Ok(Event::Start(e) | Event::Empty(e)) if inside && e.local_name().as_ref() == b"xf" => {
                let id = e
                    .attributes()
                    .flatten()
                    .find(|a| a.key.as_ref() == b"numFmtId")
                    .and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()))
                    .unwrap_or_else(|| "0".to_owned());
                result.push((id.clone(), formats.get(&id).cloned()));
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    result
}
fn xlsx_sheet(
    bytes: &[u8],
    shared: &[String],
    styles: &[(String, Option<String>)],
    date_system: &str,
    out: &mut String,
) -> Result<bool, ()> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_reader(bytes);
    let mut cell_type = Vec::new();
    let mut style = 0usize;
    let mut formula = String::new();
    let mut value = String::new();
    let mut in_value = false;
    let mut in_formula = false;
    let mut row = Vec::<(usize, String)>::new();
    let mut col = 0usize;
    let mut nodes = 0usize;
    let mut rows = 0usize;
    loop {
        match reader.read_event().map_err(|_| ())? {
            Event::Start(e) => {
                nodes += 1;
                if nodes > 200_000 {
                    return Ok(true);
                }
                match e.local_name().as_ref() {
                    b"row" => {
                        rows += 1;
                        if rows > 10_000 {
                            return Ok(true);
                        }
                        row.clear();
                    }
                    b"c" => {
                        cell_type.clear();
                        style = 0;
                        formula.clear();
                        value.clear();
                        col = 0;
                        for a in e.attributes().with_checks(false) {
                            let a = a.map_err(|_| ())?;
                            match a.key.as_ref() {
                                b"t" => cell_type = a.value.to_vec(),
                                b"s" => {
                                    style = std::str::from_utf8(&a.value)
                                        .ok()
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(0)
                                }
                                b"r" => {
                                    for c in a.value.iter().take_while(|c| c.is_ascii_alphabetic())
                                    {
                                        col = col.saturating_mul(26).saturating_add(
                                            (c.to_ascii_uppercase() - b'A' + 1) as usize,
                                        );
                                    }
                                    col = col.saturating_sub(1);
                                }
                                _ => {}
                            }
                        }
                    }
                    b"v" | b"t" => in_value = true,
                    b"f" => {
                        in_formula = true;
                        formula.clear();
                    }
                    _ => {}
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"v" | b"t" => in_value = false,
                b"f" => in_formula = false,
                b"c" => {
                    if value.is_empty() {
                        value = formula.clone();
                    }
                    if !value.is_empty() {
                        if col >= 512 {
                            return Ok(true);
                        }
                        let mut v = if cell_type == b"s" {
                            value
                                .parse::<usize>()
                                .ok()
                                .and_then(|i| shared.get(i))
                                .cloned()
                                .unwrap_or_default()
                        } else {
                            value.clone()
                        };
                        if (cell_type.is_empty() || cell_type == b"n") && !v.is_empty() {
                            if let Some((id, code)) = styles.get(style).filter(|(id, _)| id != "0")
                            {
                                v.push_str(&format!(" [Excel numFmtId={id}"));
                                if let Some(code) = code {
                                    v.push_str(&format!("; format={code}"));
                                }
                                v.push_str(&format!("; date system {date_system}]"));
                            }
                        }
                        row.push((col, v));
                    }
                }
                b"row" => {
                    if let Some(max) = row.iter().map(|(i, _)| *i).max() {
                        let mut cells = vec![String::new(); max + 1];
                        for (i, v) in &row {
                            cells[*i] = v.clone();
                        }
                        out.push_str(&cells.join("\t"));
                        out.push('\n');
                    }
                }
                _ => {}
            },
            Event::Text(e) if in_formula => formula.push_str(&e.unescape().map_err(|_| ())?),
            Event::Text(e) if in_value => value.push_str(&e.unescape().map_err(|_| ())?),
            Event::Eof => break,
            _ => {}
        }
        if out.len() >= MAX_OUTPUT && out.chars().count() >= MAX_OUTPUT {
            return Ok(true);
        }
    }
    Ok(false)
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let split = |s: &str| {
        s.rsplit_once('/').and_then(|(_, s)| {
            s.trim_end_matches(".xml")
                .trim_end_matches(".xhtml")
                .trim_start_matches(|c: char| !c.is_ascii_digit())
                .parse::<u64>()
                .ok()
        })
    };
    match (split(a), split(b)) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| a.cmp(b)),
        _ => a.cmp(b),
    }
}

fn xml_text(bytes: &[u8], out: &mut String) -> Result<bool, ()> {
    xml_text_with_kind(bytes, out, false)
}

fn xml_text_with_kind(bytes: &[u8], out: &mut String, odf: bool) -> Result<bool, ()> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_reader(bytes);
    let mut depth = 0usize;
    let mut nodes = 0usize;
    let mut hidden = 0usize;
    let mut tag_stack: Vec<Vec<u8>> = Vec::new();
    let mut alternatives = Vec::<(usize, Option<(usize, usize)>, Option<usize>)>::new();
    loop {
        match reader.read_event().map_err(|_| ())? {
            Event::Start(e) => {
                depth += 1;
                nodes += 1;
                if depth > 128 || nodes > 200_000 {
                    return Ok(true);
                }
                let name = e.local_name();
                let n = name.as_ref();
                let parent_is_semantics = tag_stack.last().is_some_and(|p| p == b"semantics");
                tag_stack.push(n.to_vec());
                if hidden > 0 {
                    hidden += 1;
                } else if matches!(
                    n,
                    b"script"
                        | b"style"
                        | b"binary-data"
                        | b"rPh"
                        | b"delText"
                        | b"moveFrom"
                        | b"instrText"
                        | b"delInstrText"
                        | b"tracked-changes"
                        | b"pPr"
                        | b"positionH"
                        | b"positionV"
                        | b"sizeRelH"
                        | b"sizeRelV"
                        | b"fldData"
                ) || (odf && n == b"annotation" && !parent_is_semantics)
                {
                    hidden = 1;
                } else if n == b"AlternateContent" {
                    alternatives.push((depth, None, None));
                } else if matches!(n, b"Choice" | b"Fallback") {
                    if let Some((parent, choice, fallback)) = alternatives.last_mut() {
                        if depth == *parent + 1 {
                            if n == b"Choice" {
                                *choice = Some((out.len(), out.len()));
                            } else {
                                *fallback = Some(out.len());
                            }
                        }
                    }
                } else if n == b"s" {
                    let count = e
                        .attributes()
                        .flatten()
                        .find(|a| a.key.as_ref().split(|b| *b == b':').next_back() == Some(b"c"))
                        .and_then(|a| {
                            std::str::from_utf8(&a.value)
                                .ok()
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap_or(1);
                    if count > MAX_OUTPUT {
                        return Ok(true);
                    }
                    out.push_str(&" ".repeat(count));
                } else if matches!(n, b"tab" | b"ptab" | b"cell") {
                    out.push('\t');
                } else if matches!(n, b"br" | b"line-break" | b"cr") {
                    out.push('\n');
                }
            }
            Event::Empty(e) => {
                if hidden == 0 {
                    let name = e.local_name();
                    match name.as_ref() {
                        b"s" => {
                            let count = e
                                .attributes()
                                .flatten()
                                .find(|a| {
                                    a.key.as_ref().split(|b| *b == b':').next_back() == Some(b"c")
                                })
                                .and_then(|a| {
                                    std::str::from_utf8(&a.value)
                                        .ok()
                                        .and_then(|s| s.parse::<usize>().ok())
                                })
                                .unwrap_or(1);
                            if count > MAX_OUTPUT {
                                return Ok(true);
                            }
                            out.push_str(&" ".repeat(count));
                        }
                        b"tab" | b"ptab" | b"cell" => out.push('\t'),
                        b"br" | b"line-break" | b"cr" => out.push('\n'),
                        b"noBreakHyphen" => out.push('\u{2011}'),
                        _ => {}
                    }
                }
            }
            Event::End(e) => {
                tag_stack.pop();
                if hidden > 0 {
                    hidden -= 1;
                } else {
                    let name = e.local_name();
                    match name.as_ref() {
                        b"Choice" => {
                            if let Some((parent, Some((_, end)), _)) = alternatives.last_mut() {
                                if depth == *parent + 1 {
                                    *end = out.len();
                                }
                            }
                        }
                        b"AlternateContent" => {
                            if alternatives.last().is_some_and(|(parent, _, _)| *parent == depth) {
                                if let Some((_, Some((start, end)), Some(fallback))) = alternatives.pop() {
                                    let choice = &out[start..end];
                                    if !choice.trim().is_empty() {
                                        out.truncate(fallback);
                                    } else if choice.contains('\t')
                                        && (!out[fallback..].trim().is_empty() || out[fallback..].contains('\t'))
                                    {
                                        out.replace_range(start..end, "");
                                    }
                                }
                            }
                        }
                        b"p" | b"h" | b"h1" | b"h2" | b"h3" | b"h4" | b"h5" | b"h6" | b"tr"
                        | b"table-row" | b"row" | b"li" => out.push('\n'),
                        b"tc" | b"table-cell" | b"td" | b"th" => out.push('\t'),
                        _ => {}
                    }
                }
                depth = depth.saturating_sub(1);
            }
            Event::Text(e) if hidden == 0 => out.push_str(&e.unescape().map_err(|_| ())?),
            Event::CData(e) if hidden == 0 => out.push_str(&String::from_utf8_lossy(&e)),
            Event::Eof => break,
            _ => {}
        }
        if out.len() >= MAX_OUTPUT * 4
            || (out.len() >= MAX_OUTPUT && out.chars().count() >= MAX_OUTPUT)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relationships_and_spine_follow_document_order() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.xlsx");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, data) in [
            (
                "xl/workbook.xml",
                r#"<workbook xmlns:r="r"><sheets><sheet name="Second" r:id="r2"/><sheet name="First" r:id="r1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                "<worksheet><row><c><v>1</v></c></row></worksheet>",
            ),
            (
                "xl/worksheets/sheet2.xml",
                "<worksheet><row><c><v>2</v></c></row></worksheet>",
            ),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let text = extract(&path, "xlsx").unwrap();
        assert!(text.find("Sheet: Second").unwrap() < text.find("Sheet: First").unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn epub_uses_spine_instead_of_filename_order() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.epub");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, data) in [
            (
                "META-INF/container.xml",
                r#"<container><rootfile full-path="OEBPS/book.opf"/></container>"#,
            ),
            (
                "OEBPS/book.opf",
                r#"<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>"#,
            ),
            ("OEBPS/a.xhtml", "<html><p>Alpha</p></html>"),
            ("OEBPS/b.xhtml", "<html><p>Beta</p></html>"),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let text = extract(&path, "epub").unwrap();
        assert!(text.find("Beta").unwrap() < text.find("Alpha").unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn presentation_order_and_notes_follow_relationships() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("{}.pptx", uuid::Uuid::new_v4()));
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, data) in [
            (
                "ppt/presentation.xml",
                r#"<presentation xmlns:r="r"><sldIdLst><sldId r:id="r2"/><sldId r:id="r1"/></sldIdLst><extLst><section><sldId r:id="r1"/></section></extLst></presentation>"#,
            ),
            (
                "ppt/_rels/presentation.xml.rels",
                r#"<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>"#,
            ),
            ("ppt/slides/slide1.xml", "<slide><p>First</p></slide>"),
            ("ppt/slides/slide2.xml", "<slide><p>Second</p></slide>"),
            (
                "ppt/slides/_rels/slide2.xml.rels",
                r#"<Relationships><Relationship Type="urn:office/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>"#,
            ),
            (
                "ppt/notesSlides/notesSlide1.xml",
                "<notes><p>Speaker note</p></notes>",
            ),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let text = extract(&path, "pptx").unwrap();
        assert!(text.find("Second").unwrap() < text.find("First").unwrap());
        assert!(text.contains("Notes:\nSpeaker note"));
        assert_eq!(text.matches("First").count(), 1);
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn spreadsheet_styles_and_formula_cache() {
        let styles = xlsx_styles(br#"<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>"#);
        let mut out = String::new();
        xlsx_sheet(
            br#"<worksheet><row><c r="A1" s="1"><f>1+1</f><v>2</v></c></row></worksheet>"#,
            &[],
            &styles,
            "1904",
            &mut out,
        )
        .unwrap();
        assert_eq!(
            out,
            "2 [Excel numFmtId=164; format=yyyy-mm-dd; date system 1904]\n"
        );
    }
    #[test]
    fn rtf_decodes_declared_codepage() {
        let path = std::env::temp_dir().join(format!("{}.rtf", uuid::Uuid::new_v4()));
        fs::write(&path, br"{\rtf1\ansicpg1251 \'cf\'f0\'e8\'e2\'e5\'f2}").unwrap();
        assert_eq!(extract_rtf(&path).unwrap(), "Привет");
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn rtf_omits_page_specific_headers_and_footers() {
        let path = std::env::temp_dir().join(format!("{}.rtf", uuid::Uuid::new_v4()));
        fs::write(
            &path,
            br"{\rtf1\ansi\facingp\sectd\titlepg{\headerf first}{\headerl left}{\headerr right}{\footerf first}{\footerl left}{\footerr right}\pard Document body.\par}",
        )
        .unwrap();
        let result = extract_rtf(&path);
        fs::remove_file(&path).unwrap();
        assert_eq!(result.unwrap(), "Document body.");
    }

    #[test]
    fn rtf_control_words_and_unicode() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test.rtf");
        fs::write(
            &file,
            br"{\rtf1\ansi{\fonttbl hidden}Hello\tab world\par Unicode \u945?{\*\secret hidden}}",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(ensure(&file).unwrap()).unwrap(),
            "Hello\tworld\nUnicode α"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn xlsx_shared_strings_and_sparse_cells() {
        let shared = xlsx_shared(br"<sst><si><t>hello</t></si></sst>").unwrap();
        let mut out = String::new();
        assert!(!xlsx_sheet(br#"<worksheet><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></worksheet>"#, &shared, &[], "1900", &mut out).unwrap());
        assert_eq!(out, "hello\t\t42\n");
    }
    #[test]
    fn docx_extracts_text_and_skips_hidden_content() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test.docx");
        let mut zip = zip::ZipWriter::new(fs::File::create(&file).unwrap());
        zip.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        let xml = concat!(
            r#"<w:document xmlns:w="urn:w" xmlns:mc="urn:mc">"#,
            r#"<w:p><w:r><w:t>Hello &amp; world</w:t><w:delText>hidden</w:delText></w:r></w:p>"#,
            r#"<w:p><w:t>Invoice</w:t><w:ptab/><w:t>$700</w:t></w:p>"#,
            r#"<w:p><w:t>Invoice</w:t><mc:AlternateContent><mc:Choice><w:ptab/></mc:Choice><mc:Fallback><w:tab/></mc:Fallback></mc:AlternateContent><w:t>$800</w:t></w:p>"#,
            r#"<w:p><w:t>Invoice</w:t><mc:AlternateContent><mc:Choice><w:ptab/></mc:Choice><mc:Fallback><w:t xml:space="preserve"> total </w:t></mc:Fallback></mc:AlternateContent><w:t>$900</w:t></w:p>"#,
            r#"<w:p><w:t>Third</w:t><mc:AlternateContent><mc:Choice><w:noBreakHyphen/></mc:Choice><mc:Fallback><w:t>‑</w:t></mc:Fallback></mc:AlternateContent><w:t>party</w:t></w:p>"#,
            "</w:document>",
        );
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
        let side = ensure(&file).unwrap();
        assert_eq!(fs::read_to_string(side).unwrap(), "Hello & world\nInvoice\t$700\nInvoice\t$800\nInvoice total $900\nThird‑party");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn oversized_input_returns_truncation_marker() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("large.ipynb");
        fs::File::create(&file)
            .unwrap()
            .set_len(MAX_INPUT + 1)
            .unwrap();
        assert!(ensure(&file).is_none());
        assert_eq!(worker(&file, ".ipynb").unwrap(), TRUNCATED.trim_start());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn notebook_sidecar_and_existing_cache() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.ipynb");
        fs::write(
            &file,
            r#"{"cells":[{"cell_type":"code","source":["print(1)"],"outputs":[{"text":"1"}]}]}"#,
        )
        .unwrap();
        let side = ensure(&file).unwrap();
        assert_eq!(
            fs::read_to_string(&side).unwrap(),
            "## Cell 1 (code)\nprint(1)\nOutput:\n1"
        );
        fs::write(&file, "invalid").unwrap();
        assert_eq!(ensure(&file), Some(side));
        fs::remove_dir_all(dir).unwrap();
    }
}
