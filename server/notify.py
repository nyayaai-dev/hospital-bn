"""Sending approved alerts by email (SMTP), SMS and WhatsApp (Twilio REST API).

Nothing is sent unless an approver presses Send. Channels without configuration are reported as
"not configured" and the message is kept in the outbox instead.

Environment variables:
  SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_SECURITY (starttls | ssl | none)
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM, TWILIO_WHATSAPP_FROM, TWILIO_API_BASE (for testing)
"""
import base64
import json
import re
import smtplib
import ssl
import urllib.parse
import urllib.request
from email.message import EmailMessage

from core import env

EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
PHONE_RE = re.compile(r'^\+[1-9]\d{7,14}$')  # E.164, e.g. +919820012345


def channels():
    tw = env('TWILIO_ACCOUNT_SID') and env('TWILIO_AUTH_TOKEN')
    return {'email': bool(env('SMTP_HOST') and env('SMTP_FROM')), 'sms': bool(tw and env('TWILIO_SMS_FROM')), 'whatsapp': bool(tw and env('TWILIO_WHATSAPP_FROM'))}


def send_email(to, subject, body):
    msg = EmailMessage()
    msg['From'] = env('SMTP_FROM')
    msg['To'] = to
    msg['Subject'] = subject
    msg.set_content(body)
    host, port, sec = env('SMTP_HOST'), int(env('SMTP_PORT', '587')), env('SMTP_SECURITY', 'starttls').lower()
    ctx = ssl.create_default_context()
    if sec == 'ssl':
        server = smtplib.SMTP_SSL(host, port, timeout=20, context=ctx)
    else:
        server = smtplib.SMTP(host, port, timeout=20)
    with server as s:
        if sec == 'starttls':
            s.starttls(context=ctx)
        if env('SMTP_USER'):
            s.login(env('SMTP_USER'), env('SMTP_PASSWORD', ''))
        s.send_message(msg)


def send_twilio(to, body, whatsapp=False):
    sid, token = env('TWILIO_ACCOUNT_SID'), env('TWILIO_AUTH_TOKEN')
    base = env('TWILIO_API_BASE', 'https://api.twilio.com').rstrip('/')
    sender = env('TWILIO_WHATSAPP_FROM') if whatsapp else env('TWILIO_SMS_FROM')
    data = urllib.parse.urlencode({'To': ('whatsapp:' if whatsapp else '') + to, 'From': ('whatsapp:' if whatsapp and not sender.startswith('whatsapp:') else '') + sender,
                                   'Body': body[:1500]}).encode()
    req = urllib.request.Request(f'{base}/2010-04-01/Accounts/{urllib.parse.quote(sid)}/Messages.json', data=data, method='POST')
    req.add_header('Authorization', 'Basic ' + base64.b64encode(f'{sid}:{token}'.encode()).decode())
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.loads(r.read() or b'{}')
    return out.get('sid')


def short_text(subject):
    """SMS/WhatsApp carry a short version; the full text stays in Surge Watch and the email."""
    s = subject.replace('[Surge Watch] ', '')
    return f'Surge Watch alert: {s}. Open Surge Watch for details and actions.'[:320]


def deliver(channel, recipient, subject, body):
    """Returns (status, error). status is 'sent', 'failed', 'invalid' or 'not_configured'."""
    if not channels().get(channel):
        return 'not_configured', f'{channel} is not configured on this server'
    try:
        if channel == 'email':
            if not EMAIL_RE.match(recipient or ''):
                return 'invalid', 'not a valid email address'
            send_email(recipient, subject, body)
        else:
            if not PHONE_RE.match(recipient or ''):
                return 'invalid', 'phone must be in international format, e.g. +919820012345'
            send_twilio(recipient, short_text(subject), whatsapp=(channel == 'whatsapp'))
        return 'sent', None
    except Exception as e:  # network, auth or provider errors are reported, not raised
        return 'failed', f'{type(e).__name__}: {e}'[:300]
