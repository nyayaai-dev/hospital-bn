"""Surge Watch team server.

Serves the website and adds what a browser alone cannot do: shared data for the whole team, sign-in with
roles, a tamper-evident audit trail, sending approved alerts, a daily BMC news collector and privacy controls.

Run:  py server/app.py                      (http://127.0.0.1:8000)
      py server/app.py --host 0.0.0.0       (share on the hospital network; put HTTPS in front)
Python 3.9+ standard library only. Optional: `pip install cryptography` turns on encryption at rest.
"""
import argparse
import http.cookies
import ipaddress
import json
import mimetypes
import re
import ssl
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collector  # noqa: E402
import core  # noqa: E402
import notify  # noqa: E402
from core import ROLES, audit, env, has_role  # noqa: E402

VERSION = '1.0'
SITE = Path(__file__).resolve().parent.parent
STATIC = {'/': 'index.html', '/index.html': 'index.html', '/data.js': 'data.js', '/model.js': 'model.js', '/worker.js': 'worker.js'}
HOSP_RE = re.compile(r'^[a-z0-9_-]{1,32}$')
COOKIE = 'sw_session'
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com; img-src 'self' data:; worker-src 'self'; "
       "connect-src 'self' https://api.open-meteo.com https://air-quality-api.open-meteo.com https://archive-api.open-meteo.com; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def need(cond, status, message):
    if not cond:
        raise ApiError(status, message)


def hosp(h):
    need(isinstance(h, str) and HOSP_RE.match(h), 400, 'Unknown hospital id')
    return h


def num(v, lo, hi, name):
    need(isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi, 400, f'{name} is out of range')
    return v


def text(v, n, name, required=False):
    if v is None or v == '':
        need(not required, 400, f'{name} is required')
        return ''
    need(isinstance(v, str) and len(v) <= n, 400, f'{name} is too long')
    return v.strip()


ROUTES = []


def route(method, pattern, role=None):
    def deco(fn):
        ROUTES.append((method, re.compile('^' + pattern + '$'), role, fn))
        return fn
    return deco


# ---------------- accounts ----------------
@route('GET', '/api/health')
def health(h, user, body):
    return {'ok': True, 'team': True, 'version': VERSION, 'encryption': core.encryption_available(), 'channels': notify.channels(),
            'retention_days': core.retention_days(), 'collector': env('SURGEWATCH_COLLECTOR', '1') != '0', 'https': h.server.https,
            'session_hours': core.session_hours()}


@route('GET', '/api/me')
def me(h, user, body):
    return {'user': user, 'setup_needed': h.db.one('SELECT COUNT(*) AS n FROM users')['n'] == 0}


@route('POST', '/api/setup')
def setup(h, user, body):
    db = h.db
    need(db.one('SELECT COUNT(*) AS n FROM users')['n'] == 0, 409, 'Setup is already done')
    need(h.is_local() or env('SURGEWATCH_ALLOW_REMOTE_SETUP') == '1', 403, 'The first administrator can only be created from this computer')
    return _create_user(h, None, dict(body, role='admin'), first=True)


def _create_user(h, actor, body, first=False):
    db = h.db
    username = text(body.get('username'), 40, 'Username', True).lower()
    need(core.USERNAME_RE.match(username), 400, 'Username: 3–40 lowercase letters, digits, dot, dash or underscore')
    need(not db.one('SELECT id FROM users WHERE username=?', (username,)), 409, 'That username is taken')
    name = text(body.get('name'), 80, 'Name', True)
    role = body.get('role', 'viewer')
    need(role in ROLES, 400, 'Unknown role')
    pw = body.get('password') or ''
    prob = core.password_problem(pw, username)
    need(not prob, 400, prob or '')
    email = text(body.get('email'), 120, 'Email')
    need(not email or notify.EMAIL_RE.match(email), 400, 'Email is not valid')
    phone = text(body.get('phone'), 20, 'Phone')
    need(not phone or notify.PHONE_RE.match(phone), 400, 'Phone must be in international format, e.g. +919820012345')
    uid = db.x('INSERT INTO users (username, name, role, email, phone, pw_hash, created_at) VALUES (?,?,?,?,?,?,?)',
               (username, name, role, email, phone, core.hash_password(pw), time.time()))
    audit(db, actor or {'id': uid, 'username': username}, 'user.created', None, {'username': username, 'role': role, 'first_admin': first})
    if first:
        token = core.new_session(db, uid, h.client_ip())
        h.set_cookie(token)
    return {'user': _public_user(db.one('SELECT * FROM users WHERE id=?', (uid,)))}


def _public_user(u):
    return {k: u[k] for k in ('id', 'username', 'name', 'role', 'email', 'phone')} | ({'disabled': bool(u['disabled'])} if 'disabled' in u else {})


@route('POST', '/api/login')
def login(h, user, body):
    db, ip = h.db, h.client_ip()
    username = text(body.get('username'), 40, 'Username', True).lower()
    need(not core.login_blocked(db, username, ip), 429, 'Too many failed attempts. Wait 15 minutes and try again.')
    u = db.one('SELECT * FROM users WHERE username=?', (username,))
    if not u or u['disabled'] or not core.check_password(body.get('password') or '', u['pw_hash']):
        core.record_login_failure(db, username, ip)
        audit(db, None, 'login.failed', None, {'username': username, 'ip': ip})
        raise ApiError(401, 'Wrong username or password')
    h.set_cookie(core.new_session(db, u['id'], ip))
    audit(db, u, 'login', None, {'ip': ip})
    return {'user': _public_user(u)}


@route('POST', '/api/logout')
def logout(h, user, body):
    core.end_session(h.db, h.token())
    h.set_cookie('', expire=True)
    if user:
        audit(h.db, user, 'logout')
    return {'ok': True}


@route('POST', '/api/password', 'viewer')
def change_password(h, user, body):
    u = h.db.one('SELECT * FROM users WHERE id=?', (user['id'],))
    need(core.check_password(body.get('current') or '', u['pw_hash']), 403, 'Current password is wrong')
    prob = core.password_problem(body.get('new') or '', u['username'])
    need(not prob, 400, prob or '')
    h.db.x('UPDATE users SET pw_hash=? WHERE id=?', (core.hash_password(body['new']), user['id']))
    h.db.x('DELETE FROM sessions WHERE user_id=?', (user['id'],))
    h.set_cookie(core.new_session(h.db, user['id'], h.client_ip()))
    audit(h.db, user, 'password.changed')
    return {'ok': True}


@route('GET', '/api/users', 'admin')
def users(h, user, body):
    return {'users': [_public_user(u) for u in h.db.q('SELECT * FROM users ORDER BY username')]}


@route('POST', '/api/users', 'admin')
def add_user(h, user, body):
    return _create_user(h, user, body)


@route('PATCH', r'/api/users/(\d+)', 'admin')
def edit_user(h, user, body, uid):
    db = h.db
    u = db.one('SELECT * FROM users WHERE id=?', (int(uid),))
    need(u, 404, 'No such user')
    changes = {}
    if 'role' in body:
        need(body['role'] in ROLES, 400, 'Unknown role')
        changes['role'] = body['role']
    if 'disabled' in body:
        changes['disabled'] = 1 if body['disabled'] else 0
    if 'name' in body:
        changes['name'] = text(body['name'], 80, 'Name', True)
    if body.get('password'):
        prob = core.password_problem(body['password'], u['username'])
        need(not prob, 400, prob or '')
        changes['pw_hash'] = core.hash_password(body['password'])
    if changes.get('role', 'admin') != 'admin' or changes.get('disabled'):
        admins = db.one("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0 AND id<>?", (u['id'],))['n']
        need(u['role'] != 'admin' or admins > 0, 400, 'Keep at least one active administrator')
    for k, v in changes.items():
        db.x(f'UPDATE users SET {k}=? WHERE id=?', (v, u['id']))
    if 'disabled' in changes or 'pw_hash' in changes or 'role' in changes:
        db.x('DELETE FROM sessions WHERE user_id=?', (u['id'],))
    audit(db, user, 'user.changed', None, {'username': u['username'], **{k: v for k, v in changes.items() if k != 'pw_hash'}, 'password_reset': 'pw_hash' in changes})
    return {'user': _public_user(db.one('SELECT * FROM users WHERE id=?', (u['id'],)))}


# ---------------- shared hospital data ----------------
def _approvals(db, hid):
    return db.q('SELECT id, action_id, title, at_ms, by_name, by_role, created_at FROM approvals WHERE hospital=? AND withdrawn_at IS NULL ORDER BY id', (hid,))


def _alerts(db, hid):
    out = []
    for a in db.q('SELECT * FROM alerts WHERE hospital=? ORDER BY created_at DESC LIMIT 60', (hid,)):
        d = json.loads(a['data'])
        d.update({'id': a['id'], 'status': a['status'], 'updated_by': a['updated_by'], 'updated_at': a['updated_at']})
        out.append(d)
    return out


def _people(db):
    return db.q('SELECT id, role, email, phone, units, min_sev FROM people ORDER BY id')


def _reports(db):
    return [json.loads(r['data']) | {'by': r['created_by']} for r in db.q('SELECT * FROM reports ORDER BY created_at')]


@route('GET', r'/api/sync/([a-z0-9_-]{1,32})', 'viewer')
def sync(h, user, body, hid):
    db = h.db
    s = db.one('SELECT data, rev, updated_by, updated_at FROM setups WHERE hospital=?', (hid,))
    c = db.one('SELECT rows, first_ms, last_ms, rev, uploaded_by, uploaded_at, encrypted FROM census WHERE hospital=?', (hid,))
    msgs = db.q('SELECT alert_id, channel, recipient, subject, status, error, sent_by, at FROM messages WHERE hospital=? ORDER BY id DESC LIMIT 40', (hid,))
    return {'server_time': time.time(), 'approvals': _approvals(db, hid), 'alerts': _alerts(db, hid), 'people': _people(db), 'reports': _reports(db),
            'setup': ({'data': json.loads(s['data']), 'rev': s['rev'], 'by': s['updated_by'], 'at': s['updated_at']} if s else None),
            'census': (dict(c, encrypted=bool(c['encrypted'])) if c else None), 'messages': msgs,
            'collector': {'last': db.meta('collector'), 'new': db.one("SELECT COUNT(*) AS n FROM candidates WHERE status='new'")['n']}}


@route('POST', '/api/approvals', 'approver')
def approve(h, user, body):
    db, hid = h.db, hosp(body.get('hospital'))
    action = text(body.get('action_id'), 40, 'Action', True)
    need(not db.one('SELECT id FROM approvals WHERE hospital=? AND action_id=? AND withdrawn_at IS NULL', (hid, action)), 409, 'This action is already approved')
    at_ms = num(body.get('at_ms'), 0, 1e14, 'Time')
    title = text(body.get('title'), 200, 'Title')
    aid = db.x('INSERT INTO approvals (hospital, action_id, title, at_ms, user_id, by_name, by_role, created_at) VALUES (?,?,?,?,?,?,?,?)',
               (hid, action, title, at_ms, user['id'], user['name'], user['role'], time.time()))
    audit(db, user, 'action.approved', hid, {'action': action, 'title': title})
    return {'approval': db.one('SELECT id, action_id, title, at_ms, by_name, by_role, created_at FROM approvals WHERE id=?', (aid,))}


@route('DELETE', r'/api/approvals/(\d+)', 'approver')
def withdraw(h, user, body, aid):
    db = h.db
    a = db.one('SELECT * FROM approvals WHERE id=? AND withdrawn_at IS NULL', (int(aid),))
    need(a, 404, 'No such active approval')
    db.x('UPDATE approvals SET withdrawn_at=?, withdrawn_by=? WHERE id=?', (time.time(), user['username'], a['id']))
    audit(db, user, 'action.withdrawn', a['hospital'], {'action': a['action_id'], 'approved_by': a['by_name']})
    return {'ok': True}


ALERT_FIELDS = ('unit', 'sev', 'epi', 'created_ms', 'start_ms', 'subject', 'body', 'tr')


@route('POST', '/api/alerts', 'staff')
def post_alert(h, user, body):
    db, hid = h.db, hosp(body.get('hospital'))
    a = body.get('alert') or {}
    need(isinstance(a, dict), 400, 'Bad alert')
    data = {k: a.get(k) for k in ALERT_FIELDS}
    need(data['sev'] in ('warning', 'critical'), 400, 'Bad severity')
    text(data['unit'], 10, 'Unit', True)
    text(data['subject'], 400, 'Subject', True)
    text(data['body'], 20000, 'Body', True)
    num(data['start_ms'], 0, 1e14, 'Start')
    num(data['created_ms'], 0, 1e14, 'Created')
    need(len(json.dumps(data.get('tr') or {})) < 60000, 400, 'Translations too long')
    # One draft per unit, severity and start day; a repeat within 72 h returns the existing draft.
    dedupe = f"{data['unit']}|{data['sev']}|{int(data['start_ms'] // 86400000)}"
    ex = db.one("SELECT id FROM alerts WHERE hospital=? AND dedupe=? AND created_at>?", (hid, dedupe, time.time() - 72 * 3600))
    if ex:
        return {'id': ex['id'], 'existing': True}
    aid = 'a' + core.secrets.token_hex(6)
    db.x('INSERT INTO alerts (id, hospital, dedupe, data, status, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)',
         (aid, hid, dedupe, json.dumps(data), 'review', time.time(), time.time(), 'model'))
    audit(db, user, 'alert.drafted', hid, {'id': aid, 'unit': data['unit'], 'sev': data['sev']})
    return {'id': aid, 'existing': False}


@route('PATCH', r'/api/alerts/([a-z0-9]{2,20})', 'staff')
def patch_alert(h, user, body, aid):
    db = h.db
    a = db.one('SELECT * FROM alerts WHERE id=?', (aid,))
    need(a, 404, 'No such alert')
    st = body.get('status')
    need(st in ('dismissed', 'sent', 'review'), 400, 'Bad status')
    need(st != 'sent' or has_role(user, 'approver'), 403, 'Only approvers can mark alerts as sent')
    db.x('UPDATE alerts SET status=?, updated_at=?, updated_by=? WHERE id=?', (st, time.time(), user['name'], aid))
    audit(db, user, f'alert.{st}', a['hospital'], {'id': aid, 'note': text(body.get('note'), 200, 'Note')})
    return {'ok': True}


def _recipients(db, unit, sev):
    out = []
    for p in _people(db):
        units = p['units'].split(',') if p['units'] != 'ALL' else None
        if (units is None or unit in units) and (p['min_sev'] == 'warning' or sev == 'critical'):
            out.append(p)
    return out


@route('POST', r'/api/alerts/([a-z0-9]{2,20})/send', 'approver')
def send_alert(h, user, body, aid):
    """Send to the stakeholders whose rules match this alert. Recipients come from the server's list, never from the request."""
    db = h.db
    a = db.one('SELECT * FROM alerts WHERE id=?', (aid,))
    need(a, 404, 'No such alert')
    d = json.loads(a['data'])
    chans = body.get('channels') or ['email']
    need(isinstance(chans, list) and chans and all(c in ('email', 'sms', 'whatsapp') for c in chans), 400, 'Unknown channel')
    lang = body.get('lang') if body.get('lang') in ('en', 'hi', 'mr') else 'en'
    tr = (d.get('tr') or {}).get(lang) if lang != 'en' else None
    subject = (tr or {}).get('subject') or d['subject']
    text_body = (tr or {}).get('body') or d['body']
    if tr:
        text_body += '\n\n— English version —\n' + d['subject'] + '\n\n' + d['body']
    text_body += f"\n\nApproved for sending by {user['name']} ({user['role']}) in Surge Watch."
    results = []
    for p in _recipients(db, 'EPI' if d.get('epi') else d['unit'], d['sev']):
        for ch in chans:
            to = p['email'] if ch == 'email' else p['phone']
            if not to:
                continue
            status, err = notify.deliver(ch, to, subject, text_body)
            db.x('INSERT INTO messages (hospital, alert_id, channel, recipient, subject, status, error, sent_by, at) VALUES (?,?,?,?,?,?,?,?,?)',
                 (a['hospital'], aid, ch, to, subject, status, err, user['name'], time.time()))
            results.append({'channel': ch, 'to': to, 'role': p['role'], 'status': status, 'error': err})
    sent = sum(r['status'] == 'sent' for r in results)
    if sent:
        db.x('UPDATE alerts SET status=?, updated_at=?, updated_by=? WHERE id=?', ('sent', time.time(), user['name'], aid))
    audit(db, user, 'alert.send', a['hospital'], {'id': aid, 'channels': chans, 'lang': lang, 'sent': sent, 'attempted': len(results)})
    return {'sent': sent, 'results': results}


@route('POST', '/api/people', 'staff')
def add_person(h, user, body):
    role = text(body.get('role'), 80, 'Role', True)
    email = text(body.get('email'), 120, 'Email')
    phone = text(body.get('phone'), 20, 'Phone')
    need(email or phone, 400, 'Give an email or a phone number')
    need(not email or notify.EMAIL_RE.match(email), 400, 'Email is not valid')
    need(not phone or notify.PHONE_RE.match(phone), 400, 'Phone must be in international format, e.g. +919820012345')
    units = text(body.get('units'), 120, 'Units', True)
    need(re.match(r'^(ALL|[A-Z0-9]{2,6}(,[A-Z0-9]{2,6})*)$', units), 400, 'Bad unit list')
    sev = body.get('min_sev', 'warning')
    need(sev in ('warning', 'critical'), 400, 'Bad severity')
    pid = h.db.x('INSERT INTO people (role, email, phone, units, min_sev, created_by, created_at) VALUES (?,?,?,?,?,?,?)', (role, email, phone, units, sev, user['username'], time.time()))
    audit(h.db, user, 'stakeholder.added', None, {'id': pid, 'role': role})
    return {'id': pid}


@route('PATCH', r'/api/people/(\d+)', 'staff')
def edit_person(h, user, body, pid):
    sev = body.get('min_sev')
    need(sev in ('warning', 'critical'), 400, 'Bad severity')
    need(h.db.one('SELECT id FROM people WHERE id=?', (int(pid),)), 404, 'No such stakeholder')
    h.db.x('UPDATE people SET min_sev=? WHERE id=?', (sev, int(pid)))
    audit(h.db, user, 'stakeholder.changed', None, {'id': int(pid), 'min_sev': sev})
    return {'ok': True}


@route('DELETE', r'/api/people/(\d+)', 'staff')
def del_person(h, user, body, pid):
    p = h.db.one('SELECT * FROM people WHERE id=?', (int(pid),))
    need(p, 404, 'No such stakeholder')
    h.db.x('DELETE FROM people WHERE id=?', (p['id'],))
    audit(h.db, user, 'stakeholder.removed', None, {'id': p['id'], 'role': p['role']})
    return {'ok': True}


DISEASE_IDS = ('dengue', 'malaria', 'lepto', 'gastro', 'hep', 'flu', 'chik')


def _report_from(body, user):
    frm, to = num(body.get('from'), 0, 1e14, 'First day'), num(body.get('to'), 0, 1e14, 'Last day')
    need(to >= frm, 400, 'The last day must be on or after the first day')
    counts = body.get('counts') or {}
    need(isinstance(counts, dict) and counts, 400, 'Enter at least one count')
    clean = {}
    for k, v in counts.items():
        need(k in DISEASE_IDS, 400, f'Unknown disease {k}')
        clean[k] = int(num(v, 0, 1e6, k))
    return {'id': 'r' + core.secrets.token_hex(5), 'from': frm, 'to': to, 'counts': clean, 'src': text(body.get('src'), 400, 'Source'), 'added': time.time() * 1000}


@route('POST', '/api/reports', 'staff')
def add_report(h, user, body):
    r = _report_from(body, user)
    h.db.x('INSERT INTO reports (id, data, created_by, created_at) VALUES (?,?,?,?)', (r['id'], json.dumps(r), user['name'], time.time()))
    audit(h.db, user, 'report.added', None, {'id': r['id'], 'counts': r['counts']})
    return {'report': r}


@route('DELETE', r'/api/reports/([a-z0-9-]{2,30})', 'staff')
def del_report(h, user, body, rid):
    need(h.db.one('SELECT id FROM reports WHERE id=?', (rid,)), 404, 'No such report')
    h.db.x('DELETE FROM reports WHERE id=?', (rid,))
    audit(h.db, user, 'report.removed', None, {'id': rid})
    return {'ok': True}


@route('PUT', r'/api/setup/([a-z0-9_-]{1,32})', 'staff')
def put_setup(h, user, body, hid):
    db = h.db
    data = body.get('data')
    need(isinstance(data, dict) and len(json.dumps(data)) < 50000, 400, 'Bad setup data')
    cur = db.one('SELECT rev FROM setups WHERE hospital=?', (hid,))
    need(body.get('rev') == (cur['rev'] if cur else 0), 409, 'Someone else saved this setup first. Reload and try again.')
    rev = (cur['rev'] if cur else 0) + 1
    db.x('INSERT INTO setups (hospital, data, rev, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(hospital) DO UPDATE SET data=excluded.data, rev=excluded.rev, updated_by=excluded.updated_by, updated_at=excluded.updated_at',
         (hid, json.dumps(data), rev, user['name'], time.time()))
    audit(db, user, 'setup.saved', hid, {'rev': rev, 'changed': data.get('changed', [])})
    return {'rev': rev}


@route('DELETE', r'/api/setup/([a-z0-9_-]{1,32})', 'staff')
def del_setup(h, user, body, hid):
    h.db.x('DELETE FROM setups WHERE hospital=?', (hid,))
    audit(h.db, user, 'setup.reset', hid)
    return {'ok': True}


_census_reads = {}


@route('GET', r'/api/census/([a-z0-9_-]{1,32})', 'viewer')
def get_census(h, user, body, hid):
    c = h.db.one('SELECT * FROM census WHERE hospital=?', (hid,))
    need(c, 404, 'No census data for this hospital')
    key = (user['id'], hid)
    if time.time() - _census_reads.get(key, 0) > 6 * 3600:  # log data access, at most every 6 h per person
        _census_reads[key] = time.time()
        audit(h.db, user, 'census.read', hid, {'rows': c['rows']})
    return dict(core.unseal(c['blob'], c['encrypted']), rev=c['rev'])


@route('PUT', r'/api/census/([a-z0-9_-]{1,32})', 'staff')
def put_census(h, user, body, hid):
    rows, err = core.check_census(body.get('rows'))
    need(not err, 400, err or '')
    head = [x for x in (body.get('head') or []) if x in core.CENSUS_COLS][:20]
    blob, enc = core.seal({'rows': rows, 'head': head, 'daily': bool(body.get('daily')), 'sample': bool(body.get('sample'))})
    cur = h.db.one('SELECT rev FROM census WHERE hospital=?', (hid,))
    rev = (cur['rev'] if cur else 0) + 1
    h.db.x('INSERT INTO census (hospital, blob, encrypted, rows, first_ms, last_ms, rev, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?) '
           'ON CONFLICT(hospital) DO UPDATE SET blob=excluded.blob, encrypted=excluded.encrypted, rows=excluded.rows, first_ms=excluded.first_ms, last_ms=excluded.last_ms, rev=excluded.rev, uploaded_by=excluded.uploaded_by, uploaded_at=excluded.uploaded_at',
           (hid, blob, int(enc), len(rows), rows[0]['t'], rows[-1]['t'], rev, user['name'], time.time()))
    audit(h.db, user, 'census.uploaded', hid, {'rows': len(rows), 'encrypted': enc, 'columns': head})
    return {'rev': rev, 'encrypted': enc}


@route('DELETE', r'/api/census/([a-z0-9_-]{1,32})', 'staff')
def del_census(h, user, body, hid):
    h.db.x('DELETE FROM census WHERE hospital=?', (hid,))
    audit(h.db, user, 'census.deleted', hid)
    return {'ok': True}


@route('POST', '/api/validations', 'staff')
def post_validation(h, user, body):
    hid = hosp(body.get('hospital'))
    res = body.get('result')
    need(isinstance(res, dict) and len(json.dumps(res)) < 100000, 400, 'Bad validation result')
    vid = h.db.x('INSERT INTO validations (hospital, data, created_by, created_at) VALUES (?,?,?,?)', (hid, json.dumps(res), user['name'], time.time()))
    audit(h.db, user, 'validation.saved', hid, {'id': vid, 'real_data': bool(res.get('realData')), 'origins': res.get('origins')})
    return {'id': vid}


@route('GET', r'/api/validations/([a-z0-9_-]{1,32})', 'viewer')
def get_validations(h, user, body, hid):
    return {'validations': [dict(json.loads(v['data']), by=v['created_by'], at=v['created_at']) for v in h.db.q('SELECT * FROM validations WHERE hospital=? ORDER BY id DESC LIMIT 10', (hid,))]}


# ---------------- collector ----------------
@route('GET', '/api/collector', 'viewer')
def get_collector(h, user, body):
    rows = h.db.q("SELECT id, url, title, source, published, counts, status FROM candidates WHERE status='new' ORDER BY published DESC LIMIT 40")
    for r in rows:
        r['counts'] = json.loads(r['counts'] or '{}')
    return {'last': h.db.meta('collector'), 'candidates': rows, 'enabled': env('SURGEWATCH_COLLECTOR', '1') != '0'}


@route('POST', '/api/collector/run', 'approver')
def run_collector(h, user, body):
    audit(h.db, user, 'collector.run_requested')
    return collector.run_once(h.db)


@route('POST', r'/api/collector/(\d+)/accept', 'approver')
def accept_candidate(h, user, body, cid):
    db = h.db
    c = db.one("SELECT * FROM candidates WHERE id=? AND status='new'", (int(cid),))
    need(c, 404, 'No such candidate')
    r = _report_from(dict(body, src=f"{c['title']} {c['url']}"[:400]), user)
    db.x('INSERT INTO reports (id, data, created_by, created_at) VALUES (?,?,?,?)', (r['id'], json.dumps(r), user['name'], time.time()))
    db.x('UPDATE candidates SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?', ('accepted', user['name'], time.time(), c['id']))
    audit(db, user, 'collector.accepted', None, {'candidate': c['id'], 'report': r['id'], 'counts': r['counts']})
    return {'report': r}


@route('POST', r'/api/collector/(\d+)/dismiss', 'staff')
def dismiss_candidate(h, user, body, cid):
    need(h.db.one('SELECT id FROM candidates WHERE id=?', (int(cid),)), 404, 'No such candidate')
    h.db.x('UPDATE candidates SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?', ('dismissed', user['name'], time.time(), int(cid)))
    audit(h.db, user, 'collector.dismissed', None, {'candidate': int(cid)})
    return {'ok': True}


# ---------------- audit ----------------
@route('GET', '/api/audit', 'admin')
def get_audit(h, user, body):
    rows = h.db.q('SELECT id, at, username, action, hospital, detail FROM audit ORDER BY id DESC LIMIT 200')
    return {'entries': rows, 'verify': core.verify_audit(h.db)}


# ---------------- HTTP plumbing ----------------
class Handler(BaseHTTPRequestHandler):
    server_version = 'SurgeWatch/' + VERSION
    sys_version = ''

    @property
    def db(self):
        return self.server.db

    def log_message(self, fmt, *args):  # quieter console, no query strings
        if not self.server.quiet:
            sys.stderr.write('%s %s\n' % (self.log_date_time_string(), fmt % args))

    def client_ip(self):
        return self.client_address[0]

    def is_local(self):
        try:
            return ipaddress.ip_address(self.client_ip()).is_loopback
        except ValueError:
            return False

    def token(self):
        c = http.cookies.SimpleCookie(self.headers.get('Cookie', ''))
        return c[COOKIE].value if COOKIE in c else None

    def set_cookie(self, token, expire=False):
        parts = [f'{COOKIE}={token}', 'Path=/', 'HttpOnly', 'SameSite=Strict']
        if self.server.https or env('SURGEWATCH_SECURE_COOKIE') == '1':
            parts.append('Secure')
        parts.append('Max-Age=0' if expire else f'Max-Age={int(core.session_hours() * 3600)}')
        self._cookies.append('; '.join(parts))

    def security_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        self.send_header('Content-Security-Policy', CSP)
        if self.server.https:
            self.send_header('Strict-Transport-Security', 'max-age=31536000')

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for c in self._cookies:
            self.send_header('Set-Cookie', c)
        self.security_headers()
        self.end_headers()
        self.wfile.write(data)

    def handle_one(self, method):
        self._cookies = []
        path = self.path.split('?', 1)[0]
        try:
            if path.startswith('/api/'):
                return self.api(method, path)
            if method != 'GET' or path not in STATIC:
                return self.send_json(404, {'error': 'Not found'})
            f = SITE / STATIC[path]
            data = f.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', (mimetypes.guess_type(f.name)[0] or 'application/octet-stream') + ('; charset=utf-8' if f.suffix in ('.html', '.js') else ''))
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-cache')
            self.security_headers()
            self.end_headers()
            self.wfile.write(data)
        except ApiError as e:
            self.send_json(e.status, {'error': e.message})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {'error': 'Server error'})

    def api(self, method, path):
        if method != 'GET':
            # Mutating requests must carry this header; browsers cannot add it cross-site without a CORS preflight, which this server never grants.
            need(self.headers.get('X-Surge-Watch') == '1', 403, 'Missing request header')
            origin = self.headers.get('Origin')
            need(not origin or origin.split('://', 1)[-1] == self.headers.get('Host'), 403, 'Cross-site request refused')
        body = {}
        n = int(self.headers.get('Content-Length') or 0)
        need(n <= 25_000_000, 413, 'Request too large')
        if n:
            try:
                body = json.loads(self.rfile.read(n) or b'{}')
            except ValueError:
                raise ApiError(400, 'Body must be JSON')
            need(isinstance(body, dict), 400, 'Body must be a JSON object')
        user = core.user_for_token(self.db, self.token())
        for m, rx, role, fn in ROUTES:
            mt = rx.match(path)
            if m == method and mt:
                if role:
                    need(user, 401, 'Please sign in')
                    need(has_role(user, role), 403, f'Your role ({user["role"]}) cannot do this; it needs {role} or higher')
                return self.send_json(200, fn(self, user, body, *mt.groups()))
        raise ApiError(404, 'Unknown API endpoint')

    def do_GET(self):
        self.handle_one('GET')

    def do_POST(self):
        self.handle_one('POST')

    def do_PUT(self):
        self.handle_one('PUT')

    def do_PATCH(self):
        self.handle_one('PATCH')

    def do_DELETE(self):
        self.handle_one('DELETE')


def make_server(host='127.0.0.1', port=8000, db=None, quiet=False, cert=None, key=None):
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    srv.db = db or core.DB()
    srv.quiet = quiet
    srv.https = False
    if cert and key:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        srv.https = True
    return srv


def main():
    ap = argparse.ArgumentParser(description='Surge Watch team server')
    ap.add_argument('--host', default=env('SURGEWATCH_HOST', '127.0.0.1'))
    ap.add_argument('--port', type=int, default=int(env('SURGEWATCH_PORT', '8000')))
    ap.add_argument('--cert', default=env('SURGEWATCH_CERT'), help='TLS certificate file (PEM) to serve HTTPS directly')
    ap.add_argument('--key', default=env('SURGEWATCH_KEY'), help='TLS private key file (PEM)')
    a = ap.parse_args()
    srv = make_server(a.host, a.port, cert=a.cert, key=a.key)
    core.apply_retention(srv.db)
    collector.start_scheduler(srv.db)

    def daily():
        while True:
            time.sleep(86400)
            core.apply_retention(srv.db)
    import threading
    threading.Thread(target=daily, daemon=True).start()
    scheme = 'https' if srv.https else 'http'
    print(f'Surge Watch server {VERSION} on {scheme}://{a.host}:{a.port}/  (data: {srv.db.path})')
    print(f"Encryption at rest: {'on (AES-256-GCM)' if core.encryption_available() else 'OFF - install the cryptography package to enable'}")
    print('Channels:', ', '.join(f"{k} {'ready' if v else 'not configured'}" for k, v in notify.channels().items()))
    if a.host not in ('127.0.0.1', 'localhost') and not srv.https:
        print('WARNING: serving on the network without HTTPS. Put a TLS proxy in front or pass --cert/--key.')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
