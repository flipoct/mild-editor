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

/// A judge's page as the user logged in to the problem browser is served it: the address the
/// request ended at and the body, or why there is none (no browser on this platform, the
/// browser not opened in this run, the judge out of reach). See `browser::session_fetch`.
pub(crate) type SessionGet<'a> = &'a dyn Fn(&str) -> Result<(String, String), String>;

/// The [`SessionGet`] of the running app.
pub(crate) fn session_get(app: &tauri::AppHandle) -> impl Fn(&str) -> Result<(String, String), String> + '_ {
    move |url| crate::browser::session_fetch(app, url).map(|page| (page.url, page.body))
}

/// Whether DOJ answered a session fetch with its login instead of the page: the session in
/// the problem browser is not logged in. DOJ does not redirect in HTTP — it sends 200 and a
/// page whose stream tells the browser to go (`NEXT_REDIRECT;replace;/ko/login;307;`) — so
/// the body is what says so; the address covers the day it does redirect.
pub(crate) fn doj_wants_login(url: &str, html: &str) -> bool {
    let at_login = reqwest::Url::parse(url).is_ok_and(|parsed| parsed.path().trim_end_matches('/').ends_with("/login"));
    at_login || html.match_indices("NEXT_REDIRECT;").any(|(at, _)| html[at..].split(';').nth(2).is_some_and(|to| to.trim_end_matches('/').ends_with("/login")))
}

/// A DOJ page through the session, or `None` when there is no session to read it with:
/// no browser, a failed request, or a user who is not logged in.
fn doj_session_page(session: SessionGet, url: &str) -> Option<String> {
    let (final_url, html) = session(url).ok()?;
    (!doj_wants_login(&final_url, &html)).then_some(html)
}

/// A DOJ problem and whether its statement had to come through the session.
fn fetch_doj_problem_from(client: &reqwest::blocking::Client, session: SessionGet, url: &str) -> Result<(ImportedAtCoderProblem, bool), String> {
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
    // makes a submission from the editor count for the contest. A virtual contest's links
    // carry `?category=<path>&virtual=<key>` the same way.
    let participant = parsed.query_pairs().any(|(name, _)| name == "contest" || name == "virtual");
    let mut page_url = parsed.clone();
    page_url.set_path(&format!("/{}", parts[..=at].join("/")));
    page_url.set_fragment(None);
    let keyed_url = page_url.clone();
    page_url.set_query(None);
    let html = client.get(page_url).send().map_err(|error| format!("Could not fetch DOJ: {error}"))?
        .error_for_status().map_err(|error| format!("DOJ response error: {error}"))?.text().map_err(|error| error.to_string())?;
    let mut page = parse_doj_problem(&html);
    let mut from_session = false;
    if page.tests.is_empty() && participant {
        // While its contest runs a problem is there for participants only, and to anyone else
        // its page is as empty as that of a problem that does not exist. The participant is
        // the user in the problem browser, and with the key the page is theirs to read.
        if let Some(seen) = doj_session_page(session, keyed_url.as_str()).map(|html| parse_doj_problem(&html)).filter(|seen| !seen.tests.is_empty()) {
            page = seen;
            from_session = true;
        }
    }
    if page.tests.is_empty() {
        return Err(if participant {
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
    Ok((ImportedAtCoderProblem { title, suggested_filename: format!("{number}.cpp"), tests: page.tests, source: "doj".into(), source_url: source_url.to_string(), contest: None }, from_session))
}

fn fetch_doj_problem(client: &reqwest::blocking::Client, session: SessionGet, url: &str) -> Result<ImportedAtCoderProblem, String> {
    fetch_doj_problem_from(client, session, url).map(|(problem, _)| problem)
}

/// Whether a DOJ address is a list of problems to import as a whole: a contest
/// (`/<locale>/contests/<slug>`) or a category (`/<locale>/categories/<path…>`), which is
/// what a virtual contest runs on, as `…/categories/<path…>?virtual=<key>`.
fn is_doj_listing(url: &reqwest::Url) -> bool {
    let parts = url.path_segments().map(|parts| parts.collect::<Vec<_>>()).unwrap_or_default();
    !parts.contains(&"problems") && parts.iter().any(|part| *part == "contests" || *part == "categories")
}

/// One problem of a DOJ contest or category page.
#[derive(Debug, PartialEq)]
struct DojListedProblem {
    /// The index the page gives it (`A`, `B`, …), where its table has one.
    letter: Option<String>,
    /// `/<locale>/problems/<number>`, nothing after it.
    url: String,
    /// The same with what makes the problem the contest's: `?contest=<key>` from a contest
    /// page, `?category=<path>&virtual=<key>` from the category page of a virtual contest.
    participant_url: Option<String>,
}

/// The problems a DOJ contest or category page lists, in the page's order — which is the
/// contest's: the numbers in the archive are neither consecutive nor sorted (… 555, 557,
/// 556, 559, 698 …). Each row is `<td>A</td><td><a href="/<locale>/problems/<number>?…">`,
/// the link carrying `contest=<key>` on a contest page and `category=<path>` on a category
/// page. The key of a virtual contest is on the page's own address, and on its links only
/// for the participant; taken from the address, it is kept either way.
fn doj_listed_problems(html: &str, base: &reqwest::Url) -> Vec<DojListedProblem> {
    let document = scraper::Html::parse_document(html);
    let link_selector = scraper::Selector::parse("a[href]").unwrap();
    let cell_selector = scraper::Selector::parse("td").unwrap();
    let virtual_key = base.query_pairs().find(|(name, value)| name == "virtual" && !value.is_empty()).map(|(_, value)| value.into_owned());
    let mut seen = std::collections::HashSet::new();
    let mut problems = Vec::new();
    for link in document.select(&link_selector) {
        let Some(href) = link.value().attr("href") else { continue };
        if !href.contains("/problems/") { continue; }
        let Ok(mut url) = base.join(href) else { continue };
        let is_problem = url.path_segments().and_then(|mut parts| parts.next_back()).is_some_and(|id| !id.is_empty() && id.chars().all(|character| character.is_ascii_digit()));
        let listed = url.query_pairs().filter(|(name, value)| (name == "contest" || name == "category") && !value.is_empty()).map(|(name, value)| (name.into_owned(), value.into_owned())).collect::<Vec<_>>();
        // A link with neither is the site's own to some other problem, not a row of the list.
        if !is_problem || listed.is_empty() { continue; }
        url.set_query(None);
        url.set_fragment(None);
        if !seen.insert(url.to_string()) { continue; }
        let in_contest = listed.iter().any(|(name, _)| name == "contest");
        let participant_url = (in_contest || virtual_key.is_some()).then(|| {
            let mut keyed = url.clone();
            keyed.query_pairs_mut().extend_pairs(&listed).extend_pairs(virtual_key.iter().filter(|_| !in_contest).map(|key| ("virtual", key.as_str())));
            keyed.to_string()
        });
        let row = link.ancestors().filter_map(scraper::ElementRef::wrap).find(|element| element.value().name() == "tr");
        let letter = row.and_then(|row| row.select(&cell_selector).next()).map(|cell| cell.text().collect::<String>().trim().to_string())
            .filter(|text| (1..=3).contains(&text.len()) && text.starts_with(|first: char| first.is_ascii_uppercase()) && text.chars().all(|character| character.is_ascii_alphanumeric()));
        problems.push(DojListedProblem { letter, url: url.to_string(), participant_url });
    }
    problems
}

/// The name of a DOJ contest or category: the page's heading. The `<title>` of a category
/// is made from its address (`Sjupc2026 | DOJ` for "SJUPC 2026"), so it only stands in.
fn doj_listing_name(html: &str) -> Option<String> {
    let document = scraper::Html::parse_document(html);
    ["h1.page-title", "h1", "title"].iter().find_map(|selector| {
        let text = document.select(&scraper::Selector::parse(selector).unwrap()).next()?.text().collect::<String>();
        Some(text.replace(" | DOJ", "").split_whitespace().collect::<Vec<_>>().join(" ")).filter(|name| !name.is_empty())
    })
}

/// `A`, `B`, … `Z`, then `A1`, `B1`, …: the index a contest gives its problems.
fn contest_letter(index: usize) -> String {
    let letter = (b'A' + (index % 26) as u8) as char;
    if index < 26 { letter.to_string() } else { format!("{letter}{}", index / 26) }
}

/// A DOJ contest, or the category a virtual contest runs on, as a whole. What anyone may
/// read is read plainly; the session of the problem browser comes in where the page is the
/// participant's alone — the problem list and the statements of a contest that is running.
fn fetch_doj_contest(client: &reqwest::blocking::Client, session: SessionGet, url: &str) -> Result<Vec<ImportedAtCoderProblem>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid DOJ contest URL.".to_string())?;
    let public = client.get(parsed.clone()).send().and_then(|response| response.error_for_status()).and_then(|response| response.text());
    let mut page = public.as_ref().ok().map(|html| (doj_listed_problems(html, &parsed), doj_listing_name(html))).filter(|(listed, _)| !listed.is_empty());
    if page.is_none() {
        // DOJ shows a running contest's problems only to a participant who is logged in.
        let Some(html) = doj_session_page(session, parsed.as_str()) else {
            return Err(format!("{NEEDS_BROWSER}DOJ does not list this contest's problems publicly. Open the contest in the problem browser, logged in, and import it from there."));
        };
        page = Some((doj_listed_problems(&html, &parsed), doj_listing_name(&html))).filter(|(listed, _)| !listed.is_empty());
    }
    let Some((listed, contest)) = page else {
        return Err(match public {
            Err(error) => format!("Could not fetch DOJ: {error}"),
            Ok(_) => "No problems are listed on this DOJ page.".into(),
        });
    };
    let mut problems = Vec::new();
    for (index, entry) in listed.into_iter().take(30).enumerate() {
        let (mut problem, from_session) = fetch_doj_problem_from(client, session, entry.participant_url.as_deref().unwrap_or(&entry.url))?;
        // A virtual contest's key stays, for it is what a submission must carry. A contest's
        // stays while only the participant can read the problem; once the contest is over the
        // plain address is the problem's, and its verdicts are on the public status page.
        if !from_session && !problem.source_url.contains("virtual=") {
            if let Ok(mut plain) = reqwest::Url::parse(&problem.source_url) {
                plain.set_query(None);
                problem.source_url = plain.to_string();
            }
        }
        // In a contest the letter names the problem, not its number in the archive.
        problem.suggested_filename = format!("{}.cpp", entry.letter.unwrap_or_else(|| contest_letter(index)));
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
pub(crate) async fn import_problem(app: tauri::AppHandle, url: String) -> Result<Vec<ImportedAtCoderProblem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Blocks until the main thread has answered: fine here, off it.
        let session = session_get(&app);
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
            if is_doj_listing(&parsed) {
                return fetch_doj_contest(&client, &session, &url);
            }
            return fetch_doj_problem(&client, &session, &url).map(|problem| vec![problem]);
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
        let html = r#"<a href="/ko/problems">all</a><a href="/ko/problems/1">elsewhere</a>
            <a href="/ko/problems/286?contest=key">A</a><a href="/ko/problems/362?contest=key">B</a>
            <a href="/ko/problems/286?contest=key">A again</a><a href="/ko/problems/286/editorial?contest=key">editorial</a>
            <a href="/ko/contests/bcd7/standings">standings</a>"#;
        let listed = doj_listed_problems(html, &base);
        assert_eq!(listed.iter().map(|problem| problem.url.as_str()).collect::<Vec<_>>(), vec!["https://doj.kr/ko/problems/286", "https://doj.kr/ko/problems/362"]);
        assert_eq!(listed[1], DojListedProblem { letter: None, url: "https://doj.kr/ko/problems/362".into(), participant_url: Some("https://doj.kr/ko/problems/362?contest=key".into()) });
        assert!(doj_listed_problems("<a href=\"/ko/login\">login</a>", &base).is_empty());
        assert_eq!([contest_letter(0), contest_letter(8), contest_letter(25), contest_letter(26)], ["A", "I", "Z", "A1"]);

        // The participant's view of a contest: `# | 제목 | 내 점수`, one row a problem.
        let table = r#"<h1 class="page-title">Spring  Open</h1><table><thead><tr><th>#</th><th>제목</th><th>내 점수</th></tr></thead><tbody>
            <tr><td>A</td><td><a href="/ko/problems/550?contest=key">고기만두</a></td><td>−</td></tr>
            <tr><td>B2</td><td><a href="/ko/problems/548?contest=key">만두 2</a></td><td>−</td></tr></tbody></table>"#;
        assert_eq!(doj_listed_problems(table, &base).iter().map(|problem| (problem.letter.as_deref(), problem.participant_url.as_deref())).collect::<Vec<_>>(),
            vec![(Some("A"), Some("https://doj.kr/ko/problems/550?contest=key")), (Some("B2"), Some("https://doj.kr/ko/problems/548?contest=key"))]);
        assert_eq!(doj_listing_name(table).as_deref(), Some("Spring Open"));
    }

    #[test]
    fn doj_category_page_is_a_virtual_contest_in_table_order() {
        // The shape of doj.kr/ko/categories/<path>: the archive numbers are not in the
        // contest's order, and only the participant's page has the key on its links.
        let row = |letter: &str, id: u32, query: &str| format!(r#"<tr><td><span class="doj-id-link">{letter}</span></td><td><a class="doj-table-link doj-problem-cell" href="/ko/problems/{id}?{query}"><span class="doj-problem-compact-line"><strong>이름 {letter}</strong><span class="doj-problem-sub">name-{id}</span></span></a></td><td>Gold IV</td><td>29%</td><td>22</td><td>미시도</td></tr>"#);
        let page = |query: &str| format!(r#"<html><head><title>Open2026 | DOJ</title></head><body><a href="/ko/contests/open2026">연결된 본대회 보기</a><a href="/ko/problems/7">other</a>
            <h1 class="page-title">OPEN 2026</h1><table><thead><tr><th>#</th><th>문제</th><th>난이도</th><th>정답률</th><th>해결</th><th>상태</th></tr></thead><tbody>{}{}{}</tbody></table></body></html>"#,
            row("A", 557, query), row("B", 556, query), row("C", 698, query));
        let keyed = |id: u32| format!("https://doj.kr/ko/problems/{id}?category=school%2Fopen%2Fopen2026&virtual=vkey");

        let running = reqwest::Url::parse("https://doj.kr/ko/categories/school/open/open2026?virtual=vkey").unwrap();
        for html in [page("category=school%2Fopen%2Fopen2026&amp;virtual=vkey"), page("category=school%2Fopen%2Fopen2026")] {
            let listed = doj_listed_problems(&html, &running);
            assert_eq!(listed.iter().map(|problem| (problem.letter.as_deref(), problem.url.as_str())).collect::<Vec<_>>(),
                vec![(Some("A"), "https://doj.kr/ko/problems/557"), (Some("B"), "https://doj.kr/ko/problems/556"), (Some("C"), "https://doj.kr/ko/problems/698")]);
            assert_eq!(listed.iter().map(|problem| problem.participant_url.clone().unwrap()).collect::<Vec<_>>(), vec![keyed(557), keyed(556), keyed(698)]);
            assert_eq!(doj_listing_name(&html).as_deref(), Some("OPEN 2026"));
        }
        // Without a virtual contest the category is the archive: plain problems.
        let archive = reqwest::Url::parse("https://doj.kr/ko/categories/school/open/open2026").unwrap();
        assert!(doj_listed_problems(&page("category=school%2Fopen%2Fopen2026"), &archive).iter().all(|problem| problem.participant_url.is_none() && problem.letter.is_some()));
        assert_eq!(doj_listing_name("<html><head><title>Open2026 | DOJ</title></head></html>").as_deref(), Some("Open2026"));

        let listing = |url: &str| is_doj_listing(&reqwest::Url::parse(url).unwrap());
        assert!(listing("https://doj.kr/ko/categories/school/open/open2026?virtual=vkey") && listing("https://doj.kr/ko/contests/bcd7"));
        assert!(!listing("https://doj.kr/ko/problems/557?category=school%2Fopen%2Fopen2026&virtual=vkey") && !listing("https://doj.kr/ko/problems/286?contest=key"));
    }

    #[test]
    fn doj_login_answer_is_told_from_a_page() {
        // What a visitor gets for a page of the login's: HTTP 200, and the way out in the stream.
        let logged_out = r#"<html><head><title>내 제출 | DOJ</title></head><body><script>self.__next_f.push([1,"19:E{\"digest\":\"NEXT_REDIRECT;replace;/ko/login;307;\"}"])</script></body></html>"#;
        assert!(doj_wants_login("https://doj.kr/ko/submissions", logged_out));
        assert!(doj_wants_login("https://doj.kr/en/login?next=%2Fen%2Fsubmissions", "<html></html>"));
        // A contest problem sends a visitor on to the plain problem, which is no login.
        let elsewhere = r#"<script>self.__next_f.push([1,"19:E{\"digest\":\"NEXT_REDIRECT;replace;/ko/problems/286;307;\"}"])</script>"#;
        assert!(!doj_wants_login("https://doj.kr/ko/problems/286?contest=key", elsewhere));
        assert!(!doj_wants_login("https://doj.kr/ko/submissions", "<table><tbody><tr><td colspan=\"8\" class=\"muted\">표시할 제출이 아직 없습니다.</td></tr></tbody></table><a href=\"/ko/login\">로그인</a>"));

        let no_session: SessionGet = &|_| Err("no browser".into());
        assert_eq!(doj_session_page(no_session, "https://doj.kr/ko/submissions"), None);
        assert_eq!(doj_session_page(&|url| Ok((url.to_string(), logged_out.to_string())), "https://doj.kr/ko/submissions"), None);
        assert_eq!(doj_session_page(&|url| Ok((url.to_string(), "<table></table>".to_string())), "https://doj.kr/ko/submissions").as_deref(), Some("<table></table>"));
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
        let session: SessionGet = &|_| Err("no browser in a test".into());
        let plain = fetch_doj_problem(&client, session, "https://doj.kr/ko/problems/286").unwrap();
        assert_eq!((plain.title.as_str(), plain.suggested_filename.as_str(), plain.tests.len()), ("49", "286.cpp", 1));
        // The link a contest page gives: the statement comes from the plain page, the key is kept.
        let keyed = "https://doj.kr/ko/problems/286?contest=cmtimve8l0e0wokcqksb6wqez";
        let from_contest = fetch_doj_problem(&client, session, keyed).unwrap();
        assert_eq!((from_contest.suggested_filename.as_str(), from_contest.tests.len(), from_contest.source_url.as_str()), ("286.cpp", 1, keyed));
        // The site's own canonical link is by slug; the file and the saved URL go by number.
        let by_slug = fetch_doj_problem(&client, session, "https://doj.kr/ko/problems/bracketstring").unwrap();
        assert_eq!((by_slug.suggested_filename.as_str(), by_slug.source_url.as_str()), ("634.cpp", "https://doj.kr/ko/problems/634"));
        assert_eq!(by_slug.tests.len(), 2);
        let missing = fetch_doj_problem(&client, session, "https://doj.kr/ko/problems/99999").err().expect("no such problem");
        assert!(!missing.starts_with(NEEDS_BROWSER), "{missing}");

        let contest = fetch_doj_contest(&client, session, "https://doj.kr/ko/contests/bcd7").unwrap();
        assert_eq!(contest.len(), 9);
        assert_eq!((contest[0].title.as_str(), contest[0].suggested_filename.as_str(), contest[0].contest.as_deref()), ("49", "A.cpp", Some("DOJ Beginner Contest 7")));
        assert_eq!(contest[8].suggested_filename, "I.cpp");

        // A virtual contest runs on the category page of a past contest, which anyone may read;
        // the letters are the table's, and the key on the address is kept for the submit page.
        let in_virtual = fetch_doj_contest(&client, session, "https://doj.kr/ko/categories/school/sju/sjupc2026?virtual=key").unwrap();
        assert_eq!(in_virtual.len(), 12);
        assert_eq!((in_virtual[6].suggested_filename.as_str(), in_virtual[6].contest.as_deref()), ("G.cpp", Some("SJUPC 2026")));
        assert_eq!(in_virtual[6].source_url, "https://doj.kr/ko/problems/557?category=school%2Fsju%2Fsjupc2026&virtual=key");
        assert!(in_virtual.iter().all(|problem| !problem.tests.is_empty()));
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
