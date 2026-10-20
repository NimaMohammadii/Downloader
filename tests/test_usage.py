import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app


class UsageTests(unittest.TestCase):
    def meter(self):
        self.clock, self.cpu, self.network = [0.0], [0.0], [(0, 0)]
        self.addCleanup(patch.stopall)
        patch('youtube_app.time.monotonic', side_effect=lambda: self.clock[0]).start()
        patch('youtube_app.time.time', return_value=1_800_000_000).start()
        patch.dict(os.environ, {'ADMIN_USAGE_URL': 'https://downloader.vexaagent.workers.dev/container-usage/0',
                                'ADMIN_USAGE_TOKEN': 'a' * 64}).start()
        patch.object(app.UsageMeter, 'counters', side_effect=lambda: (self.cpu[0], self.network[0])).start()
        meter = app.UsageMeter()
        meter.report = lambda: None
        return meter

    def advance(self, seconds, cpu, rx, tx):
        self.clock[0] += seconds
        self.cpu[0] += cpu
        self.network[0] = (self.network[0][0] + rx, self.network[0][1] + tx)

    def test_concurrent_jobs_share_one_global_measurement_without_double_counting(self):
        meter = self.meter()
        with meter.scope(42):
            self.advance(10, 2, 1000, 100)
            with meter.scope(43):
                self.advance(20, 8, 4000, 800)
            self.advance(10, 2, 1000, 100)
        self.advance(60, 1, 100, 50)  # Idle overhead belongs only to global usage.
        meter.sample()
        totals = lambda user, field: sum(v[field] for v in meter.samples.values() if v['userId'] == user)
        self.assertEqual(totals(0, 'runtimeMs'), 100000)
        self.assertEqual(totals(42, 'runtimeMs'), 30000)
        self.assertEqual(totals(43, 'runtimeMs'), 10000)
        self.assertEqual(totals(0, 'cpuSeconds'), 13)
        self.assertEqual(totals(42, 'cpuSeconds'), 8)
        self.assertEqual(totals(43, 'cpuSeconds'), 4)
        self.assertEqual(totals(0, 'egressBytes'), 1050)
        self.assertEqual(totals(42, 'egressBytes'), 600)
        self.assertEqual(totals(43, 'egressBytes'), 400)
        self.assertEqual(app.USAGE_USER.get(), 0)

    def test_unknown_users_and_missing_counters_are_not_fabricated(self):
        meter = self.meter()
        self.cpu[0], self.network[0] = None, None
        with meter.scope(None):
            self.clock[0] += 10
        rows = list(meter.samples.values())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['userId'], 0)
        self.assertIsNone(rows[0]['cpuSeconds'])
        self.assertIsNone(rows[0]['ingressBytes'])

    def test_exception_releases_attribution_and_does_not_create_a_delivery(self):
        meter = self.meter()
        with self.assertRaisesRegex(RuntimeError, 'download failed'):
            with meter.scope(42):
                self.advance(10, 1, 1000, 100)
                raise RuntimeError('download failed')
        self.assertEqual(meter.active, {})
        self.assertEqual(app.USAGE_USER.get(), 0)
        self.assertEqual(meter.deliveries, {})
        self.assertEqual(sum(v['cpuSeconds'] for v in meter.samples.values() if v['userId'] == 0), 1)

    def test_report_failure_keeps_same_keys_for_retry_and_ack_is_idempotent(self):
        meter = self.meter()
        with meter.scope(42):
            self.advance(10, 2, 1000, 100)
            meter.delivery('123:secret', -5, {'message_id': 77}, 1234)
        keys = set(meter.samples)
        with patch.object(app.requests, 'post', side_effect=OSError('stats unavailable')):
            meter.flush()
        self.assertEqual(set(meter.samples), keys)
        self.assertEqual(meter.deliveries['tg:123:-5:77']['bytes'], 1234)
        with patch.object(app.requests, 'post') as post:
            post.return_value.ok = True
            meter.flush()
            self.assertEqual(post.call_args.kwargs['json']['deliveries'][0]['userId'], 42)
            self.assertEqual(meter.samples, {})
            self.assertEqual(meter.deliveries, {})

    def test_complete_file_sender_records_bytes_only_after_confirmed_upload(self):
        meter = self.meter()
        with tempfile.NamedTemporaryFile() as source, patch.object(app, 'USAGE', meter):
            source.write(b'x' * 1234)
            source.flush()
            async def success(*args):
                return {'message_id': 123, 'file_id': 'file'}
            with meter.scope(42), patch.object(app.TELEGRAM_UPLOADER, 'upload', side_effect=success):
                result = asyncio.run(app.upload_complete_file('123:secret', 'sendVideo', {'chat_id': '-5'}, ('x', source, 'video/mp4')))
            self.assertEqual(result['message_id'], 123)
            self.assertEqual(meter.deliveries['tg:123:-5:123']['bytes'], 1234)
            async def failure(*args):
                raise RuntimeError('upload failed')
            with meter.scope(43), patch.object(app.TELEGRAM_UPLOADER, 'upload', side_effect=failure):
                with self.assertRaisesRegex(RuntimeError, 'upload failed'):
                    asyncio.run(app.upload_complete_file('123:secret', 'sendVideo', {'chat_id': '-5'}, ('x', source, 'video/mp4')))
            self.assertEqual(len(meter.deliveries), 1)

    def test_idle_exit_is_cancelled_if_new_work_arrives_during_final_stats_flush(self):
        meter = self.meter()
        exits = []
        guard = app.IdleExit(300, lambda: False, exits.append)
        try:
            guard.refresh()
            with patch.object(app, 'USAGE', meter), patch.object(meter, 'flush', side_effect=guard.begin):
                guard._expire(guard.generation)
            self.assertEqual(exits, [])
            self.assertEqual(guard.active, 1)
        finally:
            guard._cancel()

    def test_admin_snapshot_does_not_extend_python_idle_timer(self):
        meter = self.meter()
        guard = app.IdleExit(300, lambda: False, lambda code: None)
        handler = object.__new__(app.Handler)
        handler.path = '/admin-usage'
        responses = []
        handler._send_json = lambda status, payload: responses.append((status, payload))
        try:
            guard.refresh()
            generation = guard.generation
            self.advance(10, 1, 100, 50)
            with patch.object(app, 'USAGE', meter), patch.object(app, 'SERVER_IDLE', guard):
                handler.do_GET()
            self.assertEqual(guard.generation, generation)
            self.assertEqual(guard.active, 0)
            self.assertEqual(responses[0][0], 200)
            self.assertEqual(responses[0][1]['samples'][0]['runtimeMs'], 10000)
        finally:
            guard._cancel()


if __name__ == '__main__':
    unittest.main()
