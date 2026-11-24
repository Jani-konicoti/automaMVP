from __future__ import annotations

import hashlib
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag


SKIPPED_NAMESPACE_PREFIXES = {
    "speciale",
    "special",
    "file",
    "immagine",
    "image",
    "media",
    "categoria",
    "category",
    "template",
    "discussione",
    "talk",
    "utente",
    "user",
    "mediawiki",
    "aiuto",
    "help",
}

REMOVED_SELECTORS = (
    "script",
    "style",
    "noscript",
    "nav",
    ".mw-editsection",
    ".mw-jump-link",
    ".mw-indicators",
    ".mw-empty-elt",
    ".noprint",
    ".printfooter",
    ".catlinks",
    ".navbox",
    ".vertical-navbox",
    ".toc",
    "[hidden]",
    "[aria-hidden='true']",
    "[style*='display:none']",
    "[style*='display: none']",
    "[style*='visibility:hidden']",
    "[style*='visibility: hidden']",
)


@dataclass(frozen=True)
class WikiPage:
    page_id: int
    title: str
    namespace: int
    revision_id: int | None
    modified_at: str | None
    source_url: str
    text: str
    text_hash: str
    links: tuple[str, ...]
    discarded: dict[str, int]


@dataclass
class CrawledPage:
    page: WikiPage
    paths: list[tuple[str, ...]] = field(default_factory=list)


@dataclass
class CrawlResult:
    pages: dict[int, CrawledPage]
    errors: list[str]
    truncated: bool = False


def normalize_title(value: str) -> str:
    return " ".join(unquote(value).replace("_", " ").split())


def is_document_title(title: str) -> bool:
    normalized = normalize_title(title)
    if not normalized or normalized.startswith("#"):
        return False
    if ":" not in normalized:
        return True
    return normalized.split(":", 1)[0].strip().lower() not in SKIPPED_NAMESPACE_PREFIXES


def title_from_href(href: str, base_url: str) -> str | None:
    if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
        return None
    absolute = urljoin(base_url.rstrip("/") + "/", href)
    parsed = urlparse(absolute)
    base = urlparse(base_url)
    if parsed.netloc.lower() != base.netloc.lower():
        return None
    query_title = parse_qs(parsed.query).get("title", [None])[0]
    if query_title:
        title = normalize_title(query_title)
    elif parsed.path.startswith("/wiki/"):
        title = normalize_title(parsed.path[len("/wiki/") :])
    elif parsed.path.startswith("/index.php/"):
        title = normalize_title(parsed.path[len("/index.php/") :])
    else:
        return None
    return title if is_document_title(title) else None


def _inline_text(tag: Tag, excluded: Iterable[str] = ()) -> str:
    excluded_names = set(excluded)
    parts: list[str] = []
    for child in tag.children:
        if isinstance(child, NavigableString):
            parts.append(str(child))
        elif isinstance(child, Tag) and child.name not in excluded_names:
            parts.append(child.get_text(" ", strip=True))
    return " ".join(" ".join(parts).split())


def _render_list(tag: Tag, depth: int = 0) -> list[str]:
    lines: list[str] = []
    ordered = tag.name == "ol"
    for index, item in enumerate(tag.find_all("li", recursive=False), start=1):
        prefix = f"{index}." if ordered else "-"
        text = _inline_text(item, excluded=("ul", "ol"))
        if text:
            lines.append(f"{'  ' * depth}{prefix} {text}")
        for nested in item.find_all(["ul", "ol"], recursive=False):
            lines.extend(_render_list(nested, depth + 1))
    return lines


def _render_blocks(container: Tag | BeautifulSoup) -> list[str]:
    blocks: list[str] = []
    for child in container.children:
        if not isinstance(child, Tag):
            continue
        if child.name in {"h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "blockquote"}:
            text = child.get_text(" ", strip=True)
            if text:
                blocks.append(text)
        elif child.name in {"ul", "ol"}:
            lines = _render_list(child)
            if lines:
                blocks.append("\n".join(lines))
        elif child.name == "table":
            rows: list[str] = []
            for row in child.find_all("tr"):
                cells = [" ".join(cell.get_text(" ", strip=True).split()) for cell in row.find_all(["th", "td"], recursive=False)]
                if any(cells):
                    rows.append(" | ".join(cells))
            if rows:
                blocks.append("\n".join(rows))
        elif child.name == "dl":
            rows = []
            for entry in child.find_all(["dt", "dd"], recursive=False):
                text = entry.get_text(" ", strip=True)
                if text:
                    rows.append(("- " if entry.name == "dd" else "") + text)
            if rows:
                blocks.append("\n".join(rows))
        else:
            nested = _render_blocks(child)
            if nested:
                blocks.extend(nested)
            else:
                text = child.get_text(" ", strip=True)
                if text:
                    blocks.append(text)
    return blocks


def extract_document(html: str, title: str, base_url: str) -> tuple[str, tuple[str, ...], dict[str, int]]:
    soup = BeautifulSoup(html or "", "html.parser")
    discarded: dict[str, int] = {}
    for selector in REMOVED_SELECTORS:
        selected = soup.select(selector)
        if selected:
            discarded[selector] = len(selected)
        for tag in selected:
            tag.decompose()

    links: list[str] = []
    seen_links: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        linked_title = title_from_href(str(anchor.get("href")), base_url)
        if linked_title and linked_title not in seen_links:
            seen_links.add(linked_title)
            links.append(linked_title)

    blocks = _render_blocks(soup)
    normalized_title = normalize_title(title)
    if not blocks or blocks[0].casefold() != normalized_title.casefold():
        blocks.insert(0, normalized_title)
    text = "\n\n".join(block.strip() for block in blocks if block.strip()).strip()
    return text, tuple(links), discarded


class MediaWikiClient:
    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        *,
        timeout: float = 30,
        max_retries: int = 3,
        verify_ssl: bool = True,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_url = f"{self.base_url}/api.php"
        self.username = username
        self.password = password
        self.max_retries = max_retries
        self.client = httpx.Client(timeout=timeout, follow_redirects=True, verify=verify_ssl)

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "MediaWikiClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _request(self, method: str = "GET", **params: Any) -> dict[str, Any]:
        payload = {"format": "json", "formatversion": "2", **params}
        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                if method == "POST":
                    response = self.client.post(self.api_url, data=payload)
                else:
                    response = self.client.get(self.api_url, params=payload)
                response.raise_for_status()
                data = response.json()
                if "error" in data:
                    error = data["error"]
                    raise RuntimeError(f"MediaWiki {error.get('code', 'error')}: {error.get('info', error)}")
                return data
            except (httpx.HTTPError, ValueError, RuntimeError) as exc:
                last_error = exc
                if attempt + 1 < self.max_retries:
                    time.sleep(2**attempt)
        raise RuntimeError(f"Richiesta MediaWiki fallita: {last_error}") from last_error

    def login(self) -> None:
        token_data = self._request(action="query", meta="tokens", type="login")
        token = token_data["query"]["tokens"]["logintoken"]
        result = self._request(
            "POST",
            action="login",
            lgname=self.username,
            lgpassword=self.password,
            lgtoken=token,
        ).get("login", {})
        if result.get("result") != "Success":
            raise RuntimeError(f"Login MediaWiki fallito: {result.get('reason') or result.get('result')}")

    def get_page(self, title: str) -> WikiPage:
        info_data = self._request(
            action="query",
            prop="info|revisions",
            titles=title,
            rvprop="ids|timestamp",
            rvlimit=1,
        )
        rows = info_data.get("query", {}).get("pages", [])
        if not rows or rows[0].get("missing"):
            raise RuntimeError(f"Pagina MediaWiki non trovata: {title}")
        info = rows[0]
        page_id = int(info["pageid"])
        canonical_title = normalize_title(info["title"])
        revision = (info.get("revisions") or [{}])[0]
        parsed = self._request(
            action="parse",
            pageid=page_id,
            prop="text|links|sections|revid",
            disableeditsection=1,
        )["parse"]
        html = parsed.get("text") or ""
        if isinstance(html, dict):
            html = html.get("*") or ""
        text, html_links, discarded = extract_document(str(html), canonical_title, self.base_url)
        api_links = [
            normalize_title(link.get("title", ""))
            for link in parsed.get("links", [])
            if int(link.get("ns") or 0) == 0 and is_document_title(link.get("title", ""))
        ]
        links = tuple(dict.fromkeys([*html_links, *api_links]))
        source_url = f"{self.base_url}/index.php?title={canonical_title.replace(' ', '_')}"
        return WikiPage(
            page_id=page_id,
            title=canonical_title,
            namespace=int(info.get("ns", 0)),
            revision_id=revision.get("revid") or parsed.get("revid"),
            modified_at=revision.get("timestamp"),
            source_url=source_url,
            text=text,
            text_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            links=links,
            discarded=discarded,
        )

    def recent_changes(self, since: str) -> list[dict[str, Any]]:
        continuation: dict[str, Any] = {}
        changes: list[dict[str, Any]] = []
        while True:
            data = self._request(
                action="query",
                list="recentchanges",
                rcprop="title|ids|timestamp|flags|loginfo",
                rcnamespace=0,
                rclimit="max",
                rcdir="newer",
                rcstart=since,
                **continuation,
            )
            changes.extend(data.get("query", {}).get("recentchanges", []))
            if "continue" not in data:
                break
            continuation = data["continue"]
        return changes


def crawl_wiki(client: MediaWikiClient, root_title: str, limit: int | None = None) -> CrawlResult:
    queue: deque[tuple[str, tuple[str, ...]]] = deque([(normalize_title(root_title), tuple())])
    pages: dict[int, CrawledPage] = {}
    title_to_page_id: dict[str, int] = {}
    expanded_ids: set[int] = set()
    errors: list[str] = []
    truncated = False

    while queue:
        title, parent_path = queue.popleft()
        normalized_key = title.casefold()
        known_id = title_to_page_id.get(normalized_key)
        if known_id is not None:
            page = pages[known_id]
            path = (*parent_path, page.page.title)
            if path not in page.paths:
                page.paths.append(path)
            continue
        if limit is not None and len(pages) >= limit:
            truncated = True
            break
        try:
            page = client.get_page(title)
        except Exception as exc:
            errors.append(f"{title}: {exc}")
            continue
        if page.namespace != 0:
            continue
        title_to_page_id[normalized_key] = page.page_id
        title_to_page_id[page.title.casefold()] = page.page_id
        path = (*parent_path, page.title)
        crawled = pages.setdefault(page.page_id, CrawledPage(page=page))
        if path not in crawled.paths:
            crawled.paths.append(path)
        if page.page_id in expanded_ids:
            continue
        expanded_ids.add(page.page_id)
        for linked_title in page.links:
            linked_id = title_to_page_id.get(linked_title.casefold())
            if linked_id is not None:
                existing = pages[linked_id]
                linked_path = (*path, existing.page.title)
                if linked_path not in existing.paths:
                    existing.paths.append(linked_path)
                continue
            queue.append((linked_title, path))

    return CrawlResult(pages=pages, errors=errors, truncated=truncated)
