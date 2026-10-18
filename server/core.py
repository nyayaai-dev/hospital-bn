"""Surge Watch server core: database, accounts, sessions, audit trail, encryption and privacy checks.

Only the Python standard library is required. Encryption at rest uses AES-256-GCM from the
`cryptography` package when it is installed; without it, census data is stored unencrypted and
/api/health reports encryption as off.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROLES = ['viewer', 'staff', 'approver', 'admin']
ROLE_RANK = {r: i for i, r in enumerate(ROLES)}
PBKDF2_ITER = 310_000

try:  # optional dependency for encryption at rest
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:  # pragma: no cover - depends on the environment
    AESGCM = None


def env(name, default=None):
    v = os.environ.get(name)
    return default if v is None or v == '' else v


def data_dir():
    return Path(env('SURGEWATCH_DATA_DIR', str(ROOT / 'data')))


def retention_days():
    return int(env('SURGEWATCH_RETENTION_DAYS', '180'))


def session_hours():
    return float(env('SURGEWATCH_SESSION_HOURS', '12'))


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  email TEXT, phone TEXT, pw_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at REAL, expires_at REAL, ip TEXT);
CREATE TABLE IF NOT EXISTS login_failures (key TEXT, ip TEXT, at REAL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at REAL NOT NULL, user_id INTEGER, username TEXT, action TEXT NOT NULL,
  hospital TEXT, detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY, hospital TEXT NOT NULL, action_id TEXT NOT NULL, title TEXT, at_ms REAL,
  user_id INTEGER, by_name TEXT, by_role TEXT, created_at REAL, withdrawn_at REAL, withdrawn_by TEXT);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, hospital TEXT NOT NULL, dedupe TEXT, data TEXT NOT NULL, status TEXT NOT NULL,
  created_at REAL, updated_at REAL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, hospital TEXT, alert_id TEXT, channel TEXT, recipient TEXT, subject TEXT,
  status TEXT, error TEXT, sent_by TEXT, at REAL);
CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, role TEXT, email TEXT, phone TEXT, units TEXT, min_sev TEXT, created_by TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_by TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS setups (hospital TEXT PRIMARY KEY, data TEXT NOT NULL, rev INTEGER NOT NULL, updated_by TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS census (hospital TEXT PRIMARY KEY, blob BLOB NOT NULL, encrypted INTEGER NOT NULL, rows INTEGER, first_ms REAL,
  last_ms REAL, rev INTEGER NOT NULL, uploaded_by TEXT, uploaded_at REAL);
CREATE TABLE IF NOT EXISTS validations (id INTEGER PRIMARY KEY, hospital TEXT, data TEXT, created_by TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS candidates (id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT, source TEXT, published REAL, counts TEXT,
  status TEXT, reviewed_by TEXT, reviewed_at REAL, found_at REAL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

# Example stakeholders (placeholders, same as the browser-only version) and the two published BMC reports.
SEED_PEOPLE = [
    ('Medical Superintendent / Dean', 'dean@hospital.example', '', 'ALL', 'warning'),
    ('Head of Emergency', 'casualty@hospital.example', '', 'ED,LAB,XRAY,IMG,AMB', 'warning'),
    ('Nursing Superintendent', 'nursing@hospital.example', '', 'NUR,MED,SURG,PEDS,ICU,ISO', 'warning'),
    ('Head of Critical Care', 'icu@hospital.example', '', 'ICU,O2', 'warning'),
    ('Biomedical Engineer (oxygen)', 'biomed@hospital.example', '', 'O2', 'warning'),
    ('Lab Director', 'lab@hospital.example', '', 'LAB', 'warning'),
    ('Head of Radiology', 'radiology@hospital.example', '', 'XRAY,IMG', 'warning'),
    ('Blood Bank Officer', 'bloodbank@hospital.example', '', 'BLOOD', 'warning'),
    ('Transport Officer', 'transport@hospital.example', '', 'AMB', 'warning'),
    ('Infection Control Officer', 'infection.control@hospital.example', '', 'ISO,EPI', 'warning'),
    ('BMC Epidemiology Cell', 'epicell@bmc.example', '', 'EPI', 'critical'),
]


def _ms(y, m, d):
    import datetime
    return datetime.datetime(y, m, d).timestamp() * 1000


SEED_REPORTS = [
    {'id': 'seed-mitkat', 'seed': True, 'from': _ms(2026, 6, 1), 'to': _ms(2026, 9, 30), 'counts': {'malaria': 7422, 'flu': 504, 'dengue': 2941, 'gastro': 2194},
     'src': 'BMC Public Health Department, via Mitkat Advisory (8 Oct 2026): https://mitkatadvisory.com/rising-malaria-and-swine-flu-cases-reported-in-mumbai/'},
    {'id': 'seed-fpj', 'seed': True, 'from': _ms(2026, 1, 1), 'to': _ms(2026, 9, 15), 'counts': {'dengue': 2656, 'malaria': 8723, 'lepto': 390, 'gastro': 4997, 'flu': 507},
     'src': 'BMC data, via Free Press Journal (Sep 2026)'},
]


class DB:
    """One SQLite connection shared by all request threads, guarded by a lock."""

    def __init__(self, path=None):
        path = Path(path) if path else data_dir() / 'surgewatch.db'
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(path.parent, 0o700)
        except OSError:
            pass
        self.path = path
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self._seed()

    def q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def x(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur.lastrowid

    def meta(self, key, value=None):
        if value is None:
            r = self.one('SELECT value FROM meta WHERE key=?', (key,))
            return json.loads(r['value']) if r else None
        self.x('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(value)))

    def _seed(self):
        if self.meta('seeded'):
            return
        now = time.time()
        for role, email, phone, units, sev in SEED_PEOPLE:
            self.x('INSERT INTO people (role, email, phone, units, min_sev, created_by, created_at) VALUES (?,?,?,?,?,?,?)', (role, email, phone, units, sev, 'seed', now))
        for r in SEED_REPORTS:
            self.x('INSERT INTO reports (id, data, created_by, created_at) VALUES (?,?,?,?)', (r['id'], json.dumps(r), 'seed', now))
        self.meta('seeded', True)


# ---------------- passwords and sessions ----------------
COMMON_PASSWORDS = {'password', 'password123', '1234567890', 'qwertyuiop', 'surgewatch', 'admin12345', 'hospital123', 'welcome123', 'letmein123'}


def hash_password(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, PBKDF2_ITER)
    return f'pbkdf2_sha256${PBKDF2_ITER}${salt.hex()}${dk.hex()}'


def check_password(pw, stored):
    try:
        _, it, salt, dk = stored.split('$')
        calc = hashlib.pbkdf2_hmac('sha256', pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(calc.hex(), dk)
    except (ValueError, TypeError):
        return False


def password_problem(pw, username=''):
    if not isinstance(pw, str) or len(pw) < 10:
        return 'Use at least 10 characters.'
    if len(pw) > 200:
        return 'Use at most 200 characters.'
    low = pw.lower()
    if low in COMMON_PASSWORDS or len(set(pw)) < 5 or (username and username.lower() in low):
        return 'Choose a less predictable password (not a common word or your username).'
    return None


USERNAME_RE = re.compile(r'^[a-z0-9._-]{3,40}$')


def new_session(db, user_id, ip):
    token = secrets.token_urlsafe(32)
    now = time.time()
    db.x('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip) VALUES (?,?,?,?,?)',
         (hashlib.sha256(token.encode()).hexdigest(), user_id, now, now + session_hours() * 3600, ip))
    return token


def user_for_token(db, token):
    if not token:
        return None
    r = db.one('SELECT u.id, u.username, u.name, u.role, u.email, u.phone, u.disabled, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=?',
               (hashlib.sha256(token.encode()).hexdigest(),))
    if not r or r['disabled'] or r['expires_at'] < time.time():
        return None
    r.pop('expires_at')
    r.pop('disabled')
    return r


def end_session(db, token):
    if token:
        db.x('DELETE FROM sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))


def login_blocked(db, username, ip):
    """Five failed attempts per username+address, or 20 per address, in 15 minutes block further tries."""
    since = time.time() - 900
    per_user = db.one('SELECT COUNT(*) AS n FROM login_failures WHERE key=? AND at>?', (f'{username.lower()}|{ip}', since))['n']
    per_ip = db.one('SELECT COUNT(*) AS n FROM login_failures WHERE ip=? AND at>?', (ip, since))['n']
    return per_user >= 5 or per_ip >= 20


def record_login_failure(db, username, ip):
    db.x('INSERT INTO login_failures (key, ip, at) VALUES (?,?,?)', (f'{username.lower()}|{ip}', ip, time.time()))


def has_role(user, role):
    return bool(user) and ROLE_RANK.get(user['role'], -1) >= ROLE_RANK[role]


# ---------------- tamper-evident audit trail ----------------
def _audit_hash(at, user_id, username, action, hospital, detail, prev):
    body = json.dumps([at, user_id, username, action, hospital, detail, prev], ensure_ascii=False)
    return hashlib.sha256(body.encode()).hexdigest()


def audit(db, user, action, hospital=None, detail=None):
    """Append an entry whose hash covers the previous entry, so any edit or deletion breaks the chain."""
    with db.lock:
        last = db.one('SELECT hash FROM audit ORDER BY id DESC LIMIT 1')
        prev = last['hash'] if last else 'GENESIS'
        at = round(time.time(), 3)
        det = json.dumps(detail, ensure_ascii=False, sort_keys=True) if detail is not None else ''
        uid, uname = (user['id'], user['username']) if user else (None, 'system')
        h = _audit_hash(at, uid, uname, action, hospital, det, prev)
        db.x('INSERT INTO audit (at, user_id, username, action, hospital, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)',
             (at, uid, uname, action, hospital, det, prev, h))


def verify_audit(db):
    prev = 'GENESIS'
    rows = db.q('SELECT * FROM audit ORDER BY id')
    for r in rows:
        if r['prev_hash'] != prev or _audit_hash(r['at'], r['user_id'], r['username'], r['action'], r['hospital'], r['detail'], r['prev_hash']) != r['hash']:
            return {'ok': False, 'entries': len(rows), 'broken_at': r['id']}
        prev = r['hash']
    return {'ok': True, 'entries': len(rows), 'broken_at': None}


# ---------------- encryption at rest ----------------
def encryption_available():
    return AESGCM is not None


def _data_key():
    k = env('SURGEWATCH_DATA_KEY')
    if k:
        key = base64.urlsafe_b64decode(k + '=' * (-len(k) % 4))
        if len(key) != 32:
            raise ValueError('SURGEWATCH_DATA_KEY must be 32 bytes, base64-encoded')
        return key
    path = data_dir() / 'data.key'
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(secrets.token_bytes(32))
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    return path.read_bytes()


def seal(obj):
    raw = json.dumps(obj, separators=(',', ':')).encode()
    if AESGCM is None:
        return raw, False
    nonce = secrets.token_bytes(12)
    return b'SW1' + nonce + AESGCM(_data_key()).encrypt(nonce, raw, b'surgewatch-census'), True


def unseal(blob, encrypted):
    blob = bytes(blob)
    if not encrypted:
        return json.loads(blob)
    if AESGCM is None:
        raise RuntimeError('Census data is encrypted but the cryptography package is not installed')
    if blob[:3] != b'SW1':
        raise ValueError('Unknown encrypted format')
    return json.loads(AESGCM(_data_key()).decrypt(blob[3:15], blob[15:], b'surgewatch-census'))


# ---------------- privacy checks on census uploads ----------------
CENSUS_COLS = {'timestamp', 'ed_arrivals', 'ed_census', 'ed_waiting_for_bed', 'med_occupied', 'surg_occupied', 'icu_occupied', 'peds_occupied',
               'iso_occupied', 'lab_backlog', 'platelet_stock', 'oxygen_stock', 'ambulances_busy', 'admissions', 'discharges', 't'}
PII_HEADER = re.compile(r'(^|_)(name|patient_name|patient_id|mrd|mrd_no|mrn|uhid|ip_no|ipd_no|registration_no|reg_no|phone|mobile|contact_no|address|'
                        r'aadhar|aadhaar|abha|email|dob|date_of_birth|age|gender|sex|bed_no)($|_)')


def check_census(rows):
    """Accept only aggregate counts: known columns, numeric values, no identifier-like fields. Returns (clean_rows, error)."""
    if not isinstance(rows, list) or not rows:
        return None, 'No rows.'
    if len(rows) > 20000:
        return None, 'Too many rows (limit 20,000).'
    clean = []
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            return None, f'Row {i + 1} is not an object.'
        bad = [k for k in r if PII_HEADER.search(str(k).lower())]
        if bad:
            return None, f'Row {i + 1} has identifier-like fields ({", ".join(bad)}). Only aggregate counts are accepted.'
        out = {}
        for k, v in r.items():
            if k not in CENSUS_COLS:
                continue
            if k == 'timestamp':
                if not isinstance(v, str) or len(v) > 40:
                    return None, f'Row {i + 1}: bad timestamp.'
                out[k] = v
            elif v is None:
                out[k] = None
            elif isinstance(v, (int, float)) and not isinstance(v, bool) and -1e7 < v < 1e14:
                out[k] = v
            else:
                return None, f'Row {i + 1}: "{k}" must be a number.'
        if 't' not in out or out['t'] is None:
            return None, f'Row {i + 1}: missing time.'
        clean.append(out)
    return clean, None


def apply_retention(db):
    """Delete expired sessions, old login failures and census rows older than the retention period."""
    now = time.time()
    db.x('DELETE FROM sessions WHERE expires_at < ?', (now,))
    db.x('DELETE FROM login_failures WHERE at < ?', (now - 86400,))
    cutoff_ms = (now - retention_days() * 86400) * 1000
    trimmed = 0
    for c in db.q('SELECT hospital, blob, encrypted, rev FROM census'):
        try:
            data = unseal(c['blob'], c['encrypted'])
        except Exception:
            continue
        rows = [r for r in data.get('rows', []) if (r.get('t') or 0) >= cutoff_ms]
        if len(rows) == len(data.get('rows', [])):
            continue
        trimmed += len(data['rows']) - len(rows)
        if rows:
            data['rows'] = rows
            blob, enc = seal(data)
            db.x('UPDATE census SET blob=?, encrypted=?, rows=?, first_ms=?, rev=rev+1 WHERE hospital=?', (blob, int(enc), len(rows), rows[0]['t'], c['hospital']))
        else:
            db.x('DELETE FROM census WHERE hospital=?', (c['hospital'],))
    if trimmed:
        audit(db, None, 'retention.census_trimmed', None, {'rows': trimmed, 'older_than_days': retention_days()})
    return trimmed
