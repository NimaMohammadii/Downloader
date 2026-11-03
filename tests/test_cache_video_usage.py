import sys
from pathlib import Path
import unittest
from unittest.mock import patch, Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'container'))
import youtube_app as app

class CacheVideoUsageTests(unittest.TestCase):
    def test_confirmed_video_carries_platform_and_history_but_audio_does_not(self):
        payload={'botToken':'fixture','chatId':42,'requestMessageId':7,
                 'cacheSource':'Pinterest','cacheHistoryKey':'igdl-42-7-42'}
        for method in ['sendVideo','sendAudio']:
            with patch.object(app,'file_cache',return_value={'method':method,'fileId':'fixture','data':{}}), \
                 patch.object(app,'telegram_call',return_value={'message_id':10}),patch.object(app.USAGE,'delivery') as delivery:
                self.assertTrue(app.reuse_cached_file(payload,'fixture'))
                self.assertEqual(delivery.call_args.kwargs['cache_video'],
                    {'source':'Pinterest','downloadKey':'igdl-42-7-42'} if method=='sendVideo' else None)
        with patch.object(app,'file_cache',return_value={'method':'sendVideo','fileId':'fixture','data':{}}), \
             patch.object(app,'telegram_call',side_effect=TimeoutError()),patch.object(app.USAGE,'delivery') as delivery:
            with self.assertRaises(app.UserVisibleError):app.reuse_cached_file(payload,'fixture')
            delivery.assert_not_called()

    def test_meter_keeps_the_confirmed_message_idempotent_and_preserves_cache_details(self):
        meter=app.UsageMeter();meter.enabled=True;meter.report=Mock()
        token=app.USAGE_USER.set(42)
        try:
            details={'source':'YouTube','downloadKey':'youtube:42:7:42'}
            for _ in range(2):meter.delivery('fixture',42,{'message_id':10},100,cached=True,cache_video=details)
            self.assertEqual(len(meter.deliveries),1)
            self.assertEqual(next(iter(meter.deliveries.values()))['cachedVideo'],details)
            meter.delivery('fixture',42,{'message_id':11},100,cached=False,cache_video=details)
            self.assertNotIn('cachedVideo',meter.deliveries['tg:fixture:42:11'])
        finally:app.USAGE_USER.reset(token)

if __name__=='__main__':unittest.main()
