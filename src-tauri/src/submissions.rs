//! Polling the judges for the verdict of the latest submission to each problem.

use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::Duration};

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

fn doj_problem_id(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    parsed.path_segments()?.filter(|part| !part.is_empty()).next_back().map(str::to_string)
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

    let codeforces_submissions = if request.codeforces_handle.trim().is_empty() {
        Vec::new()
    } else {
        let mut url = reqwest::Url::parse("https://codeforces.com/api/user.status").unwrap();
        url.query_pairs_mut().append_pair("handle", request.codeforces_handle.trim()).append_pair("from", "1").append_pair("count", "100");
        let value: serde_json::Value = client.get(url).send().and_then(|response| response.error_for_status()).map_err(|error| format!("Could not refresh Codeforces submissions: {error}"))?.json().map_err(|error| error.to_string())?;
        value.get("result").and_then(|result| result.as_array()).cloned().unwrap_or_default()
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
                    let mut url = reqwest::Url::parse("https://doj.kr/ko/status").unwrap();
                    url.query_pairs_mut().append_pair("user", request.doj_handle.trim()).append_pair("problem", &problem_id);
                    if let Ok(html) = client.get(url.clone()).send().and_then(|response| response.error_for_status()).and_then(|response| response.text()) {
                        let document = scraper::Html::parse_document(&html);
                        let row_selector = scraper::Selector::parse("table tbody tr").unwrap();
                        let score_selector = scraper::Selector::parse(".doj-score-bar-label").unwrap();
                        if let Some(score) = document.select(&row_selector).next().and_then(|row| row.select(&score_selector).next()) {
                            let score = score.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join("");
                            let values = score.split('/').collect::<Vec<_>>();
                            status = Some(if values.len() == 2 && values[0] == values[1] { "AC".into() } else if score.is_empty() { "JUDGING".into() } else { format!("SCORE {score}") });
                            submission_url = Some(url.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
        statuses.push(SubmissionStatus { source_url: problem.source_url, status, submission_url, submitted_at, submissions: Vec::new() });
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
                            problem.judge_status = statuses[index].status.clone();
                            record_submission(&mut problem.submissions, &statuses[index]);
                            statuses[index].submissions = problem.submissions.clone();
                        }
                    }
                }
                write_workspace_metadata(&metadata_path, &metadata, "save submission statuses")?;
            }
        }
    }
    Ok(statuses)
}

#[tauri::command]
pub(crate) async fn refresh_submission_statuses(request: SubmissionStatusRequest) -> Result<Vec<SubmissionStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || refresh_submission_statuses_sync(request)).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submission_history_follows_one_verdict_and_appends_the_next() {
        let status = |verdict: &str, url: Option<&str>, at: u64| SubmissionStatus {
            source_url: "https://atcoder.jp/contests/abc400/tasks/abc400_a".into(),
            status: Some(verdict.into()),
            submission_url: url.map(str::to_string),
            submitted_at: at,
            submissions: Vec::new(),
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
        record_submission(&mut empty, &SubmissionStatus { source_url: String::new(), status: None, submission_url: None, submitted_at: 0, submissions: Vec::new() });
        assert!(empty.is_empty());
        let mut long = Vec::new();
        for index in 0..60 {
            record_submission(&mut long, &status("WA", Some(&format!("s/{index}")), index));
        }
        assert_eq!(long.len(), 50);
        assert_eq!(long[0].url.as_deref(), Some("s/10"));
    }
}
