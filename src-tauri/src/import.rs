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

/// Leads the error of an import that only a browser can make: Cloudflare's check in front of
/// Codeforces, or a page a judge shows to nobody but a logged-in participant. The frontend
/// knows it by this prefix and takes the page to the problem browser, whose session is the
/// user's own, instead of showing the text.
pub(crate) const NEEDS_BROWSER: &str = "needs-browser: ";

/// Whether a response is Cloudflare's interstitial rather than the page that was asked for.
/// Codeforces answers a client it takes for a script with a 403 carrying
/// `cf-mitigated: challenge` and a "Just a moment..." page that runs the check in JavaScript.
/// The header is what Cloudflare documents for telling its challenge from the origin's own
/// 403; the body markers cover a proxy that drops it. `/cdn-cgi/challenge-platform/` alone
/// proves nothing, since every ordinary Codeforces page loads a script from there.
///
/// The check is not something to get past from here: the only answer to it is a browser.
pub(crate) fn is_cloudflare_challenge(status: u16, mitigated: Option<&str>, body: &str) -> bool {
    if mitigated.is_some_and(|value| value.trim().eq_ignore_ascii_case("challenge")) { return true; }
    matches!(status, 403 | 429 | 503) && ["_cf_chl_opt", "challenge-error-text", "/cdn-cgi/challenge-platform/h/"].iter().any(|marker| body.contains(marker))
}

/// The [`NEEDS_BROWSER`] error for a judge that answered with the challenge.
pub(crate) fn challenge_error(judge: &str) -> String {
    format!("{NEEDS_BROWSER}{judge} answered with Cloudflare's browser check instead of the page. Open the page in the problem browser and import it from there.")
}

/// A page's text, or `Err` with the [`NEEDS_BROWSER`] error when Cloudflare stood in for it.
/// `Ok(None)` is any other failure, which the callers have fallbacks for.
fn fetch_unless_challenged(client: &reqwest::blocking::Client, url: &str, judge: &str) -> Result<Option<String>, String> {
    let Ok(response) = client.get(url).timeout(Duration::from_secs(8)).send() else { return Ok(None) };
    let status = response.status();
    let mitigated = response.headers().get("cf-mitigated").and_then(|value| value.to_str().ok()).map(str::to_string);
    let Ok(body) = response.text() else { return Ok(None) };
    if is_cloudflare_challenge(status.as_u16(), mitigated.as_deref(), &body) { return Err(challenge_error(judge)); }
    Ok(status.is_success().then_some(body))
}

/// The problem's name from the task page's heading. Once a contest is over the heading also
/// holds the editorial button — `<span class="h2">A - Name <a class="btn">Editorial</a></span>`,
/// `解説` on the Japanese page — so only the heading's own text counts, whatever language
/// the button is in. A running contest has no button, which is how this went unnoticed.
fn parse_atcoder_title(document: &scraper::Html) -> Option<String> {
    let title_selector = scraper::Selector::parse("span.h2, .h2").unwrap();
    let heading = document.select(&title_selector).next()?;
    let words = |text: String| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let own = words(heading.children().filter_map(|node| node.value().as_text().map(|text| text.to_string())).collect());
    // Should the name ever move into an element of its own, the whole heading is still
    // better than the task id.
    let title = if own.is_empty() { words(heading.text().collect()) } else { own };
    (!title.is_empty()).then_some(title)
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
    let tests = parse_atcoder_samples(&html);
    if tests.is_empty() {
        return Err("No sample test cases were found on this page.".into());
    }
    let title = parse_atcoder_title(&document)
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
    // One `.sample-test` holds every example of the problem, input and output in turn.
    for sample in document.select(&sample_selector) {
        for (input, expected) in sample.select(&input_selector).map(codeforces_pre_text).zip(sample.select(&output_selector).map(codeforces_pre_text)) {
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
        // A challenge ends the import here: the check is not this client's to get past, and
        // the user's own browser session is the way through.
        if let Some(html) = fetch_unless_challenged(client, &direct_url, "Codeforces")? {
            if let Some((title, tests)) = parse_codeforces_html(&html) {
                return Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{}.cpp", letter.to_uppercase()), tests, source: "codeforces".into(), source_url: url.to_string(), contest: None });
            }
        }
    }
    // Nothing readable and no challenge: a problem only a participant may see, or a page
    // Codeforces has changed. Either way the user's own browser is what can still read it.
    Err(format!("{NEEDS_BROWSER}Codeforces did not return a readable problem statement. Open the page in the problem browser and import it from there."))
}

/// What a DOJ problem page says: the problem's number in the archive, its name, its samples.
/// The page's `<title>` is `#286 49` — number, then name — and the number is the one address
/// that is the problem's alone: a slug can be another problem's number (#286 is named "49",
/// and `/problems/49` is problem #49).
struct DojProblemPage {
    number: Option<String>,
    name: Option<String>,
    tests: Vec<SavedTestCase>,
}

fn parse_doj_problem(html: &str) -> DojProblemPage {
    let document = scraper::Html::parse_document(html);
    let block_selector = scraper::Selector::parse(".sample-block").unwrap();
    let code_selector = scraper::Selector::parse(".code-block").unwrap();
    let title_selector = scraper::Selector::parse("title").unwrap();
    let mut tests = Vec::new();
    for block in document.select(&block_selector) {
        let values = block.select(&code_selector).map(|element| element.text().collect::<String>().replace("\r\n", "\n").trim().to_string()).collect::<Vec<_>>();
        if values.len() >= 2 { tests.push(SavedTestCase { name: format!("test {}", tests.len() + 1), input: values[0].clone(), expected: values[1].clone() }); }
    }
    let title = document.select(&title_selector).next().map(|element| element.text().collect::<String>().replace(" | DOJ", "").trim().to_string()).unwrap_or_default();
    let numbered = title.strip_prefix('#').and_then(|rest| rest.split_once(' ')).filter(|(number, _)| !number.is_empty() && number.chars().all(|character| character.is_ascii_digit()));
    match numbered {
        Some((number, name)) => DojProblemPage { number: Some(number.to_string()), name: Some(name.trim().to_string()).filter(|name| !name.is_empty()), tests },
        None => DojProblemPage { number: None, name: Some(title).filter(|title| !title.is_empty()), tests },
    }
}

fn fetch_doj_problem(client: &reqwest::blocking::Client, url: &str) -> Result<ImportedAtCoderProblem, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid DOJ problem URL.".to_string())?;
    // `/<locale>/problems/<number or slug>`, or the same with `/ide` after it: the page the
    // editor submits from is as likely to be the one in front of the user.
    let parts = parsed.path_segments().map(|values| values.map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
    let at = parts.iter().position(|part| part == "problems").filter(|at| parts.get(at + 1).is_some_and(|part| !part.is_empty())).ok_or("Missing DOJ problem ID.")? + 1;
    let segment = parts[at].clone();
    // Every link on a contest page is `/problems/<id>?contest=<key>`. To a visitor who is not
    // logged in DOJ answers that with HTTP 200 and a page that holds no statement, only a
    // redirect to the plain problem for the browser to follow (`NEXT_REDIRECT` in the stream),
    // so the plain page is the one to ask for. The key stays in the saved URL: it is what
    // makes a submission from the editor count for the contest.
    let in_contest = parsed.query_pairs().any(|(name, _)| name == "contest");
    let mut page_url = parsed.clone();
    page_url.set_path(&format!("/{}", parts[..=at].join("/")));
    page_url.set_query(None);
    page_url.set_fragment(None);
    let html = client.get(page_url).send().map_err(|error| format!("Could not fetch DOJ: {error}"))?
        .error_for_status().map_err(|error| format!("DOJ response error: {error}"))?.text().map_err(|error| error.to_string())?;
    let page = parse_doj_problem(&html);
    if page.tests.is_empty() {
        // While its contest runs a problem is there for participants only, and to anyone else
        // its page is as empty as that of a problem that does not exist.
        return Err(if in_contest {
            format!("{NEEDS_BROWSER}DOJ shows this contest problem only to a participant who is logged in. Open it in the problem browser and import it from there.")
        } else {
            "No sample test cases found on DOJ.".into()
        });
    }
    // A link by slug (`/problems/bracketstring`) is saved by number: the status page filters
    // by number alone and silently ignores anything else.
    let mut source_url = parsed.clone();
    if let Some(number) = page.number.as_deref().filter(|number| *number != segment) {
        let renumbered = parts.iter().enumerate().map(|(index, part)| if index == at { number } else { part.as_str() }).collect::<Vec<_>>();
        source_url.set_path(&format!("/{}", renumbered.join("/")));
    }
    let number = page.number.unwrap_or(segment);
    // The name alone is the title, as it is from Competitive Companion: the number is the
    // file's name already, and "#286 49" would make the file `286_286_49.cpp`.
    let title = page.name.unwrap_or_else(|| format!("DOJ #{number}"));
    Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{number}.cpp"), tests: page.tests, source: "doj".into(), source_url: source_url.to_string(), contest: None })
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
        // In a contest the letter names the problem, not its number in the archive.
        problem.suggested_filename = format!("{}.cpp", contest_letter(index));
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
        // Challenged here, every problem page will be too: the contest goes to the browser as a whole.
        let Some(html) = fetch_unless_challenged(client, page_url.as_str(), "Codeforces")? else { continue };
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

    if urls.is_empty() { return Err("No problems found in the Codeforces contest.".into()); }
    urls.sort();
    let mut problems = Vec::new();
    let mut errors = Vec::new();
    for problem_url in urls.into_iter().take(30) {
        match fetch_codeforces_problem(client, &problem_url) {
            Ok(problem) => problems.push(problem),
            // Half a contest is worse than the whole of it from the browser.
            Err(error) if error.starts_with(NEEDS_BROWSER) => return Err(error),
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
    fn doj_problem_page_gives_number_name_and_samples() {
        // The shape of doj.kr/ko/problems/286: the name is "49", and the copy buttons sit beside the samples.
        let html = r#"<html><head><title>#286 49</title></head><body><h1 class="problem-title">49</h1>
            <div class="sample-block"><div class="sample-pair">
              <div class="copyable-code-block"><div class="copyable-code-header"><span class="code-label">입력</span><button class="copy-button" type="button">복사</button></div><div class="code-block">3
1
3
10</div></div>
              <div class="copyable-code-block"><div class="copyable-code-header"><span class="code-label">출력</span><button class="copy-button" type="button">복사</button></div><div class="code-block">49
249
949</div></div>
            </div></div></body></html>"#;
        let page = parse_doj_problem(html);
        assert_eq!((page.number.as_deref(), page.name.as_deref()), (Some("286"), Some("49")));
        assert_eq!(page.tests.len(), 1);
        assert_eq!((page.tests[0].input.as_str(), page.tests[0].expected.as_str()), ("3\n1\n3\n10", "49\n249\n949"));

        // What `?contest=<key>` gets a visitor: the title, and a redirect where the statement would be.
        let redirect = parse_doj_problem(r#"<html><head><title>#286 49</title></head><body><script>self.__next_f.push([1,"19:E{\"digest\":\"NEXT_REDIRECT;replace;/ko/problems/286;307;\"}"])</script></body></html>"#);
        assert!(redirect.tests.is_empty());
        let missing = parse_doj_problem("<html><head><title>문제 | DOJ</title></head><body></body></html>");
        assert_eq!((missing.number, missing.name.as_deref()), (None, Some("문제")));
    }

    #[test]
    #[ignore = "requires access to doj.kr"]
    fn fetches_current_doj_problem_and_contest() {
        let client = reqwest::blocking::Client::builder().user_agent("MildEditor/test").timeout(Duration::from_secs(30)).build().unwrap();
        let plain = fetch_doj_problem(&client, "https://doj.kr/ko/problems/286").unwrap();
        assert_eq!((plain.title.as_str(), plain.suggested_filename.as_str(), plain.tests.len()), ("49", "286.cpp", 1));
        // The link a contest page gives: the statement comes from the plain page, the key is kept.
        let keyed = "https://doj.kr/ko/problems/286?contest=cmtimve8l0e0wokcqksb6wqez";
        let from_contest = fetch_doj_problem(&client, keyed).unwrap();
        assert_eq!((from_contest.suggested_filename.as_str(), from_contest.tests.len(), from_contest.source_url.as_str()), ("286.cpp", 1, keyed));
        // The site's own canonical link is by slug; the file and the saved URL go by number.
        let by_slug = fetch_doj_problem(&client, "https://doj.kr/ko/problems/bracketstring").unwrap();
        assert_eq!((by_slug.suggested_filename.as_str(), by_slug.source_url.as_str()), ("634.cpp", "https://doj.kr/ko/problems/634"));
        assert_eq!(by_slug.tests.len(), 2);
        let missing = fetch_doj_problem(&client, "https://doj.kr/ko/problems/99999").err().expect("no such problem");
        assert!(!missing.starts_with(NEEDS_BROWSER), "{missing}");

        let contest = fetch_doj_contest(&client, "https://doj.kr/ko/contests/bcd7").unwrap();
        assert_eq!(contest.len(), 9);
        assert_eq!((contest[0].title.as_str(), contest[0].suggested_filename.as_str(), contest[0].contest.as_deref()), ("49", "A.cpp", Some("DOJ Beginner Contest 7")));
        assert_eq!(contest[8].suggested_filename, "I.cpp");
    }

    #[test]
    fn atcoder_title_leaves_out_the_editorial_button() {
        // The heading of atcoder.jp/contests/abc414/tasks/abc414_a, in English and in Japanese.
        for button in ["Editorial", "解説"] {
            let html = format!("<span class=\"h2\">\n\t\t\tA - Streamer Takahashi\n\t\t\t<a class=\"btn btn-default btn-sm\" href=\"/contests/abc414/tasks/abc414_a/editorial\">{button}</a>\n\t\t</span>");
            assert_eq!(parse_atcoder_title(&scraper::Html::parse_document(&html)).as_deref(), Some("A - Streamer Takahashi"));
        }
        // While the contest runs there is no button, and a name may hold the word itself.
        let running = scraper::Html::parse_document("<span class=\"h2\">B - Editorial   Board</span>");
        assert_eq!(parse_atcoder_title(&running).as_deref(), Some("B - Editorial Board"));
        assert_eq!(parse_atcoder_title(&scraper::Html::parse_document("<p>no heading</p>")), None);
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
        assert_eq!(problem.title, "A - Streamer Takahashi");
        assert_eq!(problem.suggested_filename, "A.cpp");
        assert_eq!(problem.tests.len(), 3);
    }

    #[test]
    fn tells_cloudflares_challenge_from_a_page() {
        // What codeforces.com sends a plain client: 403, the header, and this page.
        let challenge = r#"<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><noscript><div class="h2"><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></div></noscript><script>(function(){window._cf_chl_opt = {cType: 'managed',cZone: 'codeforces.com'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=a47509ca1e085775';}());</script></body></html>"#;
        assert!(is_cloudflare_challenge(403, Some("challenge"), challenge));
        assert!(is_cloudflare_challenge(403, None, challenge));
        assert!(is_cloudflare_challenge(503, None, challenge));
        assert!(is_cloudflare_challenge(200, Some("Challenge"), ""));
        // Every ordinary Codeforces page loads Cloudflare's script too, and a 403 can be the site's own.
        let page = r#"<div class="problem-statement"></div><script>a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script>"#;
        assert!(!is_cloudflare_challenge(200, None, page));
        assert!(!is_cloudflare_challenge(403, None, "<title>Codeforces</title>You are not allowed to view the contest"));
        assert!(!is_cloudflare_challenge(200, None, challenge));
        assert!(challenge_error("Codeforces").starts_with(NEEDS_BROWSER));
    }

    #[test]
    #[ignore = "requires access to codeforces.com, and Cloudflare still challenging a client with no user agent"]
    fn codeforces_challenge_asks_for_the_browser() {
        // No user agent is what Cloudflare challenges for certain; the import must say so
        // rather than go on to the reader service or report a page it could not parse.
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build().unwrap();
        let problem = fetch_codeforces_problem(&client, "https://codeforces.com/contest/1117/problem/B").err().expect("a challenge");
        assert!(problem.starts_with(NEEDS_BROWSER), "{problem}");
        let contest = fetch_codeforces_contest(&client, "https://codeforces.com/contest/1117").err().expect("a challenge");
        assert!(contest.starts_with(NEEDS_BROWSER), "{contest}");
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
    #[ignore = "requires access to codeforces.com, and Cloudflare not challenging this client"]
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
    #[ignore = "requires access to codeforces.com, and Cloudflare not challenging this client"]
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

        // codeforces.com/contest/1117/problem/B: two examples, both inside the one block.
        let html = "<div class=\"problem-statement\"><div class=\"header\"><div class=\"title\">B. Emotes</div></div><div class=\"sample-tests\"><div class=\"sample-test\"><div class=\"input\"><div class=\"title\">Input</div><pre>\n6 9 2\n1 3 3 7 4 2\n</pre></div><div class=\"output\"><div class=\"title\">Output</div><pre>\n54\n</pre></div><div class=\"input\"><div class=\"title\">Input</div><pre>\n3 1000000000 1\n1000000000 987654321 1000000000\n</pre></div><div class=\"output\"><div class=\"title\">Output</div><pre>\n1000000000000000000\n</pre></div></div></div></div>";
        let (_, tests) = parse_codeforces_html(html).expect("parse both examples");
        assert_eq!(tests.iter().map(|test| (test.name.as_str(), test.input.as_str(), test.expected.as_str())).collect::<Vec<_>>(), vec![("test 1", "6 9 2\n1 3 3 7 4 2", "54"), ("test 2", "3 1000000000 1\n1000000000 987654321 1000000000", "1000000000000000000")]);
    }

    #[test]
    fn parses_live_codeforces_contest_problem_links() {
        let html = r#"<table class="problems"><tbody><tr><td><a href="/contest/9999/problem/A">A</a></td></tr><tr><td><a href="/contest/9999/problem/B2">B2</a></td></tr></tbody></table>"#;
        let base = reqwest::Url::parse("https://codeforces.com/contest/9999?locale=en").unwrap();
        assert_eq!(parse_codeforces_contest_urls(html, &base), vec!["https://codeforces.com/contest/9999/problem/A".to_string(), "https://codeforces.com/contest/9999/problem/B2".to_string()]);
    }
}
