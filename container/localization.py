"""Presentation-only localization, shared with the Worker through messages.json."""
import contextvars
import functools
import json
import re
from pathlib import Path

_language = contextvars.ContextVar('bot_language', default='fa')
_catalog_path = Path(__file__).with_name('messages.json')
if not _catalog_path.exists():
    _catalog_path = Path(__file__).parents[1] / 'locales' / 'messages.json'
_catalog = json.loads(_catalog_path.read_text(encoding='utf-8'))
_rows = sorted(_catalog, key=lambda row: len(row['fa']), reverse=True)
_by_source = {row['fa']: row for row in _rows}
_terms = {'صدای ویدیوی', 'هایلایت', 'استوری', 'پست', 'فایل', 'روز', 'ساعت', 'دقیقه', 'ثانیه', ' و '}
_pattern = re.compile('|'.join(re.escape(row['fa']) for row in _rows if '{0}' not in row['fa'] and row['fa'] not in _terms))
_templates = [(row, re.compile('^' + re.sub(r'\\\{\d+\\\}', '(.+?)', re.escape(row['fa'])) + '$')) for row in _rows if '{0}' in row['fa']]
TRANSLATED_ERRORS = {row[lang] for row in _rows if row['fa'].startswith('⚠️') for lang in ('en', 'ru')}


def localized_job(function):
    @functools.wraps(function)
    def wrapped(first, *args, **kwargs):
        payload = first if isinstance(first, dict) else getattr(first, 'payload', {})
        language = payload.get('language', 'fa')
        marker = _language.set(language if language in ('en', 'ru') else 'fa')
        try:
            return function(first, *args, **kwargs)
        finally:
            _language.reset(marker)
    return wrapped


def translate(text, language):
    if language not in ('en', 'ru'):
        return text
    lines = []
    for line in text.split('\n'):
        for row, pattern in _templates:
            match = pattern.fullmatch(line)
            if match:
                def value(m):
                    raw = match[int(m[1]) + 1]
                    return _by_source.get(raw, {}).get(language, raw)
                line = re.sub(r'\{(\d+)\}', value, row[language])
                break
        if re.match(r'^(?:زمان باقی‌مانده:|مدت محدودیت:|[۰-۹٠-٩0-9]+\s+(?:روز|ساعت|دقیقه|ثانیه))', line):
            line = line.translate(str.maketrans('۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789'))
            line = re.sub('روز|ساعت|دقیقه|ثانیه| و ', lambda m: _by_source[m[0]][language], line)
        lines.append(line)
    return _pattern.sub(lambda match: _by_source[match[0]][language], '\n'.join(lines))


def utf16len(text):
    return len(text.encode('utf-16-le')) // 2


def localize_payload(payload, language=None):
    language = language or _language.get()
    if language == 'fa':
        return payload
    result = dict(payload)
    for field, entity_field in (('text', 'entities'), ('caption', 'caption_entities')):
        source = payload.get(field)
        if not isinstance(source, str):
            continue
        text = translate(source, language)
        result[field] = text
        if text == source:
            continue
        entities = payload.get(entity_field, [])
        if isinstance(entities, str):
            entities = json.loads(entities)
        rebuilt = []
        for entity in entities:
            if entity['type'] == 'custom_emoji':
                continue
            raw = source.encode('utf-16-le')
            phrase = translate(raw[entity['offset'] * 2:(entity['offset'] + entity['length']) * 2].decode('utf-16-le'), language)
            offset = text.find(phrase)
            if offset >= 0:
                rebuilt.append({**entity, 'offset': utf16len(text[:offset]), 'length': utf16len(phrase)})
        if not entities and '\n' in text:
            rebuilt.append({'type': 'bold', 'offset': 0, 'length': utf16len(text.split('\n')[0])})
        result[entity_field] = rebuilt
    markup = payload.get('reply_markup')
    if markup:
        serialized = isinstance(markup, str)
        markup = json.loads(markup) if serialized else markup
        markup = dict(markup)
        for key in ('inline_keyboard', 'keyboard'):
            if key in markup:
                markup[key] = [[{**button, 'text': translate(button['text'], language)} for button in row] for row in markup[key]]
        result['reply_markup'] = json.dumps(markup, ensure_ascii=False) if serialized else markup
    if isinstance(payload.get('media'), list):
        result['media'] = [localize_payload(item, language) for item in payload['media']]
    return result
