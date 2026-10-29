"""Accounting only: never retries a paid request or changes its result."""
import json
import secrets
import re
import time
from pathlib import Path

import youtube_app as app


def _publish(value):
    try:
        app.USAGE.subtitle_charge(value)
    except Exception:
        print('subtitle accounting unavailable', flush=True)


def replay_charges(directory: Path):
    # Recover original attribution after a process restart/cache reuse. The
    # stable event key makes re-delivery harmless; never charge the new reader.
    for path in directory.glob('*.usage.json'):
        try:
            value = json.loads(path.read_text(encoding='utf-8'))
            if isinstance(value, dict):
                _publish(value)
        except Exception:
            print('subtitle accounting receipt unavailable', flush=True)


class SubtitleCharge:
    def __init__(self, receipt: Path, billing, provider: str, model: str):
        self.path = receipt.with_suffix('.usage.json')
        self.value = {**billing, 'key': 'sub:' + secrets.token_hex(16),
                      'at': int(time.time() * 1000), 'provider': provider,
                      'model': model, 'state': 'pending'}
        self._save()

    def _save(self):
        try:
            temp = self.path.with_suffix('.tmp')
            temp.write_text(json.dumps(self.value), encoding='utf-8')
            temp.replace(self.path)
        except Exception:
            print('subtitle accounting receipt unavailable', flush=True)
        _publish(dict(self.value))

    def finish(self, state, response=None, request_id=None):
        try:
            self.value['state'] = state
            if isinstance(request_id, str) and re.fullmatch(r'[a-zA-Z0-9_.:-]{1,180}', request_id):
                self.value['requestId'] = request_id
            if response and self.value['provider'] == 'openai':
                usage = response.get('usage') or {}
                details = usage.get('input_tokens_details') or {}
                for target, source in [('inputTokens', 'input_tokens'), ('outputTokens', 'output_tokens')]:
                    if type(usage.get(source)) is int and 0 <= usage[source] <= 2000000:
                        self.value[target] = usage[source]
                for target, source in [('cachedInputTokens', 'cached_tokens'), ('cacheWriteTokens', 'cache_write_tokens')]:
                    if type(details.get(source)) is int and 0 <= details[source] <= 2000000:
                        self.value[target] = details[source]
                if isinstance(response.get('service_tier'), str) and re.fullmatch(r'[a-z_]{1,30}', response['service_tier']):
                    self.value['serviceTier'] = response['service_tier']
                if isinstance(response.get('model'), str) and re.fullmatch(r'[a-zA-Z0-9_.:-]{1,100}', response['model']):
                    self.value['model'] = response['model']
            self._save()
        except Exception:
            # The pending record remains explicitly unknown if instrumentation
            # fails. Caption preparation must still return its original result.
            print('subtitle accounting unavailable', flush=True)


def start_charge(receipt, billing, url, kwargs):
    if not billing:
        return None
    try:
        provider = 'elevenlabs' if url == 'https://api.elevenlabs.io/v1/speech-to-text' else 'openai'
        model = (kwargs.get('data') or {}).get('model_id') if provider == 'elevenlabs' else (kwargs.get('json') or {}).get('model')
        return SubtitleCharge(receipt, billing, provider, model)
    except Exception:
        print('subtitle accounting unavailable', flush=True)
        return None
