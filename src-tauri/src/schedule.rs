//! When a judge's contest runs, for starting contest mode on a contest just imported.
//!
//! Each judge says it somewhere public: AtCoder on the contest page (start and end), Codeforces
//! in its contest list (start and length), DOJ in the data of its contest page (start, end, and
//! for a contest taken in personal windows, the window's length). A DOJ contest that shows its
//! page only to participants is read through the problem browser's session.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContestSchedule {
    /// Milliseconds since the epoch.
    pub start_ms: i64,
    pub end_ms: i64,
    /// A contest each participant takes in a window of their own, within start..end.
    pub window_minutes: Option<i64>,
}

/// Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm), for timestamps without a
/// date library.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `2023-04-29 21:00:00+0900` (AtCoder) or `2026-09-06T01:00:00.000Z` (DOJ) to epoch ms.
pub(crate) fn parse_timestamp(text: &str) -> Option<i64> {
    let text = text.trim();
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !matches!(text.as_bytes().get(10), Some(b' ' | b'T')) || !(1..=12).contains(&month) || !(1..=31).contains(&day) { return None; }
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.chars().take_while(char::is_ascii_digit).count();
        millis = format!("{:0<3}", &fraction[..digits.min(3)]).parse::<i64>().ok()?;
        rest = &fraction[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "" => 0,
        zone => {
            let sign = match zone.as_bytes().first()? { b'+' => 1, b'-' => -1, _ => return None };
            let digits: String = zone[1..].chars().filter(char::is_ascii_digit).collect();
            if digits.len() != 4 { return None; }
            sign * (digits[..2].parse::<i64>().ok()? * 60 + digits[2..].parse::<i64>().ok()?)
        }
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1000 + millis)
}

/// AtCoder's contest page: the first two `fixtime-full` times are its start and end.
pub(crate) fn parse_atcoder(html: &str) -> Option<ContestSchedule> {
    let mut times = html.match_indices("fixtime-full").filter_map(|(at, _)| {
        let after = &html[at..];
        let open = after.find('>')? + 1;
        let close = after[open..].find('<')?;
        parse_timestamp(&after[open..open + close])
    });
    let (start_ms, end_ms) = (times.next()?, times.next()?);
    (end_ms > start_ms).then_some(ContestSchedule { start_ms, end_ms, window_minutes: None })
}

/// One contest of Codeforces' `contest.list`: its start and length, in seconds.
pub(crate) fn parse_codeforces_list(json: &str, contest_id: i64) -> Option<ContestSchedule> {
    let list: serde_json::Value = serde_json::from_str(json).ok()?;
    let contest = list.get("result")?.as_array()?.iter().find(|item| item.get("id").and_then(|id| id.as_i64()) == Some(contest_id))?;
    let start = contest.get("startTimeSeconds")?.as_i64()?;
    let length = contest.get("durationSeconds")?.as_i64()?;
    Some(ContestSchedule { start_ms: start * 1000, end_ms: (start + length) * 1000, window_minutes: None })
}

/// DOJ's contest page carries the contest in its page data: `"startAt":"$D2026-…Z"`, the same
/// for `endAt`, and for a contest taken in personal windows `"windowed":true` with
/// `"windowDurationSeconds"`. The data is JSON inside a script string, so quotes may come
/// escaped.
pub(crate) fn parse_doj(html: &str) -> Option<ContestSchedule> {
    let text = html.replace("\\\"", "\"");
    let field = |name: &str| -> Option<String> {
        let at = text.find(&format!("\"{name}\":"))? + name.len() + 3;
        let value = text[at..].trim_start();
        let value = value.strip_prefix('"').map(|quoted| quoted.split('"').next().unwrap_or("")).unwrap_or_else(|| value.split([',', '}']).next().unwrap_or(""));
        Some(value.trim_start_matches("$D").trim().to_string())
    };
    let start_ms = parse_timestamp(&field("startAt")?)?;
    let end_ms = parse_timestamp(&field("endAt")?)?;
    let windowed = field("windowed").is_some_and(|value| value == "true");
    let window_minutes = windowed.then(|| field("windowDurationSeconds")?.parse::<i64>().ok().map(|seconds| (seconds + 59) / 60)).flatten();
    (end_ms > start_ms).then_some(ContestSchedule { start_ms, end_ms, window_minutes })
}

/// Where the schedule of the contest a page belongs to is read.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Source {
    AtCoder(String),
    Codeforces(i64),
    /// A DOJ contest page, `https://doj.kr/<locale>/contests/<slug>`.
    Doj(String),
}

/// The contest a contest page or one of its problems belongs to. A problem set problem, or a
/// DOJ problem known only by its contest key, says nothing about a schedule.
pub(crate) fn source_of(url: &str) -> Option<Source> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    let host = parsed.host_str()?.trim_start_matches("www.");
    let parts: Vec<&str> = parsed.path_segments()?.filter(|part| !part.is_empty()).collect();
    match host {
        "atcoder.jp" => (parts.first() == Some(&"contests")).then(|| parts.get(1).map(|id| Source::AtCoder(id.to_string()))).flatten(),
        "codeforces.com" | "m1.codeforces.com" | "m2.codeforces.com" | "m3.codeforces.com" =>
            (parts.first() == Some(&"contest")).then(|| parts.get(1)?.parse().ok().map(Source::Codeforces)).flatten(),
        "doj.kr" => {
            let at = parts.iter().position(|part| *part == "contests")?;
            let slug = parts.get(at + 1)?;
            Some(Source::Doj(format!("https://doj.kr/{}/contests/{slug}", parts[..at].join("/"))))
        }
        _ => None,
    }
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 MildEditor/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())
}

fn get(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let response = client.get(url).send().map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("{} answered {}", url, response.status())); }
    response.text().map_err(|error| error.to_string())
}

/// The schedule of the contest one of `urls` belongs to, or `None` when no judge says.
fn schedule_of(app: &tauri::AppHandle, urls: &[String]) -> Result<Option<ContestSchedule>, String> {
    let Some(source) = urls.iter().find_map(|url| source_of(url)) else { return Ok(None) };
    let client = client()?;
    Ok(match source {
        Source::AtCoder(id) => parse_atcoder(&get(&client, &format!("https://atcoder.jp/contests/{id}"))?),
        Source::Codeforces(id) => parse_codeforces_list(&get(&client, "https://codeforces.com/api/contest.list?gym=false")?, id),
        // A running contest may show its page to participants only, and the problem browser
        // is where the user is one.
        Source::Doj(page) => get(&client, &page).ok().and_then(|html| parse_doj(&html))
            .or_else(|| crate::browser::session_fetch(app, &page).ok().and_then(|fetched| parse_doj(&fetched.body))),
    })
}

#[tauri::command]
pub async fn contest_schedule(app: tauri::AppHandle, urls: Vec<String>) -> Result<Option<ContestSchedule>, String> {
    tauri::async_runtime::spawn_blocking(move || schedule_of(&app, &urls)).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_from_both_judges() {
        // ABC 300 started at 12:00 UTC on 2023-04-29.
        assert_eq!(parse_timestamp("2023-04-29 21:00:00+0900"), Some(1_682_769_600_000));
        assert_eq!(parse_timestamp("2023-04-29T12:00:00.000Z"), Some(1_682_769_600_000));
        assert_eq!(parse_timestamp("2023-04-29T12:00:00.25Z"), Some(1_682_769_600_250));
        assert_eq!(parse_timestamp("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(parse_timestamp("1969-12-31T23:59:59Z"), Some(-1000));
        // A negative offset with minutes: 21:00 at -01:30 is 22:30 UTC.
        assert_eq!(parse_timestamp("2023-04-29 21:00:00-0130"), parse_timestamp("2023-04-29T22:30:00Z"));
        assert_eq!(parse_timestamp("not a time"), None);
        assert_eq!(parse_timestamp("2023-13-01T00:00:00Z"), None);
    }

    #[test]
    fn atcoder_contest_page() {
        // As on atcoder.jp/contests/abc300, links and all.
        let html = r#"<small class="contest-duration">Contest Duration:
            <a href='http://www.timeanddate.com/worldclock/fixedtime.html?iso=20230429T2100&p1=248' target='blank'><time class='fixtime fixtime-full'>2023-04-29 21:00:00+0900</time></a> - <a href='x' target='blank'><time class='fixtime fixtime-full'>2023-04-29 22:40:00+0900</time></a> (local time) (100 minutes)</small>"#;
        assert_eq!(parse_atcoder(html), Some(ContestSchedule { start_ms: 1_682_769_600_000, end_ms: 1_682_775_600_000, window_minutes: None }));
        assert_eq!(parse_atcoder("<html>no times</html>"), None);
    }

    #[test]
    fn codeforces_contest_list() {
        let json = r#"{"status":"OK","result":[{"id":2001,"startTimeSeconds":100,"durationSeconds":60},{"id":2000,"name":"Round","phase":"FINISHED","startTimeSeconds":1723560000,"durationSeconds":8100}]}"#;
        assert_eq!(parse_codeforces_list(json, 2000), Some(ContestSchedule { start_ms: 1_723_560_000_000, end_ms: 1_723_568_100_000, window_minutes: None }));
        assert_eq!(parse_codeforces_list(json, 9999), None);
        assert_eq!(parse_codeforces_list("<html>challenge</html>", 2000), None);
    }

    #[test]
    fn doj_contest_page_data() {
        // The escaped page data of doj.kr/ko/contests/bcd7, a contest taken in 100-minute windows.
        let windowed = r#"[\"$\",\"$L33\",null,{\"locale\":\"ko\",\"contestId\":\"cmtimve8l0e0wokcqksb6wqez\",\"startAt\":\"$D2026-09-06T01:00:00.000Z\",\"endAt\":\"$D2026-09-12T14:00:00.000Z\",\"windowed\":true,\"windowDurationSeconds\":6000,\"windowDurationMinutes\":100}]"#;
        let schedule = parse_doj(windowed).expect("schedule");
        assert_eq!(schedule.window_minutes, Some(100));
        assert_eq!(schedule.start_ms, parse_timestamp("2026-09-06T01:00:00Z").unwrap());
        assert_eq!(schedule.end_ms, parse_timestamp("2026-09-12T14:00:00Z").unwrap());
        let plain = r#"{"startAt":"$D2026-10-09T05:00:00.000Z","endAt":"$D2026-10-09T08:00:00.000Z","windowed":false}"#;
        assert_eq!(parse_doj(plain).map(|schedule| (schedule.end_ms - schedule.start_ms, schedule.window_minutes)), Some((3 * 3_600_000, None)));
        assert_eq!(parse_doj("<html></html>"), None);
    }

    /// Against the live sites; run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn live_schedules_from_all_three_judges() {
        let client = client().expect("client");
        let atcoder = parse_atcoder(&get(&client, "https://atcoder.jp/contests/abc300").expect("atcoder")).expect("atcoder schedule");
        assert_eq!((atcoder.start_ms, atcoder.end_ms - atcoder.start_ms), (1_682_769_600_000, 100 * 60_000));
        let codeforces = parse_codeforces_list(&get(&client, "https://codeforces.com/api/contest.list?gym=false").expect("codeforces"), 2000).expect("codeforces schedule");
        assert_eq!(codeforces.end_ms - codeforces.start_ms, 8100 * 1000);
        let doj = parse_doj(&get(&client, "https://doj.kr/ko/contests/bcd7").expect("doj")).expect("doj schedule");
        assert_eq!(doj.window_minutes, Some(100));
    }

    #[test]
    fn which_page_tells_the_schedule() {
        assert_eq!(source_of("https://atcoder.jp/contests/abc300/tasks/abc300_a"), Some(Source::AtCoder("abc300".into())));
        assert_eq!(source_of("https://atcoder.jp/contests/abc300"), Some(Source::AtCoder("abc300".into())));
        assert_eq!(source_of("https://codeforces.com/contest/2000/problem/B"), Some(Source::Codeforces(2000)));
        assert_eq!(source_of("https://codeforces.com/problemset/problem/4/A"), None);
        assert_eq!(source_of("https://doj.kr/ko/contests/bcd7"), Some(Source::Doj("https://doj.kr/ko/contests/bcd7".into())));
        assert_eq!(source_of("https://doj.kr/ko/contests/bcd7/standings"), Some(Source::Doj("https://doj.kr/ko/contests/bcd7".into())));
        // A problem known only by its contest key does not say which page to read.
        assert_eq!(source_of("https://doj.kr/ko/problems/711?contest=cmunzagaz0fy536czj1s0bwcj"), None);
        assert_eq!(source_of("https://example.com/contests/x"), None);
    }
}
