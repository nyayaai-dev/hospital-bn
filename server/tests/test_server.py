"""End-to-end tests for the Surge Watch server. Run: py -m unittest discover -s server/tests -v"""
import http.cookiejar
import http.server
import json
import os
import socketserver
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
TMP = tempfile.mkdtemp(prefix='surgewatch-test-')
os.environ.update({'SURGEWATCH_DATA_DIR': TMP, 'SURGEWATCH_COLLECTOR': '0'})

import app  # noqa: E402
import collector  # noqa: E402
import core  # noqa: E402


class FakeSMTP(socketserver.ThreadingTCPServer):
    """Minimal SMTP receiver that records messages (no TLS)."""
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self):
        self.messages = []

        class H(socketserver.StreamRequestHandler):
            def handle(h):
                h.wfile.write(b'220 fake ESMTP\r\n')
                rcpt, data_mode, buf = [], False, []
                while True:
                    line = h.rfile.readline()
                    if not line:
                        return
                    if data_mode:
                        if line in (b'.\r\n', b'.\n'):
                            self.messages.append({'rcpt': rcpt, 'data': b''.join(buf).decode('utf-8', 'replace')})
                            data_mode, buf, rcpt = False, [], []
                            h.wfile.write(b'250 queued\r\n')
                        else:
                            buf.append(line)
                        continue
                    cmd = line.decode().strip().upper()
                    if cmd.startswith(('EHLO', 'HELO')):
                        h.wfile.write(b'250-fake\r\n250 8BITMIME\r\n')
                    elif cmd.startswith('RCPT'):
                        rcpt.append(line.decode().split(':', 1)[1].strip())
                        h.wfile.write(b'250 ok\r\n')
                    elif cmd.startswith('DATA'):
                        data_mode = True
                        h.wfile.write(b'354 go\r\n')
                    elif cmd.startswith('QUIT'):
                        h.wfile.write(b'221 bye\r\n')
                        return
                    else:
                        h.wfile.write(b'250 ok\r\n')
        super().__init__(('127.0.0.1', 0), H)


class FakeTwilio(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        self.posts = []
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get('Content-Length') or 0)
                outer.posts.append({'path': self.path, 'body': self.rfile.read(n).decode(), 'auth': self.headers.get('Authorization')})
                out = b'{"sid": "SM123", "status": "queued"}'
                self.send_response(201)
                self.send_header('Content-Length', str(len(out)))
                self.end_headers()
                self.wfile.write(out)
        super().__init__(('127.0.0.1', 0), H)


class Client:
    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, path, body=None, csrf=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header('Content-Type', 'application/json')
        if csrf:
            req.add_header('X-Surge-Watch', '1')
        try:
            with self.op.open(req, timeout=20) as r:
                return r.status, json.loads(r.read() or b'null'), dict(r.headers)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw), dict(e.headers)
            except ValueError:
                return e.code, raw, dict(e.headers)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = app.make_server('127.0.0.1', 0, db=core.DB(Path(TMP) / 'test.db'), quiet=True)
        cls.base = f'http://127.0.0.1:{cls.srv.server_address[1]}'
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.admin = Client(cls.base)
        st, out, _ = cls.admin.call('POST', '/api/setup', {'username': 'admin', 'name': 'Dr Admin', 'password': 'Correct-Horse-42'})
        assert st == 200, out

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def user(self, username, role, pw='Strong-Pass-2026'):
        st, out, _ = self.admin.call('POST', '/api/users', {'username': username, 'name': username.title(), 'role': role, 'password': pw})
        self.assertIn(st, (200, 409), out)
        c = Client(self.base)
        st, out, _ = c.call('POST', '/api/login', {'username': username, 'password': pw})
        self.assertEqual(st, 200, out)
        return c

    def test_01_health_static_and_headers(self):
        st, out, hdr = Client(self.base).call('GET', '/api/health')
        self.assertEqual(st, 200)
        self.assertTrue(out['team'])
        self.assertIn("frame-ancestors 'none'", hdr['Content-Security-Policy'])
        with urllib.request.urlopen(self.base + '/') as r:
            self.assertIn(b'Surge Watch', r.read())
        for bad in ('/server/core.py', '/../README.md', '/server/data/test.db', '/data.key'):
            self.assertEqual(Client(self.base).call('GET', bad)[0], 404, bad)

    def test_02_setup_only_once_and_login(self):
        c = Client(self.base)
        self.assertEqual(c.call('POST', '/api/setup', {'username': 'x2', 'name': 'X', 'password': 'Another-Pass-9'})[0], 409)
        self.assertEqual(c.call('GET', '/api/sync/kem')[0], 401)
        self.assertEqual(c.call('POST', '/api/login', {'username': 'admin', 'password': 'wrong-password'})[0], 401)
        st, out, hdr = c.call('POST', '/api/login', {'username': 'admin', 'password': 'Correct-Horse-42'})
        self.assertEqual(st, 200)
        self.assertIn('HttpOnly', hdr.get('Set-Cookie', ''))
        self.assertIn('SameSite=Strict', hdr.get('Set-Cookie', ''))
        self.assertEqual(c.call('GET', '/api/me')[1]['user']['role'], 'admin')

    def test_03_lockout_after_failures(self):
        c = Client(self.base)
        for _ in range(5):
            c.call('POST', '/api/login', {'username': 'nobody', 'password': 'bad-password-1'})
        self.assertEqual(c.call('POST', '/api/login', {'username': 'nobody', 'password': 'bad-password-1'})[0], 429)

    def test_04_weak_password_and_csrf(self):
        st, out, _ = self.admin.call('POST', '/api/users', {'username': 'weak', 'name': 'W', 'role': 'viewer', 'password': 'password'})
        self.assertEqual(st, 400)
        st, out, _ = self.admin.call('POST', '/api/reports', {'from': 1, 'to': 2, 'counts': {'dengue': 1}}, csrf=False)
        self.assertEqual(st, 403)

    def test_05_roles_and_approvals(self):
        viewer, approver = self.user('viewer1', 'viewer'), self.user('approver1', 'approver')
        body = {'hospital': 'kem', 'action_id': 'surgebeds', 'title': 'Open surge beds', 'at_ms': time.time() * 1000}
        self.assertEqual(viewer.call('POST', '/api/approvals', body)[0], 403)
        st, out, _ = approver.call('POST', '/api/approvals', body)
        self.assertEqual(st, 200, out)
        self.assertEqual(out['approval']['by_name'], 'Approver1')
        self.assertEqual(approver.call('POST', '/api/approvals', body)[0], 409)
        sync = viewer.call('GET', '/api/sync/kem')[1]
        self.assertEqual([a['action_id'] for a in sync['approvals']], ['surgebeds'])
        self.assertEqual(approver.call('DELETE', f"/api/approvals/{out['approval']['id']}")[0], 200)
        self.assertEqual(viewer.call('GET', '/api/sync/kem')[1]['approvals'], [])

    def test_06_audit_chain_detects_tampering(self):
        st, out, _ = self.admin.call('GET', '/api/audit')
        self.assertTrue(out['verify']['ok'])
        self.assertGreater(out['verify']['entries'], 3)
        db = self.srv.db
        row = db.one('SELECT id, detail FROM audit ORDER BY id LIMIT 1 OFFSET 1')
        db.x('UPDATE audit SET detail=? WHERE id=?', ('{"edited": true}', row['id']))
        self.assertFalse(core.verify_audit(db)['ok'])
        db.x('UPDATE audit SET detail=? WHERE id=?', (row['detail'], row['id']))
        self.assertTrue(core.verify_audit(db)['ok'])

    def test_07_census_privacy_and_round_trip(self):
        staff = self.user('staff1', 'staff')
        t0 = time.time() * 1000
        st, out, _ = staff.call('PUT', '/api/census/kem', {'rows': [{'t': t0, 'timestamp': 'x', 'patient_name': 'A', 'med_occupied': 3}]})
        self.assertEqual(st, 400)
        self.assertIn('identifier', out['error'])
        st, out, _ = staff.call('PUT', '/api/census/kem', {'rows': [{'t': t0, 'timestamp': 'x', 'med_occupied': 'many'}]})
        self.assertEqual(st, 400)
        rows = [{'t': t0 + i * 3600e3, 'timestamp': f'r{i}', 'med_occupied': 300 + i, 'unknown_col': 9} for i in range(48)]
        st, out, _ = staff.call('PUT', '/api/census/kem', {'rows': rows, 'head': ['timestamp', 'med_occupied']})
        self.assertEqual(st, 200, out)
        self.assertEqual(out['encrypted'], core.encryption_available())
        st, got, _ = staff.call('GET', '/api/census/kem')
        self.assertEqual(len(got['rows']), 48)
        self.assertNotIn('unknown_col', got['rows'][0])
        raw = bytes(self.srv.db.one('SELECT blob FROM census WHERE hospital=?', ('kem',))['blob'])
        if core.encryption_available():
            self.assertNotIn(b'med_occupied', raw)

    def test_08_alert_dedupe_and_sending(self):
        smtp, tw = FakeSMTP(), FakeTwilio()
        threading.Thread(target=smtp.serve_forever, daemon=True).start()
        threading.Thread(target=tw.serve_forever, daemon=True).start()
        os.environ.update({'SMTP_HOST': '127.0.0.1', 'SMTP_PORT': str(smtp.server_address[1]), 'SMTP_SECURITY': 'none', 'SMTP_FROM': 'surgewatch@hospital.example',
                           'TWILIO_ACCOUNT_SID': 'AC1', 'TWILIO_AUTH_TOKEN': 'tok', 'TWILIO_SMS_FROM': '+15005550006', 'TWILIO_WHATSAPP_FROM': '+14155238886',
                           'TWILIO_API_BASE': f'http://127.0.0.1:{tw.server_address[1]}'})
        try:
            staff, approver = self.user('staff2', 'staff'), self.user('approver2', 'approver')
            alert = {'unit': 'LAB', 'sev': 'critical', 'epi': False, 'created_ms': time.time() * 1000, 'start_ms': time.time() * 1000 + 3600e3,
                     'subject': '[Surge Watch] Critical: Diagnostic laboratory', 'body': 'Lab expected to reach 144%.', 'tr': {'hi': {'subject': 'गंभीर: प्रयोगशाला', 'body': 'हिंदी पाठ'}}}
            st, a1, _ = staff.call('POST', '/api/alerts', {'hospital': 'kem', 'alert': alert})
            self.assertEqual(st, 200, a1)
            st, a2, _ = staff.call('POST', '/api/alerts', {'hospital': 'kem', 'alert': alert})
            self.assertTrue(a2['existing'])
            self.assertEqual(a1['id'], a2['id'])
            self.assertEqual(staff.call('POST', f"/api/alerts/{a1['id']}/send", {'channels': ['email']})[0], 403)
            self.admin.call('POST', '/api/people', {'role': 'Lab on-call', 'email': 'oncall@hospital.example', 'phone': '+919820012345', 'units': 'LAB', 'min_sev': 'warning'})
            st, res, _ = approver.call('POST', f"/api/alerts/{a1['id']}/send", {'channels': ['email', 'sms', 'whatsapp'], 'lang': 'hi'})
            self.assertEqual(st, 200, res)
            self.assertGreaterEqual(res['sent'], 3)
            time.sleep(0.3)
            to_oncall = [m for m in smtp.messages if any('oncall@hospital.example' in r for r in m['rcpt'])]
            self.assertTrue(to_oncall)
            self.assertIn('English version', to_oncall[0]['data'])
            self.assertTrue(any('whatsapp%3A%2B919820012345' in p['body'] for p in tw.posts))
            self.assertTrue(any('To=%2B919820012345' in p['body'] for p in tw.posts))
            sync = approver.call('GET', '/api/sync/kem')[1]
            self.assertEqual(next(a for a in sync['alerts'] if a['id'] == a1['id'])['status'], 'sent')
            self.assertTrue(any(m['status'] == 'sent' for m in sync['messages']))
        finally:
            for k in ('SMTP_HOST', 'TWILIO_ACCOUNT_SID'):
                os.environ.pop(k, None)
            smtp.shutdown()
            tw.shutdown()

    def test_09_not_configured_goes_to_outbox(self):
        approver = self.user('approver3', 'approver')
        alert = {'unit': 'XRAY', 'sev': 'critical', 'created_ms': time.time() * 1000, 'start_ms': time.time() * 1000, 'subject': 'x', 'body': 'y'}
        aid = self.admin.call('POST', '/api/alerts', {'hospital': 'kem', 'alert': alert})[1]['id']
        res = approver.call('POST', f'/api/alerts/{aid}/send', {'channels': ['email']})[1]
        self.assertEqual(res['sent'], 0)
        self.assertTrue(all(r['status'] == 'not_configured' for r in res['results']))

    def test_10_collector_queue(self):
        now = time.time()
        pub = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime(now - 86400))
        old = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime(now - 200 * 86400))
        feed = f'''<rss><channel>
          <item><title>Mumbai H1N1 cases surge 511 per cent to 507; malaria rises 39 pc to 8,723: BMC data</title><link>https://example.org/a</link><pubDate>{pub}</pubDate><source>FPJ</source></item>
          <item><title>BMC finds 11,227 dengue breeding sites in Mumbai</title><link>https://example.org/b</link><pubDate>{pub}</pubDate></item>
          <item><title>Mumbai dengue cases at 900</title><link>https://example.org/old</link><pubDate>{old}</pubDate></item>
          <item><title>Stock market rally</title><link>https://example.org/c</link><pubDate>{pub}</pubDate></item>
        </channel></rss>'''.encode()
        out = collector.run_once(self.srv.db, fetch=lambda url: feed, now=now)
        self.assertEqual(out['new'], 2)
        approver = self.user('approver4', 'approver')
        cands = approver.call('GET', '/api/collector')[1]['candidates']
        a = next(c for c in cands if c['url'] == 'https://example.org/a')
        self.assertEqual(a['counts'], {'malaria': 8723, 'flu': 507})
        self.assertEqual(next(c for c in cands if c['url'] == 'https://example.org/b')['counts'], {})
        st, res, _ = approver.call('POST', f"/api/collector/{a['id']}/accept", {'from': now * 1000 - 30 * 864e5, 'to': now * 1000, 'counts': a['counts']})
        self.assertEqual(st, 200, res)
        self.assertIn('example.org/a', res['report']['src'])

    def test_11_retention_trims_old_census(self):
        old = (time.time() - 400 * 86400) * 1000
        rows = [{'t': old, 'timestamp': 'old', 'med_occupied': 1}, {'t': time.time() * 1000, 'timestamp': 'new', 'med_occupied': 2}]
        blob, enc = core.seal({'rows': rows})
        self.srv.db.x('INSERT OR REPLACE INTO census (hospital, blob, encrypted, rows, first_ms, last_ms, rev, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)',
                      ('nair', blob, int(enc), 2, old, rows[1]['t'], 1, 't', time.time()))
        self.assertEqual(core.apply_retention(self.srv.db), 1)
        c = self.srv.db.one('SELECT * FROM census WHERE hospital=?', ('nair',))
        self.assertEqual(c['rows'], 1)

    def test_12_setup_conflicts(self):
        staff = self.user('staff3', 'staff')
        self.assertEqual(staff.call('PUT', '/api/setup/sion', {'rev': 0, 'data': {'changed': ['ICU']}})[1]['rev'], 1)
        self.assertEqual(staff.call('PUT', '/api/setup/sion', {'rev': 0, 'data': {'changed': []}})[0], 409)

    @unittest.skipUnless(core.encryption_available(), 'cryptography package not installed')
    def test_14_encryption_at_rest(self):
        self.assertTrue(Client(self.base).call('GET', '/api/health')[1]['encryption'])
        data = {'rows': [{'t': 1.0, 'timestamp': 'x', 'icu_occupied': 87}]}
        blob, enc = core.seal(data)
        self.assertTrue(enc)
        self.assertTrue(blob.startswith(b'SW1'))
        self.assertNotIn(b'icu_occupied', blob)
        self.assertEqual(core.unseal(blob, True), data)
        self.assertNotEqual(core.seal(data)[0], blob)  # fresh nonce every time
        self.assertTrue((Path(TMP) / 'data.key').exists())
        tampered = blob[:-1] + bytes([blob[-1] ^ 1])
        with self.assertRaises(Exception):
            core.unseal(tampered, True)
        import base64, secrets
        os.environ['SURGEWATCH_DATA_KEY'] = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
        try:
            with self.assertRaises(Exception):
                core.unseal(blob, True)  # a different key cannot read it
        finally:
            os.environ.pop('SURGEWATCH_DATA_KEY')
        old = json.dumps(data).encode()  # data stored before encryption was switched on still loads
        self.assertEqual(core.unseal(old, False), data)
        db = self.srv.db  # and is encrypted in place by encrypt_existing()
        db.x('INSERT OR REPLACE INTO census (hospital, blob, encrypted, rows, first_ms, last_ms, rev, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)',
             ('cooper', old, 0, 1, 1.0, 1.0, 1, 't', time.time()))
        self.assertGreaterEqual(core.encrypt_existing(db), 1)
        row = db.one('SELECT blob, encrypted FROM census WHERE hospital=?', ('cooper',))
        self.assertEqual(row['encrypted'], 1)
        self.assertNotIn(b'icu_occupied', bytes(row['blob']))
        self.assertEqual(core.unseal(row['blob'], True), data)

    def test_13_extract_ignores_percentages_and_years(self):
        self.assertEqual(collector.extract('Dengue cases up 27.8 per cent in 2026'), {})
        self.assertEqual(collector.extract('Mumbai records 938 dengue cases and 157 leptospirosis cases'), {'dengue': 938, 'lepto': 157})


if __name__ == '__main__':
    unittest.main(verbosity=2)
