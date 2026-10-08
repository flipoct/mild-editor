//! Polling the judges for the verdict of the latest submission to each problem.

use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::Duration};

use crate::import::is_cloudflare_challenge;
use crate::workspace::{workspace_metadata_path, write_workspace_metadata, SubmissionRecord, WorkspaceMetadata};
use crate::HTTP_CONNECT_TIMEOUT;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubmissionStatusRequest {
    #[serde(default)]
    folder_path: Option<String>,
    problems: Vec<SubmissionProblem>,
    atcoder_handle: String,
    codeforces_handle: String,
    doj_handle: String,
    /// Pages only the logged-in user can read, fetched through the problem browser's session
    /// and handed in by the frontend, since the client here has no login. Each one answers a
    /// `session_url` of an earlier poll.
    #[serde(default)]
    session_pages: Vec<SessionPage>,
}

#[derive(Deserialize)]
struct SessionPage {
    url: String,
    html: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionProblem {
    source: String,
    source_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubmissionStatus {
    source_url: String,
    status: Option<String>,
    submission_url: Option<String>,
    /// Seconds since the epoch, from the judge; 0 when it does not say.
    #[serde(default)]
    submitted_at: u64,
    /// Everything known about this problem's submissions, oldest first.
    #[serde(default)]
    submissions: Vec<SubmissionRecord>,
    /// Where this problem's verdict is when no public page has it: a page of the judge that
    /// only the logged-in user is shown. The poll wants it back as a `session_pages` entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_url: Option<String>,
}

pub(crate) fn codeforces_problem_key(url: &str) -> Option<(i64, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let parts = parsed.path_segments()?.collect::<Vec<_>>();
    if let Some(index) = parts.iter().position(|part| *part == "contest") {
        return Some((parts.get(index + 1)?.parse().ok()?, parts.get(index + 3)?.to_uppercase()));
    }
    let index = parts.iter().position(|part| *part == "problem")?;
    Some((parts.get(index + 1)?.parse().ok()?, parts.get(index + 2)?.to_uppercase()))
}

fn atcoder_problem_key(url: &str) -> Option<(String, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let parts = parsed.path_segments()?.collect::<Vec<_>>();
    let contest = parts.get(parts.iter().position(|part| *part == "contests")? + 1)?.to_string();
    let task = parts.get(parts.iter().position(|part| *part == "tasks")? + 1)?.to_string();
    Some((contest, task))
}

/// The problem's number in DOJ's archive, from `/<locale>/problems/<number>`. A slug in that
/// place is no use: the status page filters by number, and given anything else it drops the
/// filter and lists every submission of the user — the newest of which is not this problem's.
fn doj_problem_id(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let parts = parsed.path_segments()?.collect::<Vec<_>>();
    let id = parts.get(parts.iter().position(|part| *part == "problems")? + 1)?;
    (!id.is_empty() && id.chars().all(|character| character.is_ascii_digit())).then(|| id.to_string())
}

/// The page that lists the user's submissions to the contest a DOJ problem was opened from
/// (`?contest=<key>` on its URL). While the contest runs they are nowhere else: the site-wide
/// status page leaves them out until it is over. DOJ shows the page to a logged-in
/// participant only and sends anyone else to the login.
fn doj_contest_submissions_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let key = parsed.query_pairs().find(|(name, value)| name == "contest" && !value.is_empty())?.1.into_owned();
    let parts = parsed.path_segments()?.collect::<Vec<_>>();
    let locale = parts.iter().position(|part| *part == "problems").filter(|at| *at > 0).map(|at| parts[at - 1]).unwrap_or("ko");
    let mut page = parsed.join(&format!("/{locale}/contests/")).ok()?;
    page.path_segments_mut().ok()?.pop_if_empty().push(&key).push("submissions");
    page.set_query(None);
    Some(page.to_string())
}

/// One row of a DOJ submissions table; the page lists the newest first.
#[derive(Debug, PartialEq)]
struct DojSubmission {
    problem: String,
    user: Option<String>,
    /// `100/100`, or empty while it is being judged.
    score: String,
}

fn parse_doj_submissions(html: &str) -> Vec<DojSubmission> {
    let document = scraper::Html::parse_document(html);
    let row_selector = scraper::Selector::parse("table tbody tr").unwrap();
    let problem_selector = scraper::Selector::parse("a[href*=\"/problems/\"]").unwrap();
    let user_selector = scraper::Selector::parse("a[href*=\"/user/\"]").unwrap();
    let score_selector = scraper::Selector::parse(".doj-score-bar-label").unwrap();
    document.select(&row_selector).filter_map(|row| {
        let href = row.select(&problem_selector).next()?.value().attr("href")?;
        let problem = href.split(['?', '#']).next()?.trim_end_matches('/').rsplit('/').next()?.to_string();
        let score = row.select(&score_selector).next()?.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join("");
        let user = row.select(&user_selector).next().map(|link| link.text().collect::<String>().trim().to_string());
        Some(DojSubmission { problem, user, score })
    }).collect()
}

/// The verdict of the user's newest submission to one problem on a DOJ submissions page.
/// The rows are checked rather than trusted to be what the URL asked for.
fn doj_verdict(html: &str, problem_id: &str, handle: &str) -> Option<String> {
    let row = parse_doj_submissions(html).into_iter().find(|row| row.problem == problem_id && row.user.as_deref().is_none_or(|user| user.eq_ignore_ascii_case(handle)))?;
    let values = row.score.split('/').collect::<Vec<_>>();
    Some(if values.len() == 2 && values[0] == values[1] { "AC".into() } else if row.score.is_empty() { "JUDGING".into() } else { format!("SCORE {}", row.score) })
}

/// The user's latest submissions from the official API, newest first. The API is not behind
/// the browser check that guards the site's pages; should that change, the answer says so
/// instead of failing as JSON that would not parse.
fn fetch_codeforces_submissions(client: &reqwest::blocking::Client, handle: &str) -> Result<Vec<serde_json::Value>, String> {
    let mut url = reqwest::Url::parse("https://codeforces.com/api/user.status").unwrap();
    url.query_pairs_mut().append_pair("handle", handle).append_pair("from", "1").append_pair("count", "100");
    let response = client.get(url).send().map_err(|error| format!("Could not refresh Codeforces submissions: {error}"))?;
    let status = response.status();
    let mitigated = response.headers().get("cf-mitigated").and_then(|value| value.to_str().ok()).map(str::to_string);
    let body = response.text().map_err(|error| format!("Could not refresh Codeforces submissions: {error}"))?;
    if is_cloudflare_challenge(status.as_u16(), mitigated.as_deref(), &body) {
        return Err("Codeforces answered with Cloudflare's browser check, so its verdicts cannot be read for now.".into());
    }
    // An error of the API's own (an unknown handle, a rate limit) comes as JSON with a comment.
    let value = serde_json::from_str::<serde_json::Value>(&body).map_err(|_| format!("Could not refresh Codeforces submissions: HTTP {status}"))?;
    if value.get("status").and_then(|status| status.as_str()) != Some("OK") {
        return Err(format!("Could not refresh Codeforces submissions: {}", value.get("comment").and_then(|comment| comment.as_str()).unwrap_or("the API reported a failure")));
    }
    Ok(value.get("result").and_then(|result| result.as_array()).cloned().unwrap_or_default())
}

fn fetch_atcoder_submissions(
    client: &reqwest::blocking::Client,
    handle: &str,
    initial_from_second: u64,
) -> Vec<serde_json::Value> {
    let mut submissions = Vec::new();
    let mut from_second = initial_from_second;
    // The AtCoder Problems API returns a bounded page. Advance its timestamp
    // cursor until the newest page is reached; otherwise active users can have
    // a virtual-contest submission omitted from the first response.
    for _ in 0..20 {
        let mut url = reqwest::Url::parse(
            "https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions",
        )
        .unwrap();
        url.query_pairs_mut()
            .append_pair("user", handle)
            .append_pair("from_second", &from_second.to_string());
        let page = client
            .get(url)
            .send()
            .and_then(|response| response.error_for_status())
            .ok()
            .and_then(|response| response.json::<Vec<serde_json::Value>>().ok())
            .unwrap_or_default();
        if page.is_empty() {
            break;
        }
        let Some(latest_second) = page
            .iter()
            .filter_map(|submission| submission.get("epoch_second").and_then(|value| value.as_u64()))
            .max()
        else {
            break;
        };
        submissions.extend(page);
        if latest_second < from_second || latest_second == u64::MAX {
            break;
        }
        from_second = latest_second + 1;
    }
    submissions
}

/// Adds the submission the judge is reporting to a problem's history, if it is not the one
/// already at the end of it. A judge only ever names the latest submission, so a verdict
/// that is still being decided is replaced in place as it settles rather than appended
/// again — otherwise one submission would leave `WJ`, `WJ`, `AC` behind it.
fn record_submission(history: &mut Vec<SubmissionRecord>, status: &SubmissionStatus) {
    let Some(verdict) = status.status.clone() else { return };
    let record = SubmissionRecord { status: verdict, url: status.submission_url.clone(), at: status.submitted_at };
    match history.last_mut() {
        Some(last) if last.url.is_some() && last.url == record.url => *last = record,
        // Without a submission link, the only handle on identity is the time it was made.
        Some(last) if last.url.is_none() && record.url.is_none() && last.at == record.at && record.at != 0 => *last = record,
        Some(last) if *last == record => {}
        _ => history.push(record),
    }
    // A long history is of no use and would bloat the metadata of every solved problem.
    if history.len() > 50 {
        let excess = history.len() - 50;
        history.drain(0..excess);
    }
}

fn refresh_submission_statuses_sync(request: SubmissionStatusRequest) -> Result<Vec<SubmissionStatus>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("MildEditor/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let mut statuses = Vec::new();
    let folder_path = request.folder_path.clone();

    // Codeforces failing must not cost the other judges their poll, so its error waits until
    // they have been asked.
    let mut codeforces_error = None;
    let codeforces_submissions = if request.codeforces_handle.trim().is_empty() {
        Vec::new()
    } else {
        fetch_codeforces_submissions(&client, request.codeforces_handle.trim()).unwrap_or_else(|error| {
            codeforces_error = Some(error);
            Vec::new()
        })
    };
    let atcoder_recent_submissions = if request.atcoder_handle.trim().is_empty() {
        Vec::new()
    } else {
        // Keep this window narrow so a very active user's newest virtual-contest
        // submissions cannot be pushed out of the API response by older entries.
        let from_second = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs().saturating_sub(7 * 24 * 60 * 60);
        fetch_atcoder_submissions(&client, request.atcoder_handle.trim(), from_second)
    };
    let mut atcoder_extended_submissions: Option<Vec<serde_json::Value>> = None;

    for problem in request.problems {
        let mut status = None;
        let mut submission_url = None;
        let mut submitted_at = 0u64;
        let mut session_url = None;
        match problem.source.as_str() {
            "codeforces" if !request.codeforces_handle.trim().is_empty() => {
                if let Some((contest, index)) = codeforces_problem_key(&problem.source_url) {
                    if let Some(submission) = codeforces_submissions.iter().find(|submission| {
                        submission.pointer("/problem/contestId").and_then(|value| value.as_i64()) == Some(contest)
                            && submission.pointer("/problem/index").and_then(|value| value.as_str()).is_some_and(|value| value.eq_ignore_ascii_case(&index))
                    }) {
                        status = Some(submission.get("verdict").and_then(|value| value.as_str()).unwrap_or("TESTING").replace('_', " "));
                        submitted_at = submission.get("creationTimeSeconds").and_then(|value| value.as_u64()).unwrap_or_default();
                        if let Some(id) = submission.get("id").and_then(|value| value.as_i64()) {
                            submission_url = Some(format!("https://codeforces.com/contest/{contest}/submission/{id}"));
                        }
                    }
                }
            }
            "atcoder" if !request.atcoder_handle.trim().is_empty() => {
                if let Some((contest, task)) = atcoder_problem_key(&problem.source_url) {
                    let mut submission = atcoder_recent_submissions.iter()
                        .filter(|submission| submission.get("problem_id").and_then(|value| value.as_str()) == Some(task.as_str()))
                        .max_by_key(|submission| submission.get("epoch_second").and_then(|value| value.as_i64()).unwrap_or_default());
                    if submission.is_none() {
                        let extended = atcoder_extended_submissions.get_or_insert_with(|| {
                            let from_second = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs()
                                .saturating_sub(90 * 24 * 60 * 60);
                            fetch_atcoder_submissions(&client, request.atcoder_handle.trim(), from_second)
                        });
                        submission = extended.iter()
                            .filter(|submission| submission.get("problem_id").and_then(|value| value.as_str()) == Some(task.as_str()))
                            .max_by_key(|submission| submission.get("epoch_second").and_then(|value| value.as_i64()).unwrap_or_default());
                    }
                    if let Some(submission) = submission {
                        status = submission.get("result").and_then(|value| value.as_str()).map(str::to_string);
                        submitted_at = submission.get("epoch_second").and_then(|value| value.as_u64()).unwrap_or_default();
                        if let Some(id) = submission.get("id").and_then(|value| value.as_i64()) {
                            submission_url = Some(format!("https://atcoder.jp/contests/{contest}/submissions/{id}"));
                        }
                    }
                }
            }
            "doj" if !request.doj_handle.trim().is_empty() => {
                if let Some(problem_id) = doj_problem_id(&problem.source_url) {
                    let handle = request.doj_handle.trim();
                    let mut url = reqwest::Url::parse("https://doj.kr/ko/status").unwrap();
                    url.query_pairs_mut().append_pair("user", handle).append_pair("problem", &problem_id);
                    if let Ok(html) = client.get(url.clone()).send().and_then(|response| response.error_for_status()).and_then(|response| response.text()) {
                        if let Some(verdict) = doj_verdict(&html, &problem_id, handle) {
                            status = Some(verdict);
                            submission_url = Some(url.to_string());
                        }
                    }
                    // Nothing public: for a contest problem that is how a running contest
                    // looks, and its submissions are on a page the login alone opens. The
                    // public page still goes first, because once the contest is over it has
                    // the later submissions as well and this one stops at the contest's.
                    if status.is_none() {
                        if let Some(contest_url) = doj_contest_submissions_url(&problem.source_url) {
                            if let Some(verdict) = request.session_pages.iter().find(|page| page.url == contest_url).and_then(|page| doj_verdict(&page.html, &problem_id, handle)) {
                                status = Some(verdict);
                                submission_url = Some(contest_url.clone());
                            }
                            session_url = Some(contest_url);
                        }
                    }
                }
            }
            _ => {}
        }
        statuses.push(SubmissionStatus { source_url: problem.source_url, status, submission_url, submitted_at, submissions: Vec::new(), session_url });
    }
    if let Some(folder_path) = folder_path {
        let folder = std::path::PathBuf::from(folder_path);
        let metadata_path = workspace_metadata_path(&folder);
        if let Ok(json) = fs::read_to_string(&metadata_path) {
            if let Ok(mut metadata) = serde_json::from_str::<WorkspaceMetadata>(&json) {
                for problem in &mut metadata.problems {
                    let inferred_url = if problem.source.as_deref() == Some("doj") {
                        Path::new(&problem.filename)
                            .file_stem()
                            .and_then(|value| value.to_str())
                            .filter(|value| value.chars().all(|character| character.is_ascii_digit()))
                            .map(|problem_id| format!("https://doj.kr/ko/problems/{problem_id}"))
                    } else {
                        None
                    };
                    let effective_url = problem.source_url.clone().or(inferred_url);
                    if let Some(url) = effective_url {
                        if let Some(index) = statuses.iter().position(|result| result.source_url == url.as_str()) {
                            problem.source_url = Some(url);
                            // A poll that learned nothing (a judge out of reach, a contest
                            // page not handed in) is no reason to forget the verdict on file.
                            if statuses[index].status.is_some() { problem.judge_status = statuses[index].status.clone(); }
                            record_submission(&mut problem.submissions, &statuses[index]);
                            statuses[index].submissions = problem.submissions.clone();
                        }
                    }
                }
                write_workspace_metadata(&metadata_path, &metadata, "save submission statuses")?;
            }
        }
    }
    // With verdicts from elsewhere the poll is still worth its result; with none, the reason is.
    match codeforces_error {
        Some(error) if statuses.iter().all(|status| status.status.is_none()) => Err(error),
        _ => Ok(statuses),
    }
}

#[tauri::command]
pub(crate) async fn refresh_submission_statuses(request: SubmissionStatusRequest) -> Result<Vec<SubmissionStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || refresh_submission_statuses_sync(request)).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row of doj.kr/ko/status as the site renders it, comments between the numbers included.
    fn doj_row(user: &str, problem: &str, slug: &str, bar: &str, score: &str) -> String {
        format!(r#"<tr style="--row-index:0"><td><a class="doj-submission-participant-link" title="{user}" href="/ko/user/{user}">{user}</a></td><td><div class="doj-status-problem-anchor" tabindex="0"><a class="doj-status-problem-link" href="/ko/problems/{problem}">{slug}</a></div></td><td><div class="doj-score-anchor" tabindex="0"><div class="doj-score-bar {bar}"><div class="doj-problem-score-fill" style="width:100%"></div><span class="doj-score-bar-label">{score}</span></div></div></td><td class="doj-status-language">C++20</td><td><span class="doj-status-time-label">3일 전</span></td><td></td></tr>"#)
    }

    #[test]
    fn doj_verdict_is_the_newest_row_of_that_problem_and_user() {
        let table = |rows: &[String]| format!("<table><thead><tr><th>제출자</th><th>문제</th><th>점수</th></tr></thead><tbody>{}</tbody></table>", rows.concat());
        let html = table(&[
            doj_row("woohyunjng", "632", "mountaingame", "is-solved is-full", "100<!-- --> / <!-- -->100"),
            doj_row("woohyunjng", "632", "mountaingame", "is-partial", "26<!-- --> / <!-- -->100"),
        ]);
        assert_eq!(parse_doj_submissions(&html)[1], DojSubmission { problem: "632".into(), user: Some("woohyunjng".into()), score: "26/100".into() });
        assert_eq!(doj_verdict(&html, "632", "woohyunjng").as_deref(), Some("AC"));
        assert_eq!(doj_verdict(&table(&[doj_row("a", "632", "mountaingame", "is-partial", "26<!-- --> / <!-- -->100")]), "632", "A").as_deref(), Some("SCORE 26/100"));
        assert_eq!(doj_verdict(&table(&[doj_row("a", "632", "mountaingame", "is-idle", "")]), "632", "a").as_deref(), Some("JUDGING"));

        // A filter the site did not understand lists everything the user sent: the newest
        // row is another problem's, and must not be taken for this one's verdict.
        let unfiltered = table(&[doj_row("a", "738", "hey-lulu-eat-saga", "is-solved is-full", "100<!-- --> / <!-- -->100"), doj_row("a", "634", "bracketstring", "is-partial", "0<!-- --> / <!-- -->100")]);
        assert_eq!(doj_verdict(&unfiltered, "634", "a").as_deref(), Some("SCORE 0/100"));
        assert_eq!(doj_verdict(&unfiltered, "286", "a"), None);
        assert_eq!(doj_verdict(&unfiltered, "738", "someone-else"), None);
        // A contest's own page links its problems with the contest key still on them.
        let keyed = table(&[doj_row("a", "286?contest=cmtimve8l0e0wokcqksb6wqez", "49", "is-solved is-full", "100<!-- --> / <!-- -->100")]);
        assert_eq!(doj_verdict(&keyed, "286", "a").as_deref(), Some("AC"));
    }

    #[test]
    fn doj_problem_urls_give_the_number_and_the_contests_own_page() {
        assert_eq!(doj_problem_id("https://doj.kr/ko/problems/286").as_deref(), Some("286"));
        assert_eq!(doj_problem_id("https://doj.kr/en/problems/286?contest=cmtimve8l0e0wokcqksb6wqez").as_deref(), Some("286"));
        assert_eq!(doj_problem_id("https://doj.kr/ko/problems/286/ide").as_deref(), Some("286"));
        // The status page cannot filter by slug, so a slug is no problem id at all.
        assert_eq!(doj_problem_id("https://doj.kr/ko/problems/bracketstring"), None);
        assert_eq!(doj_problem_id("https://doj.kr/ko/contests/bcd7"), None);

        assert_eq!(doj_contest_submissions_url("https://doj.kr/en/problems/286?contest=cmtimve8l0e0wokcqksb6wqez").as_deref(), Some("https://doj.kr/en/contests/cmtimve8l0e0wokcqksb6wqez/submissions"));
        assert_eq!(doj_contest_submissions_url("https://doj.kr/ko/problems/286"), None);
        assert_eq!(doj_contest_submissions_url("https://doj.kr/ko/problems/286?contest="), None);
    }

    #[test]
    #[ignore = "requires access to doj.kr and the public submissions of one of its users"]
    fn reads_doj_verdicts_from_the_live_status_page() {
        let client = reqwest::blocking::Client::builder().user_agent("MildEditor/test").timeout(Duration::from_secs(30)).build().unwrap();
        let page = |query: &str| client.get(format!("https://doj.kr/ko/status?{query}")).send().unwrap().error_for_status().unwrap().text().unwrap();
        assert_eq!(doj_verdict(&page("user=woohyunjng&problem=286"), "286", "woohyunjng").as_deref(), Some("AC"));
        // By slug the filter is dropped: twenty rows of everything, none of them to be mistaken for #634.
        let unfiltered = parse_doj_submissions(&page("user=woohyunjng&problem=bracketstring"));
        assert!(unfiltered.len() > 1 && unfiltered.iter().any(|row| row.problem != unfiltered[0].problem), "{unfiltered:?}");
        // The contest's own page exists under the key a problem link carries, and is the login's alone.
        let contest_url = doj_contest_submissions_url("https://doj.kr/ko/problems/286?contest=cmtimve8l0e0wokcqksb6wqez").unwrap();
        let contest_page = client.get(&contest_url).send().unwrap().error_for_status().unwrap().text().unwrap();
        assert!(contest_page.contains("NEXT_REDIRECT;replace;/ko/login"), "the contest submissions page no longer sends a visitor to the login");
        assert!(parse_doj_submissions(&contest_page).is_empty());
    }

    #[test]
    #[ignore = "requires access to the Codeforces API"]
    fn codeforces_api_answers_a_plain_client_and_names_its_own_errors() {
        let client = reqwest::blocking::Client::builder().user_agent("MildEditor/test").timeout(Duration::from_secs(30)).build().unwrap();
        let submissions = fetch_codeforces_submissions(&client, "tourist").unwrap();
        assert!(submissions.iter().any(|submission| submission.pointer("/problem/contestId").is_some() && submission.get("verdict").is_some()));
        let unknown = fetch_codeforces_submissions(&client, "zz-no-such-user-zz").unwrap_err();
        assert!(unknown.contains("not found"), "{unknown}");
    }

    #[test]
    fn submission_history_follows_one_verdict_and_appends_the_next() {
        let status = |verdict: &str, url: Option<&str>, at: u64| SubmissionStatus {
            source_url: "https://atcoder.jp/contests/abc400/tasks/abc400_a".into(),
            status: Some(verdict.into()),
            submission_url: url.map(str::to_string),
            submitted_at: at,
            submissions: Vec::new(),
            session_url: None,
        };
        let mut history = Vec::new();

        // One submission settling from judging to a verdict stays one entry.
        record_submission(&mut history, &status("WJ", Some("s/1"), 100));
        record_submission(&mut history, &status("WA", Some("s/1"), 100));
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, "WA");

        // The next submission is a new entry, and polling again does not duplicate it.
        record_submission(&mut history, &status("AC", Some("s/2"), 200));
        record_submission(&mut history, &status("AC", Some("s/2"), 200));
        assert_eq!(history.iter().map(|item| item.status.as_str()).collect::<Vec<_>>(), vec!["WA", "AC"]);
        assert_eq!(history[1].at, 200);

        // A judge that gives no link is told apart by the time it reports instead.
        let mut linkless = Vec::new();
        record_submission(&mut linkless, &status("JUDGING", None, 10));
        record_submission(&mut linkless, &status("SCORE 50/100", None, 10));
        record_submission(&mut linkless, &status("SCORE 100/100", None, 20));
        assert_eq!(linkless.iter().map(|item| item.status.as_str()).collect::<Vec<_>>(), vec!["SCORE 50/100", "SCORE 100/100"]);

        // Nothing to report leaves the history alone, and it never grows without bound.
        let mut empty = Vec::new();
        record_submission(&mut empty, &SubmissionStatus { source_url: String::new(), status: None, submission_url: None, submitted_at: 0, submissions: Vec::new(), session_url: None });
        assert!(empty.is_empty());
        let mut long = Vec::new();
        for index in 0..60 {
            record_submission(&mut long, &status("WA", Some(&format!("s/{index}")), index));
        }
        assert_eq!(long.len(), 50);
        assert_eq!(long[0].url.as_deref(), Some("s/10"));
    }
}
