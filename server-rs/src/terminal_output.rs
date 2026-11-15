//! Incremental command-output terminal state for transient snapshots.
//! This handles the common cursor, erase, SGR and split-escape sequences.
const MAX: usize = 64 * 1024;
const LIVE_LINES: usize = 64;
#[derive(Clone, Default)]
struct Style {
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    inverse: bool,
    strike: bool,
    fg: String,
    bg: String,
}
// Normalize ECMA colon color subparameters as the upstream terminal fold does.
fn sgr_params(raw: &str) -> Vec<u32> {
    if raw.is_empty() { return vec![0]; }
    let mut out=Vec::new();
    let mut pending=0usize;
    for part in raw.split(';') {
        let mut sub:Vec<u32>=part.split(':').map(|v|v.parse().unwrap_or(0)).collect();
        let head=sub[0];
        if pending>1 { out.push(head); pending=if pending==2 {0} else {pending-1}; continue; }
        if pending==1 {
            pending=0;
            if sub.len()==1 { out.push(head); pending=match head {5=>2,2=>4,_=>0}; continue; }
            if head==2 && sub.len()>=5 { sub.remove(1); }
            out.extend(sub.into_iter().take(match head {5=>2,2=>4,_=>1})); continue;
        }
        if sub.len()==1 { out.push(head); if matches!(head,38|48|58) {pending=1} continue; }
        if !matches!(head,38|48|58) { out.push(if head==4 && sub.get(1)==Some(&0) {24} else {head}); continue; }
        if sub.get(1)==Some(&2) && sub.len()>=6 {sub.remove(2);}
        let limit=match sub.get(1) {Some(5)=>3,Some(2)=>5,_=>2}; out.extend(sub.into_iter().take(limit));
    }
    out
}
impl Style {
    fn code(&self) -> String {
        let mut p = Vec::new();
        for (set, code) in [
            (self.bold, "1"),
            (self.dim, "2"),
            (self.italic, "3"),
            (self.underline, "4"),
            (self.inverse, "7"),
            (self.strike, "9"),
        ] {
            if set {
                p.push(code.to_owned());
            }
        }
        if !self.fg.is_empty() {
            p.push(self.fg.clone())
        }
        if !self.bg.is_empty() {
            p.push(self.bg.clone())
        }
        p.join(";")
    }
    fn apply(&mut self, raw: &str) {
        let nums = sgr_params(raw);
        let mut i = 0;
        while i < nums.len() {
            let n = nums[i];
            match n {
                0 => *self = Self::default(),
                1 => self.bold = true,
                2 => self.dim = true,
                3 => self.italic = true,
                4 => self.underline = true,
                7 => self.inverse = true,
                9 => self.strike = true,
                22 => {
                    self.bold = false;
                    self.dim = false
                }
                23 => self.italic = false,
                24 => self.underline = false,
                27 => self.inverse = false,
                29 => self.strike = false,
                30..=37 | 90..=97 => self.fg = n.to_string(),
                40..=47 | 100..=107 => self.bg = n.to_string(),
                39 => self.fg.clear(),
                49 => self.bg.clear(),
                38 | 48 | 58 => {
                    let end = match nums.get(i + 1) {
                        Some(5) => i + 3,
                        Some(2) => i + 5,
                        _ => i + 2,
                    };
                    if end <= nums.len() && n != 58 {
                        let color = match nums[i+1] {
                            5 if nums[i+2] <= 255 => Some(format!("{n};5;{}",nums[i+2])),
                            2 => Some(format!("{n};2;{};{};{}",nums[i+2]&255,nums[i+3]&255,nums[i+4]&255)),
                            _ => None,
                        };
                        if let Some(v)=color { if n == 38 { self.fg = v } else { self.bg = v } }
                    }
                    i = end;
                    continue;
                }
                _ => {}
            }
            i += 1;
        }
    }
}
#[derive(Clone)]
struct Cell {
    // Columns follow JavaScript's UTF-16 code-unit indexing.
    ch: u16,
    pen: String,
}
#[derive(Clone)]
pub(crate) struct TerminalOutput {
    lines: Vec<Vec<Cell>>,
    row: usize,
    col: usize,
    saved: Option<(usize, usize)>,
    pen: Style,
    pending: String,
    settled: String,
    pub truncated: bool,
}
impl Default for TerminalOutput {
    fn default() -> Self {
        Self {
            lines: vec![vec![]],
            row: 0,
            col: 0,
            saved: None,
            pen: Style::default(),
            pending: String::new(),
            settled: String::new(),
            truncated: false,
        }
    }
}
impl TerminalOutput {
    fn line(line: &[Cell]) -> String {
        let mut out = String::new();
        let mut pen = "";
        let mut units = Vec::new();
        for cell in line {
            if cell.pen != pen {
                out.push_str(&String::from_utf16_lossy(&units)); units.clear();
                if cell.pen.is_empty() { out.push_str("\x1b[0m"); }
                else { out.push_str(&format!("\x1b[0;{}m",cell.pen)); }
                pen=&cell.pen;
            }
            units.push(cell.ch);
        }
        out.push_str(&String::from_utf16_lossy(&units));
        if !pen.is_empty() { out.push_str("\x1b[0m"); }
        out
    }
    fn cap(&mut self) {
        let mut count: usize = self.lines.iter().map(Vec::len).sum();
        while count > MAX && self.row > 0 {
            self.scroll();
            count = self.lines.iter().map(Vec::len).sum();
        }
        if count > MAX {
            for (row, line) in self.lines.iter_mut().enumerate() {
                if count <= MAX {
                    break;
                }
                let drop = (count - MAX).min(line.len());
                line.drain(..drop);
                count -= drop;
                if row == self.row {
                    self.col = self.col.saturating_sub(drop)
                }
                self.truncated |= drop > 0;
            }
        }
        if self.settled.len() > MAX * 2 {
            let (text, _) = tail(&self.settled);
            self.settled = text;
            self.truncated = true;
        }
    }
    fn scroll(&mut self) {
        let line = self.lines.remove(0);
        self.settled.push_str(&Self::line(&line));
        self.settled.push('\n');
        self.row = self.row.saturating_sub(1);
        if let Some((r, c)) = self.saved {
            self.saved = Some((r.saturating_sub(1), c))
        }
    }
    fn pos(&mut self, row: usize, col: usize) {
        self.row = row.min(self.lines.len() - 1);
        self.col = col.min(MAX);
    }
    fn erase(&mut self, mode: u32) {
        let line = &mut self.lines[self.row];
        match mode {
            0 => line.truncate(self.col),
            1 => {
                let n = (self.col + 1).min(line.len());
                for cell in &mut line[..n] {
                    *cell = Cell {
                        ch: b' ' as u16,
                        pen: String::new(),
                    }
                }
            }
            2 => line.clear(),
            _ => {}
        }
    }
    fn csi(&mut self, raw: &str, final_byte: char) {
        if !raw.bytes().all(|b| b.is_ascii_digit() || b == b';' || (final_byte == 'm' && b == b':')) {
            return;
        }
        if final_byte == 'm' {
            self.pen.apply(raw);
            return;
        }
        let n: Vec<u32> = raw.split(';').map(|s| s.parse().unwrap_or(0)).collect();
        let first = n.first().copied().unwrap_or(0);
        let count = first.max(1) as usize;
        match final_byte {
            'A' => self.pos(self.row.saturating_sub(count), self.col),
            'B' => self.pos(self.row.saturating_add(count), self.col),
            'C' => self.pos(self.row, self.col.saturating_add(count)),
            'D' => self.pos(self.row, self.col.saturating_sub(count)),
            'E' => self.pos(self.row.saturating_add(count), 0),
            'F' => self.pos(self.row.saturating_sub(count), 0),
            'G' => self.pos(self.row, count - 1),
            'H' | 'f' => self.pos(
                count - 1,
                n.get(1).copied().unwrap_or(0).max(1) as usize - 1,
            ),
            'K' => self.erase(first),
            'J' => match first {
                0 => {
                    self.erase(0);
                    self.lines.truncate(self.row + 1)
                }
                1 => {
                    for r in 0..self.row {
                        self.lines[r].clear()
                    }
                    self.erase(1)
                }
                2 => {
                    self.lines = vec![vec![]];
                    self.row = 0;
                    self.col = 0
                }
                3 => {
                    if !self.settled.is_empty() {
                        self.truncated = true
                    }
                    self.settled.clear()
                }
                _ => {}
            },
            's' => self.saved = Some((self.row, self.col)),
            'u' => {
                if let Some((r, c)) = self.saved {
                    self.pos(r, c)
                }
            }
            _ => {}
        }
    }
    pub fn feed(&mut self, chunk: &str) {
        let input = std::mem::take(&mut self.pending) + chunk;
        let chars: Vec<char> = input.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '\x1b' {
                if i + 1 >= chars.len() {
                    self.pending = chars[i..].iter().collect();
                    break;
                }
                let lead = chars[i + 1];
                if lead == '\x1b' { i += 1; continue; }
                let mut end = i + 2;
                if lead == '[' {
                    while end < chars.len() && !(('@'..='~').contains(&chars[end])) {
                        end += 1
                    }
                    if end == chars.len() {
                        if chars.len() - i <= 64 {
                            self.pending = chars[i..].iter().collect()
                        }
                        break;
                    }
                    let raw: String = chars[i + 2..end].iter().collect();
                    self.csi(&raw, chars[end]);
                    i = end + 1;
                    continue;
                }
                if matches!(lead, ']' | 'P' | 'X' | '_' | '^') {
                    while end < chars.len()
                        && chars[end] != '\x07'
                        && chars[end] != '\n'
                        && chars[end] != '\x1b'
                    {
                        end += 1
                    }
                    if end == chars.len() {
                        if chars.len() - i <= 64 {
                            self.pending = chars[i..].iter().collect()
                        } else {
                            self.pending = format!(
                                "\x1b{}{}",
                                lead,
                                if chars.last() == Some(&'\x1b') {
                                    "\x1b"
                                } else {
                                    ""
                                }
                            );
                        }
                        break;
                    }
                    if chars[end] == '\x1b' && end + 1 == chars.len() {
                        self.pending = if chars.len() - i <= 64 { chars[i..].iter().collect() } else { format!("\x1b{lead}\x1b") };
                        break;
                    }
                    if chars[end] == '\x1b' && chars.get(end + 1) == Some(&'\\') {
                        i = end + 2
                    } else if chars[end] == '\x07' {
                        i = end + 1
                    } else {
                        i = end
                    }
                    continue;
                }
                if (' '..='/').contains(&lead) {
                    let mut final_index = i + 1;
                    while final_index < chars.len() && (' '..='/').contains(&chars[final_index]) { final_index += 1; }
                    if final_index == chars.len() {
                        if chars.len()-i <= 64 { self.pending = chars[i..].iter().collect(); }
                        break;
                    }
                    i = if ('0'..='~').contains(&chars[final_index]) { final_index+1 } else { final_index };
                    continue;
                }
                match lead {
                    '7' => self.saved = Some((self.row, self.col)),
                    '8' => {
                        if let Some((r, c)) = self.saved {
                            self.pos(r, c)
                        }
                    }
                    'M' => self.pos(self.row.saturating_sub(1), self.col),
                    _ => {}
                }
                i += 2;
                continue;
            }
            match c {
                '\n' => {
                    self.row += 1;
                    self.col = 0;
                    if self.row == self.lines.len() {
                        self.lines.push(vec![])
                    }
                    while self.lines.len() > LIVE_LINES {
                        self.scroll()
                    }
                }
                '\r' => self.col = 0,
                '\x08' => self.col = self.col.saturating_sub(1),
                c if c == '\t' || (!c.is_control() && c != '\x7f') => {
                    let line = &mut self.lines[self.row];
                    while line.len() < self.col {
                        line.push(Cell {
                            ch: b' ' as u16,
                            pen: String::new(),
                        })
                    }
                    let mut encoded = [0; 2];
                    for &unit in c.encode_utf16(&mut encoded).iter() {
                        let cell = Cell { ch:unit, pen:self.pen.code() };
                        if self.col == line.len() { line.push(cell) } else { line[self.col] = cell }
                        self.col += 1;
                    }
                }
                _ => {}
            }
            i += 1;
            // Bound transient allocation even when a provider sends one huge frame.
            if i % 4096 == 0 {
                self.cap();
            }
        }
        self.cap();
    }
    pub fn text(&self) -> (String, bool) {
        let mut text = self.settled.clone();
        text.push_str(
            &self
                .lines
                .iter()
                .map(|l| Self::line(l))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let (text, cut) = tail(&text);
        (text, self.truncated || cut)
    }
    pub fn resume(&self) -> (String, bool) {
        let (mut text, truncated) = self.text();
        let last = self.lines.len() - 1;
        let reachable = text
            .chars()
            .filter(|c| *c == '\n')
            .count()
            .min(LIVE_LINES - 1);
        let position = |row: usize, col: usize| {
            let up = last.saturating_sub(row).min(reachable);
            format!(
                "{}\x1b[{}G",
                if up > 0 {
                    format!("\x1b[{up}A")
                } else {
                    String::new()
                },
                col + 1
            )
        };
        if let Some((row, col)) = self.saved {
            text.push_str(&position(row, col));
            text.push_str("\x1b7");
            let up = last.saturating_sub(row).min(reachable);
            if up > 0 {
                text.push_str(&format!("\x1b[{up}B"));
            }
        }
        if self.saved.is_some() || self.row != last || self.col != self.lines[self.row].len() {
            text.push_str(&position(self.row, self.col));
        }
        let pen = self.pen.code();
        if !pen.is_empty() {
            text.push_str(&format!("\x1b[0;{pen}m"))
        }
        text.push_str(&self.pending);
        (text, truncated)
    }
}
fn tail(text: &str) -> (String, bool) {
    if text.encode_utf16().count() <= MAX {
        return (text.into(), false);
    }
    let mut units = 0;
    let mut start = text.len();
    for (i, c) in text.char_indices().rev() {
        let n = c.len_utf16();
        if units + n > MAX {
            break;
        }
        units += n;
        start = i;
    }
    if let Some(offset) = text[start..].find('\n') {
        if text[start..start + offset].encode_utf16().count() < MAX / 4 {
            return (text[start + offset + 1..].into(), true);
        }
    }
    let line_start = text[..start].rfind('\n').map_or(0, |i| i + 1);
    let mut prefix = "";
    let mut cursor = line_start;
    while let Some(offset) = text[cursor..start].find("\x1b[") {
        let at = cursor + offset;
        let Some(end) = text[at..].find('m').map(|n| at + n) else {
            break;
        };
        if end >= start {
            start = end + 1;
            prefix = &text[at..=end];
            break;
        }
        prefix = &text[at..=end];
        cursor = end + 1;
    }
    if prefix == "\x1b[0m" {
        prefix = ""
    };
    (format!("{prefix}{}", &text[start..]), true)
}
pub(crate) fn normalize(text: &str) -> (String, bool) {
    let mut state = TerminalOutput::default();
    state.feed(text);
    state.text()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sgr_colon_forms_and_invalid_indexed_colors_match_original() {
        assert_eq!(normalize("\x1b[38:2::255:10:20mcolor").0,"\x1b[0;38;2;255;10;20mcolor\x1b[0m");
        assert_eq!(normalize("\x1b[4:0mtext").0,"text");
        assert_eq!(normalize("\x1b[38;5;300mtext").0,"text");
        assert_eq!(normalize("\x1b[38;2:255:10:20mtext").0,"\x1b[0;38;2;255;10;20mtext\x1b[0m");
        assert_eq!(normalize("a\x1b(Bb").0,"ab");
        assert_eq!(normalize("\x1b\x1b[31mx").0,"\x1b[0;31mx\x1b[0m");
        let mut state=TerminalOutput::default();state.feed(&format!("a\x1b]{}\x1b","x".repeat(100))); assert!(state.pending.len()<=64); state.feed("\\b");assert_eq!(state.text().0,"ab");
    }
    #[test]
    fn cursor_and_split_escapes() {
        assert_eq!(normalize("🙂abc\r\x1b[4GZ").0, "🙂aZc");
        let mut t = TerminalOutput::default();
        t.feed("working 99%\r");
        t.feed("done\x1b[");
        t.feed("K\n\x1b[31mred\x1b[0m");
        assert_eq!(t.text().0, "done\n\x1b[0;31mred\x1b[0m");
        let mut t = TerminalOutput::default();
        t.feed("abc\r");
        assert_eq!(t.resume().0, "abc\x1b[1G");
        t.feed("Z");
        assert_eq!(t.text().0, "Zbc");
        let mut t = TerminalOutput::default();
        t.feed("one\ntwo\x1b[1A\rX");
        assert_eq!(t.text().0, "Xne\ntwo");
        assert_eq!(t.resume().0, "Xne\ntwo\x1b[1A\x1b[2G");
    }
}
