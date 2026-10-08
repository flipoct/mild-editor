//! Importing problems and their sample tests from AtCoder, Codeforces and DOJ.

use serde::Serialize;
use std::time::Duration;

use crate::submissions::codeforces_problem_key;
use crate::workspace::SavedTestCase;
use crate::HTTP_CONNECT_TIMEOUT;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedAtCoderProblem {
    title: String,
    suggested_filename: String,
    tests: Vec<SavedTestCase>,
    source: String,
    source_url: String,
    /// The contest's name, where the importer reads one; it names the contest's folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    contest: Option<String>,
}

fn parse_atcoder_samples(html: &str) -> Vec<SavedTestCase> {
    let document = scraper::Html::parse_document(&html);
    let english_heading_selector =
        scraper::Selector::parse("#task-statement .lang-en h3").unwrap();
    let fallback_heading_selector = scraper::Selector::parse("#task-statement h3").unwrap();
    let pre_selector = scraper::Selector::parse("pre").unwrap();
    let mut inputs: Vec<(String, String)> = Vec::new();
    let mut outputs: Vec<(String, String)> = Vec::new();
    // AtCoder sends both the Japanese and English statements even with
    // `?lang=en`. Reading the broad selector as well as `.lang-en` therefore
    // imported every sample twice. Prefer the English block and only fall back
    // to the whole statement for old Japanese-only problems.
    let english_headings = document.select(&english_heading_selector).collect::<Vec<_>>();
    let headings = if english_headings.is_empty() {
        document.select(&fallback_heading_selector).collect::<Vec<_>>()
    } else {
        english_headings
    };
    for heading in headings {
        let heading_text = heading.text().collect::<String>().trim().to_string();
        let is_input = heading_text.contains("Sample Input") || heading_text.contains("入力例");
        let is_output = heading_text.contains("Sample Output") || heading_text.contains("出力例");
        // Unicode escapes keep Japanese-only legacy statements independent of
        // the source file's or Windows console's text encoding.
        let is_input = is_input || heading_text.contains("\u{5165}\u{529b}\u{4f8b}");
        let is_output = is_output || heading_text.contains("\u{51fa}\u{529b}\u{4f8b}");
        if !is_input && !is_output {
            continue;
        }
        let number = heading_text
            .chars()
            .filter(|character| character.is_ascii_digit())
            .collect::<String>();
        let mut sibling = heading.next_sibling();
        while let Some(node) = sibling {
            if let Some(element) = scraper::ElementRef::wrap(node) {
                if element.value().name() == "h3" { break; }
                let sample = if element.value().name() == "pre" {
                    Some(element)
                } else {
                    element.select(&pre_selector).next()
                };
                if let Some(sample) = sample {
                    let value = sample
                        .text()
                        .collect::<String>()
                        .replace("\r\n", "\n")
                        .trim_end()
                        .to_string();
                    if is_input {
                        inputs.push((number.clone(), value));
                    } else {
                        outputs.push((number.clone(), value));
                    }
                    break;
                }
            }
            sibling = node.next_sibling();
        }
    }
    let mut tests = Vec::new();
    let mut seen_tests = std::collections::HashSet::new();
    for (index, (number, input)) in inputs.into_iter().enumerate() {
        if let Some((_, expected)) = outputs
            .iter()
            .find(|(output_number, _)| output_number == &number)
            .or_else(|| outputs.get(index))
        {
            if !seen_tests.insert((input.clone(), expected.clone())) {
                continue;
            }
            tests.push(SavedTestCase {
                name: format!(
                    "test {}",
                    if number.is_empty() {
                        (index + 1).to_string()
                    } else {
                        number
                    }
                ),
                input,
                expected: expected.clone(),
            });
        }
    }
    tests
}

fn fetch_atcoder_problem(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<ImportedAtCoderProblem, String> {
    let mut parsed = reqwest::Url::parse(url)
        .map_err(|_| "Problem not found. Enter a valid AtCoder, Codeforces, or DOJ URL.".to_string())?;
    if parsed.host_str() != Some("atcoder.jp") || !parsed.path().contains("/tasks/") {
        return Err("Problem not found. Enter a valid AtCoder problem URL.".into());
    }
    parsed.query_pairs_mut().append_pair("lang", "en");
    let html = client
        .get(parsed.clone())
        .send()
        .map_err(|error| format!("Could not fetch the problem page: {error}"))?
        .error_for_status()
        .map_err(|error| format!("AtCoder returned an error: {error}"))?
        .text()
        .map_err(|error| error.to_string())?;
    let document = scraper::Html::parse_document(&html);
    let title_selector = scraper::Selector::parse("span.h2, .h2").unwrap();
    let tests = parse_atcoder_samples(&html);
    if tests.is_empty() {
        return Err("No sample test cases were found on this page.".into());
    }
    let title = document
        .select(&title_selector)
        .next()
        .map(|element| {
            element
                .text()
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            parsed
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .unwrap_or("AtCoder problem")
                .to_string()
        });
    let task_id = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or("problem");
    let letter = task_id.rsplit('_').next().unwrap_or(task_id).to_uppercase();
    Ok(ImportedAtCoderProblem {
        title,
        suggested_filename: format!("{letter}.cpp"),
        tests,
        source: "atcoder".into(),
        source_url: parsed.to_string(),
        contest: None,
    })
}

fn codeforces_pre_text(pre: scraper::ElementRef<'_>) -> String {
    let line_selector = scraper::Selector::parse(".test-example-line").unwrap();
    let lines = pre.select(&line_selector).map(|line| line.text().collect::<String>().trim().to_string()).filter(|line| !line.is_empty()).collect::<Vec<_>>();
    if !lines.is_empty() {
        lines.join("\n")
    } else {
        pre.text().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
    }
}

fn parse_codeforces_html(html: &str) -> Option<(String, Vec<SavedTestCase>)> {
    let document = scraper::Html::parse_document(html);
    let title_selector = scraper::Selector::parse(".problem-statement .header .title").unwrap();
    let sample_selector = scraper::Selector::parse(".problem-statement .sample-test").unwrap();
    let input_selector = scraper::Selector::parse(".input pre").unwrap();
    let output_selector = scraper::Selector::parse(".output pre").unwrap();
    let title = document.select(&title_selector).next().map(|element| element.text().collect::<String>().trim().to_string()).unwrap_or_else(|| "Codeforces problem".into());
    let mut tests = Vec::new();
    for sample in document.select(&sample_selector) {
        let input = sample.select(&input_selector).next().map(codeforces_pre_text);
        let expected = sample.select(&output_selector).next().map(codeforces_pre_text);
        if let (Some(input), Some(expected)) = (input, expected) {
            if !input.is_empty() && !expected.is_empty() {
                tests.push(SavedTestCase { name: format!("test {}", tests.len() + 1), input, expected });
            }
        }
    }
    (!tests.is_empty()).then_some((title, tests))
}

/// Parse the live contest table first, as Competitive Companion does in the browser.
/// The public problemset API can lag behind while a round is still running.
fn parse_codeforces_contest_urls(html: &str, base_url: &reqwest::Url) -> Vec<String> {
    let document = scraper::Html::parse_document(html);
    let link_selector = scraper::Selector::parse(".problems > tbody > tr > td:first-child > a, ._ProblemsPage_problems > table > tbody > tr > td:first-child > a").unwrap();
    let mut urls = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for link in document.select(&link_selector) {
        let Some(href) = link.value().attr("href") else { continue };
        let Ok(problem_url) = base_url.join(href) else { continue };
        if !problem_url.path().contains("/problem/") { continue; }
        let key = problem_url.path().trim_end_matches('/').to_ascii_lowercase();
        if seen.insert(key) { urls.push(problem_url.to_string()); }
    }
    urls
}

fn parse_codeforces_markdown(markdown: &str) -> Option<(String, Vec<SavedTestCase>)> {
    let title = markdown.lines().find_map(|line| line.strip_prefix("Title: ")).unwrap_or("Codeforces problem").trim().to_string();
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut tests = Vec::new();
    let mut cursor = lines.iter().position(|line| matches!(line.trim(), "Examples" | "Example")).unwrap_or(lines.len());
    while cursor < lines.len() {
        if lines[cursor].trim() != "Input" { cursor += 1; continue; }
        cursor += 1;
        while cursor < lines.len() && (lines[cursor].trim().is_empty() || lines[cursor].trim() == "Copy" || lines[cursor].trim() == "```") { cursor += 1; }
        let mut input = Vec::new();
        while cursor < lines.len() && lines[cursor].trim() != "Output" {
            let line = lines[cursor].trim_end();
            if !line.trim().is_empty() && line.trim() != "```" && line.trim() != "Copy" { input.push(line); }
            cursor += 1;
        }
        if cursor >= lines.len() { break; }
        cursor += 1;
        while cursor < lines.len() && (lines[cursor].trim().is_empty() || lines[cursor].trim() == "Copy" || lines[cursor].trim() == "```") { cursor += 1; }
        let mut output = Vec::new();
        while cursor < lines.len() && !matches!(lines[cursor].trim(), "Input" | "Note" | "Tutorial" | "Codeforces") {
            let line = lines[cursor].trim_end();
            if !line.trim().is_empty() && line.trim() != "```" && line.trim() != "Copy" { output.push(line); }
            cursor += 1;
        }
        if !input.is_empty() && !output.is_empty() {
            tests.push(SavedTestCase { name: format!("test {}", tests.len() + 1), input: input.join("\n"), expected: output.join("\n") });
        }
    }
    (!tests.is_empty()).then_some((title, tests))
}

fn parse_codeforces_targeted_block(markdown: &str, heading: &str) -> Option<String> {
    let content = markdown.split_once("Markdown Content:").map(|(_, content)| content).unwrap_or(markdown);
    let lines = content.lines()
        .map(str::trim_end)
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && trimmed != heading && trimmed != "Copy" && trimmed != "```"
        })
        .collect::<Vec<_>>();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn fetch_codeforces_targeted_block(client: &reqwest::blocking::Client, reader_url: &str, selector: &str, heading: &str) -> Option<String> {
    let body = client.get(reader_url)
        .header("X-Target-Selector", selector)
        .header("X-Wait-For-Selector", ".sample-test")
        .header("X-No-Cache", "true")
        .send().ok()?.error_for_status().ok()?.text().ok()?;
    parse_codeforces_targeted_block(&body, heading)
}

fn fetch_codeforces_problem(client: &reqwest::blocking::Client, url: &str) -> Result<ImportedAtCoderProblem, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid Codeforces problem URL.".to_string())?;
    let segments = parsed.path_segments().map(|values| values.collect::<Vec<_>>()).unwrap_or_default();
    let marker = segments.iter().position(|value| *value == "problem").ok_or("This is not a Codeforces problem URL.")?;
    let (contest, letter) = if segments.get(marker + 2).is_some() {
        (segments[marker + 1], segments[marker + 2])
    } else {
        (segments.get(marker.wrapping_sub(1)).copied().ok_or("Missing contest ID.")?, segments.get(marker + 1).copied().ok_or("Missing problem ID.")?)
    };
    let mut live_url = parsed.clone();
    live_url.query_pairs_mut().append_pair("locale", "en");
    let direct_urls = [
        live_url.to_string(),
        format!("https://codeforces.com/contest/{contest}/problem/{letter}?locale=en"),
        format!("https://codeforces.com/problemset/problem/{contest}/{letter}?locale=en"),
    ];
    let mut seen_direct_urls = std::collections::HashSet::new();
    for direct_url in direct_urls {
        if !seen_direct_urls.insert(direct_url.clone()) { continue; }
        if let Ok(html) = client.get(&direct_url).timeout(Duration::from_secs(8)).send().and_then(|response| response.error_for_status()).and_then(|response| response.text()) {
            if let Some((title, tests)) = parse_codeforces_html(&html) {
                return Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{}.cpp", letter.to_uppercase()), tests, source: "codeforces".into(), source_url: url.to_string(), contest: None });
            }
        }
    }
    let reader_urls = [
        format!("https://r.jina.ai/https://codeforces.com/contest/{contest}/problem/{letter}?locale=en"),
        format!("https://r.jina.ai/https://codeforces.com/problemset/problem/{contest}/{letter}?locale=en"),
        format!("https://r.jina.ai/http://codeforces.com/problemset/problem/{contest}/{letter}?locale=en"),
        format!("https://r.jina.ai/https://codeforces.com/problemset/problem/{contest}/{letter}"),
    ];
    let mut last_error = "Codeforces did not return a readable problem statement.".to_string();
    let mut fallback_title = "Codeforces problem".to_string();
    for reader_url in &reader_urls {
        match client.get(reader_url).send().and_then(|response| response.error_for_status()).and_then(|response| response.text()) {
            Ok(body) => {
                if let Some(title) = body.lines().find_map(|line| line.strip_prefix("Title: ")) { fallback_title = title.trim().to_string(); }
                if let Some((title, tests)) = parse_codeforces_markdown(&body) {
                    return Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{}.cpp", letter.to_uppercase()), tests, source: "codeforces".into(), source_url: url.to_string(), contest: None });
                }
                last_error = "Codeforces returned a statement without readable sample test cases.".into();
            }
            Err(error) => last_error = format!("Could not fetch Codeforces: {error}"),
        }
    }
    for reader_url in &reader_urls {
        let input = fetch_codeforces_targeted_block(client, reader_url, ".sample-test .input", "Input");
        let expected = fetch_codeforces_targeted_block(client, reader_url, ".sample-test .output", "Output");
        if let (Some(input), Some(expected)) = (input, expected) {
            let tests = vec![SavedTestCase { name: "test 1".into(), input, expected }];
            return Ok(ImportedAtCoderProblem { title: fallback_title, suggested_filename: format!("{}.cpp", letter.to_uppercase()), tests, source: "codeforces".into(), source_url: url.to_string(), contest: None });
        }
    }
    Err(last_error)
}

fn fetch_doj_problem(client: &reqwest::blocking::Client, url: &str) -> Result<ImportedAtCoderProblem, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid DOJ problem URL.".to_string())?;
    let problem_id = parsed.path_segments().and_then(|mut values| values.next_back()).filter(|value| !value.is_empty()).ok_or("Missing DOJ problem ID.")?.to_string();
    let html = client.get(parsed).send().map_err(|error| format!("Could not fetch DOJ: {error}"))?
        .error_for_status().map_err(|error| format!("DOJ response error: {error}"))?.text().map_err(|error| error.to_string())?;
    let document = scraper::Html::parse_document(&html);
    let block_selector = scraper::Selector::parse(".sample-block").unwrap();
    let code_selector = scraper::Selector::parse(".code-block").unwrap();
    let title_selector = scraper::Selector::parse("title").unwrap();
    let mut tests = Vec::new();
    for block in document.select(&block_selector) {
        let values = block.select(&code_selector).map(|element| element.text().collect::<String>().replace("\r\n", "\n").trim().to_string()).collect::<Vec<_>>();
        if values.len() >= 2 { tests.push(SavedTestCase { name: format!("test {}", tests.len() + 1), input: values[0].clone(), expected: values[1].clone() }); }
    }
    if tests.is_empty() { return Err("No sample test cases found on DOJ.".into()); }
    let title = document.select(&title_selector).next().map(|element| element.text().collect::<String>().replace(" | DOJ", "")).unwrap_or_else(|| format!("DOJ #{problem_id}"));
    Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{problem_id}.cpp"), tests, source: "doj".into(), source_url: url.to_string(), contest: None })
}

/// The problems a DOJ contest page links to, in the order the contest lists them. Each link
/// is `/<locale>/problems/<id>?contest=<key>`; the key only matters to a logged-in participant
/// while the contest runs, so the plain problem page is what gets imported.
fn doj_contest_problem_urls(html: &str, base: &reqwest::Url) -> Vec<String> {
    let document = scraper::Html::parse_document(html);
    let link_selector = scraper::Selector::parse("a[href]").unwrap();
    let mut seen = std::collections::HashSet::new();
    let mut urls = Vec::new();
    for link in document.select(&link_selector) {
        let Some(href) = link.value().attr("href") else { continue };
        if !href.contains("/problems/") || !href.contains("contest=") { continue; }
        let Ok(mut url) = base.join(href) else { continue };
        let is_problem = url.path_segments().and_then(|mut parts| parts.next_back()).is_some_and(|id| !id.is_empty() && id.chars().all(|character| character.is_ascii_digit()));
        if !is_problem { continue; }
        url.set_query(None);
        url.set_fragment(None);
        if seen.insert(url.to_string()) { urls.push(url.to_string()); }
    }
    urls
}

/// `A`, `B`, … `Z`, then `A1`, `B1`, …: the index a contest gives its problems.
fn contest_letter(index: usize) -> String {
    let letter = (b'A' + (index % 26) as u8) as char;
    if index < 26 { letter.to_string() } else { format!("{letter}{}", index / 26) }
}

fn fetch_doj_contest(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<ImportedAtCoderProblem>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid DOJ contest URL.".to_string())?;
    let html = client.get(parsed.clone()).send().map_err(|error| format!("Could not fetch DOJ: {error}"))?
        .error_for_status().map_err(|error| format!("DOJ response error: {error}"))?.text().map_err(|error| error.to_string())?;
    let problem_urls = doj_contest_problem_urls(&html, &parsed);
    if problem_urls.is_empty() {
        // DOJ shows a running contest's problems only to a participant who is logged in.
        return Err("This DOJ contest does not list its problems publicly. While a contest is running, open each problem in the problem browser and import it from there.".into());
    }
    let title_selector = scraper::Selector::parse("title").unwrap();
    let contest = scraper::Html::parse_document(&html).select(&title_selector).next()
        .map(|element| element.text().collect::<String>().replace(" | DOJ", "").trim().to_string())
        .filter(|title| !title.is_empty());
    let mut problems = Vec::new();
    for (index, problem_url) in problem_urls.into_iter().take(30).enumerate() {
        let mut problem = fetch_doj_problem(client, &problem_url)?;
        problem.suggested_filename = format!("{}.cpp", contest_letter(index));
        // "#286 49" names the problem by its number in the archive; in a contest the letter does that.
        if let Some((number, name)) = problem.title.split_once(' ') {
            if number.starts_with('#') && !name.trim().is_empty() { problem.title = name.trim().to_string(); }
        }
        problem.contest = contest.clone();
        problems.push(problem);
    }
    Ok(problems)
}

fn fetch_codeforces_contest(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<ImportedAtCoderProblem>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid Codeforces contest URL.".to_string())?;
    let segments = parsed.path_segments().map(|values| values.collect::<Vec<_>>()).unwrap_or_default();
    let contest_marker = segments.iter().position(|value| *value == "contest").ok_or("This is not a Codeforces contest URL.")?;
    let contest = segments.get(contest_marker + 1).ok_or("Missing Codeforces contest ID.")?;
    let prefix = format!("https://codeforces.com/contest/{contest}/problem/");
    let mut urls = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Prefer the exact contest page. It contains the live problem table before
    // the global problemset API has necessarily published the round.
    let mut live_page = parsed.clone();
    live_page.query_pairs_mut().append_pair("locale", "en");
    let contest_pages = [
        live_page,
        reqwest::Url::parse(&format!("https://codeforces.com/contest/{contest}/problems?locale=en")).unwrap(),
    ];
    for page_url in contest_pages {
        let Ok(html) = client.get(page_url.clone()).timeout(Duration::from_secs(8)).send().and_then(|response| response.error_for_status()).and_then(|response| response.text()) else { continue };
        for problem_url in parse_codeforces_contest_urls(&html, &page_url) {
            let Some((_, index)) = codeforces_problem_key(&problem_url) else { continue };
            if seen.insert(index) { urls.push(problem_url); }
        }
        if !urls.is_empty() { break; }
    }

    let contest_id = contest.parse::<i64>().map_err(|_| "Invalid Codeforces contest ID.")?;
    if urls.is_empty() {
        let mut standings_url = reqwest::Url::parse("https://codeforces.com/api/contest.standings").unwrap();
        // Codeforces rejects pagination parameters for anonymous non-gym
        // standings requests, so only pass the contest id.
        standings_url.query_pairs_mut().append_pair("contestId", contest);
        if let Ok(value) = client.get(standings_url).send().and_then(|response| response.error_for_status()).and_then(|response| response.json::<serde_json::Value>()) {
            if value.get("status").and_then(|status| status.as_str()) == Some("OK") {
                if let Some(problems) = value.pointer("/result/problems").and_then(|problems| problems.as_array()) {
                    for problem in problems {
                        if let Some(index) = problem.get("index").and_then(|index| index.as_str()) {
                            if seen.insert(index.to_ascii_uppercase()) { urls.push(format!("{prefix}{index}")); }
                        }
                    }
                }
            }
        }
    }
    if urls.is_empty() {
        if let Ok(value) = client.get("https://codeforces.com/api/problemset.problems").send().and_then(|response| response.error_for_status()).and_then(|response| response.json::<serde_json::Value>()) {
            if value.get("status").and_then(|status| status.as_str()) == Some("OK") {
                if let Some(problems) = value.pointer("/result/problems").and_then(|problems| problems.as_array()) {
                    for problem in problems {
                        if problem.get("contestId").and_then(|value| value.as_i64()) != Some(contest_id) { continue; }
                        if let Some(index) = problem.get("index").and_then(|index| index.as_str()) {
                            if seen.insert(index.to_ascii_uppercase()) { urls.push(format!("{prefix}{index}")); }
                        }
                    }
                }
            }
        }
    }

    if urls.is_empty() {
        let reader_url = format!("https://r.jina.ai/https://codeforces.com/contest/{contest}?locale=en");
        let markdown = client.get(reader_url).send().map_err(|error| format!("Could not fetch Codeforces contest: {error}"))?
            .error_for_status().map_err(|error| format!("Codeforces response error: {error}"))?.text().map_err(|error| error.to_string())?;
        for part in markdown.split(&prefix).skip(1) {
            let letter = part.chars().take_while(|character| character.is_ascii_alphanumeric()).collect::<String>();
            if !letter.is_empty() && seen.insert(letter.to_ascii_uppercase()) { urls.push(format!("{prefix}{letter}")); }
        }
    }
    if urls.is_empty() { return Err("No problems found in the Codeforces contest.".into()); }
    urls.sort();
    let mut problems = Vec::new();
    let mut errors = Vec::new();
    for problem_url in urls.into_iter().take(30) {
        match fetch_codeforces_problem(client, &problem_url) {
            Ok(problem) => problems.push(problem),
            Err(error) => errors.push(error),
        }
    }
    if problems.is_empty() {
        Err(errors.into_iter().next().unwrap_or_else(|| "No Codeforces samples could be imported.".into()))
    } else {
        Ok(problems)
    }
}

#[tauri::command]
pub(crate) async fn import_problem(url: String) -> Result<Vec<ImportedAtCoderProblem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent(format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 MildEditor/{}", env!("CARGO_PKG_VERSION")))
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(reqwest::header::ACCEPT, reqwest::header::HeaderValue::from_static("text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"));
                headers.insert(reqwest::header::ACCEPT_LANGUAGE, reqwest::header::HeaderValue::from_static("en-US,en;q=0.9"));
                headers
            })
            .timeout(Duration::from_secs(20))
            .connect_timeout(HTTP_CONNECT_TIMEOUT)
            .build()
            .map_err(|error| error.to_string())?;
        let parsed = reqwest::Url::parse(&url)
            .map_err(|_| "Problem not found. Enter a valid AtCoder, Codeforces, or DOJ URL.".to_string())?;
        if matches!(parsed.host_str(), Some("codeforces.com") | Some("www.codeforces.com")) {
            if parsed.path().contains("/problem/") {
                return fetch_codeforces_problem(&client, &url).map(|problem| vec![problem]);
            }
            return fetch_codeforces_contest(&client, &url);
        }
        if matches!(parsed.host_str(), Some("doj.kr") | Some("www.doj.kr")) {
            if parsed.path_segments().is_some_and(|mut parts| parts.any(|part| part == "contests")) {
                return fetch_doj_contest(&client, &url);
            }
            return fetch_doj_problem(&client, &url).map(|problem| vec![problem]);
        }
        if parsed.host_str() != Some("atcoder.jp") {
            return Err("Problem not found. Enter a valid AtCoder, Codeforces, or DOJ URL.".into());
        }
        if parsed.path().contains("/tasks/") {
            return fetch_atcoder_problem(&client, &url).map(|problem| vec![problem]);
        }

        let segments = parsed
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())
            .unwrap_or_default();
        let contest_index = segments
            .iter()
            .position(|segment| *segment == "contests")
            .ok_or("Contest not found. Enter a valid AtCoder contest URL.")?;
        let contest_id = segments
            .get(contest_index + 1)
            .filter(|value| !value.is_empty())
            .ok_or("Contest not found. The contest ID is missing from the URL.")?;
        let tasks_url = format!("https://atcoder.jp/contests/{contest_id}/tasks?lang=en");
        let html = client
            .get(&tasks_url)
            .send()
            .map_err(|error| format!("Could not fetch the contest problem list: {error}"))?
            .error_for_status()
            .map_err(|error| format!("AtCoder returned an error: {error}"))?
            .text()
            .map_err(|error| error.to_string())?;
        let document = scraper::Html::parse_document(&html);
        let link_selector = scraper::Selector::parse("table tbody tr td a").unwrap();
        let mut task_urls = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for link in document.select(&link_selector) {
            if let Some(href) = link.value().attr("href") {
                if href.contains("/tasks/") && seen.insert(href.to_string()) {
                    task_urls.push(format!("https://atcoder.jp{href}"));
                }
            }
        }
        if task_urls.is_empty() {
            return Err("No problems were found in this contest.".into());
        }
        let mut problems = Vec::new();
        for task_url in task_urls.into_iter().take(30) {
            problems.push(fetch_atcoder_problem(&client, &task_url)?);
        }
        Ok(problems)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doj_contest_page_yields_its_problems_in_order() {
        let base = reqwest::Url::parse("https://doj.kr/ko/contests/bcd7").unwrap();
        let html = r#"<a href="/ko/problems">all</a>
            <a href="/ko/problems/286?contest=key">A</a><a href="/ko/problems/362?contest=key">B</a>
            <a href="/ko/problems/286?contest=key">A again</a><a href="/ko/problems/286/editorial?contest=key">editorial</a>
            <a href="/ko/contests/bcd7/standings">standings</a>"#;
        assert_eq!(doj_contest_problem_urls(html, &base), vec!["https://doj.kr/ko/problems/286", "https://doj.kr/ko/problems/362"]);
        assert!(doj_contest_problem_urls("<a href=\"/ko/login\">login</a>", &base).is_empty());
        assert_eq!([contest_letter(0), contest_letter(8), contest_letter(25), contest_letter(26)], ["A", "I", "Z", "A1"]);
    }

    #[test]
    #[ignore = "requires access to atcoder.jp"]
    fn fetches_current_atcoder_samples() {
        let client = reqwest::blocking::Client::builder()
            .user_agent("MildEditor/test")
            .build()
            .unwrap();
        let problem =
            fetch_atcoder_problem(&client, "https://atcoder.jp/contests/abc414/tasks/abc414_a")
                .unwrap();
        assert_eq!(problem.suggested_filename, "A.cpp");
        assert_eq!(problem.tests.len(), 3);
    }

    #[test]
    fn atcoder_bilingual_statement_imports_each_sample_once() {
        let html = r#"
            <div id="task-statement">
              <span class="lang-ja">
                <h3>入力例 1</h3><pre>3
</pre>
                <h3>出力例 1</h3><pre>6
</pre>
              </span>
              <span class="lang-en">
                <h3>Sample Input 1</h3><pre>3
</pre>
                <h3>Sample Output 1</h3><pre>6
</pre>
              </span>
            </div>
        "#;
        let tests = parse_atcoder_samples(html);
        assert_eq!(tests.len(), 1);
        assert_eq!(tests[0].input, "3");
        assert_eq!(tests[0].expected, "6");
    }

    #[test]
    fn atcoder_japanese_only_statement_uses_fallback_samples() {
        let html = r#"
            <div id="task-statement">
              <h3>入力例 1</h3><pre>4
</pre>
              <h3>出力例 1</h3><pre>8
</pre>
            </div>
        "#;
        let tests = parse_atcoder_samples(html);
        assert_eq!(tests.len(), 1);
        assert_eq!(tests[0].input, "4");
        assert_eq!(tests[0].expected, "8");
    }

    #[test]
    fn atcoder_samples_support_nested_live_statement_markup() {
        let html = r#"<div id="task-statement"><span class="lang-en"><h3>Sample Input 1</h3><div class="sample"><pre>2 3</pre></div><h3>Sample Output 1</h3><div class="sample"><pre>5</pre></div></span></div>"#;
        let tests = parse_atcoder_samples(html);
        assert_eq!(tests.len(), 1);
        assert_eq!(tests[0].input, "2 3");
        assert_eq!(tests[0].expected, "5");
    }

    #[test]
    #[ignore = "requires access to codeforces.com through r.jina.ai"]
    fn fetches_codeforces_problem_and_contest_samples() {
        let client = reqwest::blocking::Client::builder()
            .user_agent("MildEditor/test")
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        let problem = fetch_codeforces_problem(&client, "https://codeforces.com/contest/2120/problem/A").unwrap();
        assert_eq!(problem.suggested_filename, "A.cpp");
        assert!(!problem.tests.is_empty());
        let recent_problem = fetch_codeforces_problem(&client, "https://codeforces.com/contest/2231/problem/C").unwrap();
        assert_eq!(recent_problem.suggested_filename, "C.cpp");
        assert_eq!(recent_problem.tests[0].input.lines().next(), Some("5"));
        assert_eq!(recent_problem.tests[0].expected.lines().next(), Some("3"));
        let emotes = fetch_codeforces_problem(&client, "https://codeforces.com/contest/1117/problem/B").unwrap();
        assert_eq!(emotes.suggested_filename, "B.cpp");
        assert_eq!(emotes.tests.len(), 2);
        assert_eq!(emotes.tests[0].input, "6 9 2\n1 3 3 7 4 2");
        assert_eq!(emotes.tests[0].expected, "54");
        let contest = fetch_codeforces_contest(&client, "https://codeforces.com/contest/4").unwrap();
        assert!(!contest.is_empty());
    }

    #[test]
    #[ignore = "requires access to codeforces.com through r.jina.ai"]
    fn fetches_codeforces_2257b_samples() {
        let client = reqwest::blocking::Client::builder()
            .user_agent("MildEditor/test")
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        let problem = fetch_codeforces_problem(&client, "https://codeforces.com/contest/2257/problem/B").unwrap();
        assert_eq!(problem.suggested_filename, "B.cpp");
        assert_eq!(problem.tests.len(), 1);
        assert_eq!(problem.tests[0].input.lines().next(), Some("6"));
        assert_eq!(problem.tests[0].input.lines().last(), Some("7 5"));
        assert_eq!(problem.tests[0].expected, "1\n2\n2\n2\n1\n2");
    }

    #[test]
    fn parses_modern_codeforces_sample_markup() {
        let html = r#"<div class="problem-statement"><div class="header"><div class="title">C. Example</div></div><div class="sample-test"><div class="input"><pre><div class="test-example-line">5</div><div class="test-example-line">3 2 4</div></pre></div><div class="output"><pre><div class="test-example-line">3</div><div class="test-example-line">11</div></pre></div></div></div>"#;
        let (title, tests) = parse_codeforces_html(html).expect("parse Codeforces sample");
        assert_eq!(title, "C. Example");
        assert_eq!(tests.len(), 1);
        assert_eq!(tests[0].input, "5\n3 2 4");
        assert_eq!(tests[0].expected, "3\n11");
    }

    #[test]
    fn parses_live_codeforces_contest_problem_links() {
        let html = r#"<table class="problems"><tbody><tr><td><a href="/contest/9999/problem/A">A</a></td></tr><tr><td><a href="/contest/9999/problem/B2">B2</a></td></tr></tbody></table>"#;
        let base = reqwest::Url::parse("https://codeforces.com/contest/9999?locale=en").unwrap();
        assert_eq!(parse_codeforces_contest_urls(html, &base), vec!["https://codeforces.com/contest/9999/problem/A".to_string(), "https://codeforces.com/contest/9999/problem/B2".to_string()]);
    }

    #[test]
    fn parses_codeforces_markdown_copy_blocks() {
        let markdown = r#"Title: Problem - 1117B - Codeforces

Markdown Content:
Examples

Input

Copy

6 9 2
1 3 3 7 4 2

Output

Copy

54

Input

Copy

3 1000000000 1
1000000000 987654321 1000000000

Output

Copy

1000000000000000000

Note
"#;
        let (_, tests) = parse_codeforces_markdown(markdown).expect("parse Codeforces markdown samples");
        assert_eq!(tests.len(), 2);
        assert_eq!(tests[0].input, "6 9 2\n1 3 3 7 4 2");
        assert_eq!(tests[0].expected, "54");
        assert_eq!(tests[1].expected, "1000000000000000000");
    }

    #[test]
    fn parses_codeforces_targeted_copy_block() {
        let markdown = "Title: Problem - B - Codeforces\n\nMarkdown Content:\nInput\n\nCopy\n\n6\n\n1 1\n\n7 5\n";
        assert_eq!(parse_codeforces_targeted_block(markdown, "Input").as_deref(), Some("6\n1 1\n7 5"));
    }
}
