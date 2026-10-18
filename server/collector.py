"""Daily collection of Mumbai disease news that quotes BMC figures.

Searches Google News for BMC monsoon-illness reports, keeps articles from the last 60 days, and pulls
out case counts that the headline or summary states (for example "H1N1 cases surge 511% to 507").
Nothing is used automatically: every candidate waits in a review queue until an approver checks the
article, sets the period it covers and accepts it as a BMC report.
"""
import email.utils
import html
import json
import re
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from core import audit, env

QUERIES = [
    'BMC dengue malaria cases Mumbai',
    'Mumbai leptospirosis cases BMC',
    'Mumbai monsoon illnesses BMC data',
    'Mumbai H1N1 swine flu cases BMC',
    'Mumbai gastroenteritis hepatitis cases BMC',
]
FEED = 'https://news.google.com/rss/search?q={q}&hl=en-IN&gl=IN&ceid=IN:en'
MAX_AGE_DAYS = 60

DISEASES = {
    'dengue': r'dengue', 'malaria': r'malaria', 'lepto': r'leptospirosis|lepto', 'gastro': r'gastroenteritis|gastro',
    'hep': r'hepatitis|jaundice', 'flu': r'h1n1|swine\s*flu', 'chik': r'chikungunya',
}
NUM = r'(\d{1,3}(?:,\d{2,3})+|\d+)'
NOT_PCT = r'(?!\s*(?:%|per\s*cent|percent|\d|,\d))'
RELEVANT = re.compile(r'\b(dengue|malaria|leptospirosis|lepto|gastro|hepatitis|jaundice|h1n1|swine flu|chikungunya|monsoon (?:diseases|illness))', re.I)


def extract(text):
    """Case counts stated next to a disease name. Percentages, years and breeding-site counts are ignored."""
    t = html.unescape(re.sub(r'<[^>]+>', ' ', text or '')).lower()
    t = re.sub(r'\s+', ' ', t)
    out = {}
    for did, kw in DISEASES.items():
        pats = [
            rf'\b{NUM}\s+(?:new\s+|fresh\s+)?(?:cases?\s+of\s+)?(?:{kw})\b(?!\s*(?:breeding|larva|site|spot|hotspot))(?:\s+cases?)?',
            rf'\b(?:{kw})\b[^.;]{{0,45}}?\b(?:to|at|reached|touched|crossed|tally of|count of|total of)\s+{NUM}{NOT_PCT}',
            rf'\b(?:{kw})\s+cases?\s*(?::|-|stood at|at|were|are|is)?\s*{NUM}{NOT_PCT}',
        ]
        for p in pats:
            m = re.search(p, t)
            if not m:
                continue
            raw = m.group(1)
            n = int(raw.replace(',', ''))
            if ',' not in raw and 1990 <= n <= 2100:  # a year, not a count
                continue
            if n == 0 or n > 500000:
                continue
            out[did] = n
            break
    return out


def _fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': 'SurgeWatch/1.0 (hospital surge forecasting; contact: hospital IT)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_feed(xml_bytes):
    items = []
    root = ET.fromstring(xml_bytes)
    for it in root.iter('item'):
        title = (it.findtext('title') or '').strip()
        link = (it.findtext('link') or '').strip()
        desc = it.findtext('description') or ''
        src = (it.findtext('source') or '').strip()
        try:
            pub = email.utils.parsedate_to_datetime(it.findtext('pubDate') or '').timestamp()
        except (TypeError, ValueError):
            pub = None
        items.append({'title': title, 'link': link, 'desc': desc, 'source': src, 'published': pub})
    return items


def run_once(db, fetch=_fetch, now=None):
    """Fetch every query, store new relevant articles as candidates. Returns a summary dict."""
    now = now or time.time()
    found, new, errors = 0, 0, []
    for q in QUERIES:
        try:
            items = parse_feed(fetch(FEED.format(q=urllib.parse.quote_plus(q))))
        except Exception as e:
            errors.append(f'{q}: {type(e).__name__}')
            continue
        for it in items:
            if not it['published'] or now - it['published'] > MAX_AGE_DAYS * 86400 or not RELEVANT.search(it['title']):
                continue
            if 'mumbai' not in (it['title'] + ' ' + it['desc']).lower() and 'bmc' not in (it['title'] + ' ' + it['desc']).lower():
                continue
            found += 1
            if db.one('SELECT id FROM candidates WHERE url=?', (it['link'],)):
                continue
            counts = extract(it['title'] + ' . ' + it['desc'])
            db.x('INSERT INTO candidates (url, title, source, published, counts, status, found_at) VALUES (?,?,?,?,?,?,?)',
                 (it['link'], it['title'][:400], it['source'][:120], it['published'], json.dumps(counts), 'new', now))
            new += 1
    summary = {'at': now, 'relevant': found, 'new': new, 'errors': errors}
    db.meta('collector', summary)
    audit(db, None, 'collector.run', None, {'relevant': found, 'new': new, 'errors': len(errors)})
    return summary


def start_scheduler(db):
    """Runs once at start-up if the last run is older than 20 hours, then checks hourly."""
    if env('SURGEWATCH_COLLECTOR', '1') == '0':
        return None

    def loop():
        time.sleep(5)
        while True:
            last = (db.meta('collector') or {}).get('at', 0)
            if time.time() - last > 20 * 3600:
                try:
                    run_once(db)
                except Exception as e:  # keep the scheduler alive
                    db.meta('collector', {'at': time.time(), 'relevant': 0, 'new': 0, 'errors': [f'{type(e).__name__}: {e}'[:200]]})
            time.sleep(3600)

    t = threading.Thread(target=loop, name='collector', daemon=True)
    t.start()
    return t
