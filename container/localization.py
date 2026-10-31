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
_rows = sorted(_catalog, key=lambda row: len(row['fa'].encode('utf-16-le')), reverse=True)
_by_source = {row['fa']: row for row in _rows if '{0}' not in row['fa']}
_terms = {'صدای ویدیوی', 'هایلایت', 'استوری', 'پست', 'فایل', 'روز', 'ساعت', 'دقیقه', 'ثانیه', ' و '}
# Short labels and native language names are exact matches, not replacements in titles.
_pattern = re.compile('|'.join(re.escape(row['fa']) for row in _rows
    if '{0}' not in row['fa'] and row['fa'] not in _terms and re.search(r'[\u0600-\u06ff]', row['fa'])
    and (len(row['fa'].encode('utf-16-le')) // 2 >= 12
         or any(flag in row['fa'] for flag in ('🇮🇷', '🇬🇧', '🇷🇺')))))
_templates = [(row, [int(i) for i in re.findall(r'\{(\d+)\}', row['fa'])],
    re.compile('^' + ''.join('(.*?)' if re.fullmatch(r'\{\d+\}', part) else re.escape(part)
                            for part in re.split(r'(\{\d+\})', row['fa'])) + '$'))
    for row in sorted((r for r in _catalog if '{0}' in r['fa']),
                      key=lambda r: len(re.sub(r'\{\d+\}', '', r['fa']).encode('utf-16-le')), reverse=True)]
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


def translate(text, language, depth=0):
    if language not in ('en', 'ru') or depth > 5:
        return text
    if text in _by_source:
        return _by_source[text][language]
    lines = []
    for line in text.split('\n'):
        if line in _by_source:
            lines.append(_by_source[line][language])
            continue
        if re.match(r'^(?:(?:زمان باقی‌مانده:|مدت محدودیت:)\s*)?[۰-۹٠-٩0-9.]+\s+(?:روز|ساعت|دقیقه|ثانیه)(?: و [۰-۹٠-٩0-9.]+\s+(?:روز|ساعت|دقیقه|ثانیه))*$', line):
            line = line.translate(str.maketrans('۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789'))
            line = re.sub('روز|ساعت|دقیقه|ثانیه| و ', lambda m: _by_source[m[0]][language], line)
        else:
            for row, indices, pattern in _templates:
                match = pattern.fullmatch(line)
                if match:
                    values = dict(zip(indices, match.groups()))
                    def value(m):
                        raw = values[int(m[1])]
                        return raw if int(m[1]) in row.get('preserve', []) else translate(raw, language, depth + 1)
                    line = re.sub(r'\{(\d+)\}', value, row[language])
                    lines.append(line)
                    break
            else:
                lines.append(_pattern.sub(lambda match: _by_source[match[0]][language], line))
            continue
        lines.append(_pattern.sub(lambda match: _by_source[match[0]][language], line))
    return '\n'.join(lines)


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
        # Download captions begin with the original media title.
        title_length = (source.find('\n') if '\n' in source else len(source)) if field == 'caption' else 0
        text = source[:title_length] + translate(source[title_length:], language)
        result[field] = text
        if text == source:
            continue
        if payload.get('parse_mode'):
            continue
        entities = payload.get(entity_field, [])
        serialized = isinstance(entities, str)
        if isinstance(entities, str):
            entities = json.loads(entities)
        rebuilt = []
        for entity in entities:
            raw = source.encode('utf-16-le')
            original = raw[entity['offset'] * 2:(entity['offset'] + entity['length']) * 2].decode('utf-16-le')
            phrase = original if entity['offset'] < utf16len(source[:title_length]) else translate(original, language)
            if not phrase:
                continue
            occurrence = raw[:entity['offset'] * 2].decode('utf-16-le').count(original) if original else 0
            offset = -1
            for _ in range(occurrence + 1):
                offset = text.find(phrase, offset + 1)
                if offset < 0:
                    break
            if offset >= 0:
                rebuilt.append({**entity, 'offset': utf16len(text[:offset]), 'length': utf16len(phrase)})
        if not entities and '\n' in text:
            rebuilt.append({'type': 'bold', 'offset': 0, 'length': utf16len(text.split('\n')[0])})
        result[entity_field] = json.dumps(rebuilt, ensure_ascii=False) if serialized else rebuilt
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
