import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_pipeline as pipeline


class CatalogTests(unittest.TestCase):
    def test_normal_page_and_deno_are_used_for_quality_catalog(self):
        # ai-configa inspects the normal page with Deno; skipping webpage/configs
        # without matching visitor data removes session setup used by extraction.
        with patch.object(pipeline, '_run', return_value=subprocess.CompletedProcess([], 0, '{"id":"video"}', '')) as run:
            pipeline._fetch_metadata_for_client('https://www.youtube.com/watch?v=video', 'web_embedded')
        command = run.call_args.args[0]
        self.assertIn('--ignore-config', command)
        self.assertEqual(command[command.index('--js-runtimes') + 1], 'deno')
        self.assertIn('youtube:player_client=web_embedded', command)
        self.assertFalse(any('player_skip' in arg or 'youtubepot' in arg for arg in command))
        self.assertNotIn('--max-filesize', command)

    def test_bot_check_does_not_prevent_trying_configa_second_client(self):
        metadata = {'id': 'video', 'title': 'test'}
        first = pipeline.ClientAttemptError('web_embedded', 'botcheck', 'verification required')
        with patch.object(pipeline, '_fetch_metadata_for_client', side_effect=[first, metadata]) as fetch, \
             patch.object(pipeline.app, 'validate_video_metadata'), \
             patch.object(pipeline, 'available_qualities', return_value=[720]), \
             patch.object(pipeline, '_save_session') as save:
            result = pipeline.inspect_video('https://www.youtube.com/watch?v=video')
        self.assertTrue(result['ok'])
        self.assertEqual(result['qualities'], [720])
        self.assertEqual([call.args[1] for call in fetch.call_args_list], ['web_embedded', 'android_vr'])
        save.assert_called_once_with(metadata, 'android_vr')

    def test_private_video_is_not_retried_as_bot_check(self):
        error = pipeline.ClientAttemptError('web_embedded', 'private', 'Private video')
        with patch.object(pipeline, '_fetch_metadata_for_client', side_effect=error) as fetch:
            result = pipeline.inspect_video('url')
        self.assertFalse(result['ok'])
        self.assertEqual(fetch.call_count, 1)

    def test_webpage_warning_does_not_turn_bot_check_into_age_restriction(self):
        category, _ = pipeline._classify_ytdlp_error("Downloading webpage\nSign in to confirm you're not a bot")
        self.assertEqual(category, 'botcheck')
        category, _ = pipeline._classify_ytdlp_error('Sign in to confirm your age. Age-restricted video')
        self.assertEqual(category, 'age')

    def test_download_reuses_catalog_client(self):
        with patch.object(pipeline, 'available_qualities', return_value=[720]), \
             patch.object(pipeline, '_load_session_client', return_value='android_vr'), \
             patch.object(pipeline, '_source_ratio', return_value=None), \
             patch.object(pipeline, '_download_video_with_client', return_value=Path('/tmp/video.mp4')) as download:
            pipeline.download_video('url', Path('/tmp'), 720, {})
        self.assertEqual(download.call_args.args[1], 'android_vr')

    def test_download_flags_keep_whole_file_integrity_and_cap(self):
        command = pipeline._download_args('android_vr')
        self.assertIn('--abort-on-unavailable-fragments', command)
        self.assertEqual(command[command.index('--max-filesize') + 1], '2000000000')


    def test_muxed_size_includes_audio_and_is_marked_as_estimate(self):
        size = pipeline._selection_size({'duration': 60, 'requested_formats': [
            {'filesize': 20_000_000}, {'filesize': 1_000_000},
        ]})
        self.assertEqual(size, {'bytes': 21_000_000, 'estimated': True})

    def test_converted_audio_uses_output_bitrate_instead_of_source_size(self):
        size = pipeline._selection_size({'duration': 60, 'ext': 'webm', 'filesize': 9_000_000}, 'low')
        self.assertEqual(size, {'bytes': 480_000, 'estimated': True})
        self.assertIsNone(pipeline._selection_size({'duration': 60}))

    def test_size_selection_uses_cached_metadata_without_network_checks(self):
        selected = {'duration': 60, 'filesize': 12_000_000}
        with patch.object(pipeline, 'available_qualities', return_value=[720]), \
             patch.object(pipeline, 'audio_formats', return_value=[]), \
             patch.object(pipeline, '_run', return_value=subprocess.CompletedProcess([], 0, json.dumps(selected), '')) as run:
            sizes = pipeline.quality_sizes({'id': 'video'})
        command = run.call_args.args[0]
        self.assertIn('--load-info-json', command)
        self.assertIn('--no-check-formats', command)
        self.assertIn('res:720,+codec:avc:m4a,ext:mp4:m4a', command)
        self.assertEqual(sizes['720']['bytes'], 12_000_000)


if __name__ == '__main__':
    unittest.main()
