# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import concurrent.futures
import os
import re
import sys
import urllib.parse
import urllib.request

REVISION = "7da823b1d594d1b49797911900e003ec96a8c0e7"
BASE = f"https://chrome-devtools-frontend.appspot.com/serve_rev/@{REVISION}/"
DEFAULT_OUTPUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".cache",
    "chrome-devtools-frontend",
    REVISION,
)
CRITICAL_FILES = [
    "inspector.html",
    "entrypoints/inspector/inspector.js",
    "entrypoints/devtools_app/devtools_app.js",
    "core/i18n/locales/en-US.json",
]
EXTRA_FILES = [
    "core/i18n/locales/en-US.json",
]
MAX_FILES = 6000
MAX_BYTES = 300 * 1024 * 1024

html_re = re.compile(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', re.I)
css_url_re = re.compile(r'url\(\s*["\']?([^"\')]+)["\']?\s*\)', re.I)
css_import_re = re.compile(r'@import\s+(?:url\()?\s*["\']?([^"\')]+)["\']?', re.I)
js_from_re = re.compile(r'(?:from|import)\s*["\']([^"\']+)["\']')
js_dyn_re = re.compile(r'import\(\s*["\']([^"\']+)["\']\s*\)')
js_worker_re = re.compile(r'new\s+Worker\(\s*["\']([^"\']+)["\']')
js_url_re = re.compile(r'new\s+URL\(\s*["\']([^"\']+)["\']')


def normalize(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return None
    if not url.startswith(BASE):
        return None
    if parsed.path.endswith(".map"):
        return None
    return urllib.parse.urlunparse(
        (parsed.scheme, parsed.netloc, parsed.path, "", "", "")
    )


def local_path(output, url):
    rel = url[len(BASE):]
    rel = urllib.parse.unquote(rel)
    rel = rel.replace("..", "_")
    return os.path.join(output, rel)


def extract(url, data):
    text = data.decode("utf-8", "replace")
    found = []
    lower = url.lower()
    if lower.endswith((".html", ".htm")):
        found += html_re.findall(text)
        found += css_url_re.findall(text)
    elif lower.endswith(".js"):
        found += js_from_re.findall(text)
        found += js_dyn_re.findall(text)
        found += js_worker_re.findall(text)
        found += js_url_re.findall(text)
    elif lower.endswith(".css"):
        found += css_import_re.findall(text)
        found += css_url_re.findall(text)

    out = []
    for raw in found:
        raw = raw.strip()
        if not raw or raw.startswith(("data:", "blob:", "#")):
            continue
        absolute = urllib.parse.urljoin(url, raw)
        normalized = normalize(absolute)
        if normalized:
            out.append(normalized)
    return out


def fetch(url):
    request = urllib.request.Request(
        url, headers={"User-Agent": "chill-devtools-g0"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def has_critical_files(output):
    return all(os.path.isfile(os.path.join(output, path)) for path in CRITICAL_FILES)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    output = os.path.abspath(args.output)
    if has_critical_files(output) and not args.force:
        print(f"Frontend already present: {output}")
        return 0

    os.makedirs(output, exist_ok=True)
    seen = set()
    queue = [BASE + "inspector.html"] + [BASE + path for path in EXTRA_FILES]
    saved = {}
    errors = []
    total_bytes = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
        while queue and len(seen) < MAX_FILES:
            batch = []
            while queue and len(batch) < 64:
                url = queue.pop(0)
                if url in seen:
                    continue
                seen.add(url)
                batch.append(url)

            futures = {pool.submit(fetch, url): url for url in batch}
            for future in concurrent.futures.as_completed(futures):
                url = futures[future]
                try:
                    data = future.result()
                except Exception as error:
                    errors.append((url, str(error)))
                    continue

                total_bytes += len(data)
                if total_bytes > MAX_BYTES:
                    print("Byte limit reached", file=sys.stderr)
                    queue.clear()
                    break

                path = local_path(output, url)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as file:
                    file.write(data)
                saved[url] = len(data)

                for next_url in extract(url, data):
                    if next_url not in seen:
                        queue.append(next_url)

            print(
                f"files={len(saved)} queued={len(queue)} bytes={total_bytes}",
                file=sys.stderr,
            )

    with open(os.path.join(output, "CRAWL_ERRORS.txt"), "w") as file:
        for url, error in errors:
            file.write(f"{url}\t{error}\n")

    missing = [
        path for path in CRITICAL_FILES if not os.path.isfile(os.path.join(output, path))
    ]
    if missing:
        print("Missing critical frontend files:", ", ".join(missing), file=sys.stderr)
        return 1

    print(f"Frontend ready: {output}")
    print(f"files={len(saved)} errors={len(errors)} bytes={total_bytes}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
