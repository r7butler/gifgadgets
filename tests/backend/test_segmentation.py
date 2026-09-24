import gzip
import io
import json
import struct
from unittest.mock import Mock

import numpy as np
from PIL import Image
import pytest

from backend.tracker.segmentation import (
    ConceptSegmenter, TrackerSegmenter, load_frames, segment_file,
    validate_objects, validate_prompt)
import backend.handler as h
from conftest import make_event

POINTS = [{'points': [{'x': .25, 'y': .5, 'label': 1}]}]


@pytest.mark.parametrize('adapter', [ConceptSegmenter, TrackerSegmenter])
def test_video_batches_fit_worker_without_changing_tracking_settings(adapter):
    from types import SimpleNamespace
    model = SimpleNamespace(batched_grounding_batch_size=16,
                            postprocess_batch_size=16, use_batched_grounding=True,
                            hotstart_delay=15, max_num_objects=32)
    adapter(model)
    assert model.batched_grounding_batch_size == 8
    assert model.postprocess_batch_size == 8
    assert model.use_batched_grounding is True
    assert model.hotstart_delay == 15
    assert model.max_num_objects == 32


def fake_segmenter(masks, stats=None):
    """A segmenter with the interface segment_file relies on and no model."""
    segmenter = Mock()
    segmenter.validate.side_effect = lambda prompt: prompt
    segmenter.stats.return_value = stats if stats is not None else {'objects': 1}
    if callable(masks):
        segmenter.masks.side_effect = masks
    else:
        segmenter.masks.return_value = masks
    return segmenter

@pytest.mark.parametrize('value', [None, [], [{'points': []}], [{'points': [{'x': 0, 'y': 0, 'label': 0}]}],
                         [{'points': [{'x': float('nan'), 'y': .5, 'label': 1}]}]])
def test_selection_validation(value):
    with pytest.raises(ValueError):
        validate_objects(value)


def test_pipeline_unions_objects_and_returns_every_frame(tmp_path):
    source, target = tmp_path / 'input.gif', tmp_path / 'masks.gz'
    images = [Image.new('RGB', (3, 2), color) for color in ('red', 'green', 'blue')]
    images[0].save(source, save_all=True, append_images=images[1:], duration=[70,130,250], loop=2)
    def masks(frames, objects):
        assert [f.size for f in frames] == [(3, 2)] * 3
        for index in range(3):
            union = np.zeros((2, 3), dtype=bool)
            # Two objects, one pixel each, so the packed byte proves the union.
            union[0, index] = True
            union[1, index] = True
            yield index, union
    segmenter = fake_segmenter(masks, {'objects': 2})
    stats = segment_file(source, target, POINTS + POINTS, segmenter)
    assert stats['frames'] == 3 and stats['objects'] == 2
    raw = gzip.decompress(target.read_bytes())
    size = struct.unpack('<I',raw[:4])[0]
    assert json.loads(raw[4:4+size]) == {'version':1,'width':3,'height':2,'frames':3}
    assert list(raw[4+size:]) == [0b10010000,0b01001000,0b00100100]
    segmenter.release.assert_called_once()


def test_progress_counts_every_frame_after_decoding(tmp_path):
    source = tmp_path / 'input.gif'
    images = [Image.new('RGB', (3, 2), color) for color in ('red', 'green', 'blue')]
    images[0].save(source, save_all=True, append_images=images[1:])
    union = np.ones((2, 3), dtype=bool)
    calls = []
    segment_file(source, tmp_path / 'masks.gz', POINTS,
                 fake_segmenter([(index, union) for index in range(3)]),
                 progress=lambda done, total: calls.append((done, total)))
    assert calls == [(0, 3), (1, 3), (2, 3), (3, 3)]


def test_incomplete_masks_fail_and_release_the_session(tmp_path):
    source = tmp_path / 'image.png'
    Image.new('RGB',(2,2)).save(source)
    segmenter = fake_segmenter([])
    with pytest.raises(ValueError,match='every frame'):
        segment_file(source,tmp_path/'out.gz',POINTS,segmenter)
    segmenter.release.assert_called_once()


def test_a_wrongly_shaped_or_repeated_mask_is_refused(tmp_path):
    source = tmp_path / 'image.png'
    Image.new('RGB', (4, 3)).save(source)
    for union, message in [(np.ones((9, 9), dtype=bool), 'unexpected mask dimensions'),
                           (np.ones((3, 4), dtype=bool), None)]:
        segmenter = fake_segmenter([(0, union)])
        if message:
            with pytest.raises(ValueError, match=message):
                segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)
        else:
            assert segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)['frames'] == 1
        segmenter.release.assert_called_once()
    # A frame delivered twice would silently overwrite the first result.
    segmenter = fake_segmenter([(0, np.zeros((3, 4), dtype=bool))] * 2)
    with pytest.raises(ValueError, match='invalid frame sequence'):
        segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)


def test_an_empty_mask_is_an_error_rather_than_a_blank_download(tmp_path):
    """Every pixel rejected means a fully transparent export. Say so instead."""
    source = tmp_path / 'image.png'
    Image.new('RGB', (4, 3)).save(source)
    segmenter = fake_segmenter([(0, np.zeros((3, 4), dtype=bool))])
    with pytest.raises(ValueError, match='Nothing matched'):
        segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)
    # One matched pixel anywhere is still a real cutout.
    partial = np.zeros((3, 4), dtype=bool); partial[1, 1] = True
    assert segment_file(source, tmp_path / 'out.gz', POINTS, fake_segmenter([(0, partial)]))['frames'] == 1


@pytest.mark.parametrize('value,message', [
    (None, 'Describe what to keep'), ('', 'Describe what to keep'),
    ('   ', 'Describe what to keep'), (42, 'Describe what to keep'),
    ('a' * 121, 'under 120 characters'), ('a\u0000b', 'control characters'),
    ('\u0007', 'control characters'),
])
def test_prompt_validation_rejects_what_should_not_reach_a_gpu(value, message):
    with pytest.raises(ValueError, match=message):
        validate_prompt(value)


def test_prompt_whitespace_is_normalised_so_one_phrase_is_one_prompt():
    assert validate_prompt('  a   yellow  school bus ') == 'a yellow school bus'
    assert validate_prompt('person') == 'person'
    # Line breaks are whitespace like any other, so they normalise rather than fail.
    assert validate_prompt('line\nbreak\ttab') == 'line break tab'
    assert len(validate_prompt('a' * 120)) == 120


def test_text_prompts_union_every_matching_instance():
    frames = [Image.new('RGB', (4, 2), 'red')]
    model = Mock()
    model.init_state.return_value = {}
    masks = np.zeros((3, 2, 4), dtype=bool)
    masks[0, 0, 0] = True; masks[1, 1, 3] = True
    model.add_prompt.return_value = (0, {'out_binary_masks': masks})
    segmenter = ConceptSegmenter(model)
    try:
        (index, union), = list(segmenter.masks(frames, 'school bus'))
        assert model.add_prompt.call_args.kwargs['text_str'] == 'school bus'
        assert model.init_state.call_args.kwargs['resource_path'].endswith('.png')
        model.propagate_in_video.assert_not_called()
        assert index == 0 and union.shape == (2, 4)
        assert union.tolist() == [[True, False, False, False], [False, False, False, True]]
        assert ConceptSegmenter.stats('school bus') == {'objects': 0, 'prompt_length': 10}
    finally:
        segmenter.release()
    model.reset_state.assert_called_once()


def test_frames_are_downscaled_but_reported_at_their_original_size(tmp_path):
    source = tmp_path / 'big.png'
    Image.new('RGB', (2048, 1024), 'red').save(source)
    frames, original = load_frames(source)
    assert original == (2048, 1024), 'stats must describe the file the user gave us'
    assert frames[0].size == (1024, 512), 'the model never sees more than MAX_SIDE'
    segmenter = fake_segmenter([(0, np.ones((512, 1024), dtype=bool))])
    stats = segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)
    assert (stats['width'], stats['height']) == (2048, 1024)


def test_unsupported_formats_never_reach_the_gpu(tmp_path):
    source = tmp_path / 'clip.bmp'
    Image.new('RGB', (4, 4)).save(source)
    segmenter = fake_segmenter([])
    with pytest.raises(ValueError, match='GIF, PNG, JPG or WebP'):
        segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)
    segmenter.masks.assert_not_called()


@pytest.fixture
def issued(monkeypatch, mock_aws):
    monkeypatch.setattr(h,'MODAL_SEGMENTER_URL','https://segment.test')
    remote=Mock(return_value={'call_id':'fc-test'})
    monkeypatch.setattr(h,'_segment_remote',remote)
    mock_aws['s3'].head_object.return_value={'ContentLength':100}
    response=h.handler(make_event('/api/segment/presign',{'content_type':'image/gif'}),None)
    assert response['statusCode']==200
    return json.loads(response['body'])['job_id'],remote,mock_aws


def test_broker_submits_private_urls_and_points(issued):
    job,remote,aws=issued
    response=h.handler(make_event('/api/segment/submit',{'job_id':job,'objects':POINTS,
        'input_url':'https://attacker.invalid','call_id':'fc-ignored'}),None)
    assert response['statusCode']==202
    route,payload=remote.call_args.args
    assert route=='/segment' and payload['objects']==POINTS
    assert payload['input_url']=='https://s3.test.com/presigned'
    aws['s3'].copy_object.assert_called_once()
    assert aws['s3'].copy_object.call_args.kwargs['Key'].endswith('.source')
    assert any(c.kwargs.get('ExpressionAttributeValues',{}).get(':call')=='fc-test' for c in aws['table'].update_item.call_args_list)


def test_broker_rejects_unknown_and_bad_selection(issued):
    job,remote,_=issued
    assert h.handler(make_event('/api/segment/submit',{'job_id':'f'*32,'objects':POINTS}),None)['statusCode']==400
    assert h.handler(make_event('/api/segment/submit',{'job_id':job,'objects':[]}),None)['statusCode']==400
    remote.assert_not_called()


def test_broker_masks_download_and_cancellation_cleanup(issued):
    job,remote,aws=issued
    aws['table'].get_item.return_value={}
    # The default fixture holds issued records in a side effect.
    item=aws['table'].get_item(Key={'job_id':job})['Item']
    item['call_id']='fc-test'
    remote.return_value={'state':'complete','stats':{'frames':5000}}
    response=h.handler(make_event('/api/segment/status',{'job_id':job}),None)
    body=json.loads(response['body'])
    assert body['stats']['frames']==5000 and 'mask_url' in body
    remote.assert_called_with('/status',{'call_id':'fc-test'})
    remote.return_value={'state':'cancelled'}
    response=h.handler(make_event('/api/segment/cancel',{'job_id':job}),None)
    assert json.loads(response['body'])['state']=='cancelled'
    assert any(c.kwargs['Key'].endswith('.masks.gz') for c in aws['s3'].delete_object.call_args_list)


def test_cancel_while_submit_is_pending_does_not_claim_success(issued):
    job,remote,_=issued
    assert h.handler(make_event('/api/segment/cancel',{'job_id':job}),None)['statusCode']==409
    remote.assert_not_called()

@pytest.mark.parametrize('size', [0, 100 * 1024 * 1024 + 1])
def test_invalid_upload_size_never_launches_compute(issued, size):
    job, remote, aws = issued
    aws['s3'].head_object.return_value = {'ContentLength': size}
    response = h.handler(make_event('/api/segment/submit', {'job_id': job, 'objects': POINTS}), None)
    assert response['statusCode'] == 400
    remote.assert_not_called()


def test_kill_switch_still_permits_cancellation(issued, monkeypatch):
    job, remote, aws = issued
    item = aws['table'].get_item(Key={'job_id': job})['Item']
    item['call_id'] = 'fc-test'
    monkeypatch.setattr(h, 'FEATURES_DISABLED', {'segment'})
    assert h.handler(make_event('/api/segment/submit', {'job_id': job, 'objects': POINTS}), None)['statusCode'] == 503
    remote.return_value = {'state': 'cancelled'}
    response = h.handler(make_event('/api/segment/cancel', {'job_id': job}), None)
    assert json.loads(response['body'])['state'] == 'cancelled'
    remote.assert_called_once_with('/cancel', {'call_id': 'fc-test'})


def test_keep_and_exclude_points_reach_the_model_for_their_subject(monkeypatch):
    import sys
    from types import SimpleNamespace
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(
        tensor=np.asarray, float32=np.float32, int32=np.int32))
    frames = [Image.new('RGB', (100, 50), 'red')]
    objects = [
        {'points': [{'x': .2, 'y': .4, 'label': 1}, {'x': .8, 'y': .6, 'label': 0}]},
        {'points': [{'x': .5, 'y': .5, 'label': 1}]},
    ]
    model = Mock()
    model.init_state.return_value = {}
    masks = np.zeros((2, 50, 100), dtype=bool)
    masks[0, :, :50] = True; masks[1, :, 50:] = True
    model.add_prompt.return_value = (0, {'out_binary_masks': masks})
    segmenter = TrackerSegmenter(model)
    try:
        (index, union), = list(segmenter.masks(frames, objects))
        prompts = [call.kwargs for call in model.add_prompt.call_args_list]
        assert [p['obj_id'] for p in prompts] == [1, 2]
        assert all(p['frame_idx'] == 0 and p['rel_coordinates'] for p in prompts)
        np.testing.assert_allclose(prompts[0]['points'], [[.2, .4], [.8, .6]])
        np.testing.assert_array_equal(prompts[0]['point_labels'], [1, 0])
        np.testing.assert_allclose(prompts[1]['points'], [[.5, .5]])
        assert index == 0 and union.shape == (50, 100) and union.all()
    finally:
        segmenter.release()
    model.reset_state.assert_called_once()


def test_releasing_without_a_session_is_harmless():
    TrackerSegmenter(Mock()).release()


def test_gif_adapter_preserves_all_frames_and_cleans_up_after_failure(tmp_path):
    from pathlib import Path
    source = tmp_path / 'input.gif'
    frames = [Image.new('RGB', (4, 2), color) for color in ('red', 'blue', 'green')]
    frames[0].save(source, save_all=True, append_images=frames[1:], duration=100)
    model = Mock()
    resources = []
    def init_state(**kwargs):
        resource = Path(kwargs['resource_path'])
        resources.append(resource)
        assert sorted(p.name for p in resource.iterdir()) == [f'{i:08d}.jpg' for i in range(3)]
        assert kwargs['offload_video_to_cpu'] is True
        return {'cached_frame_outputs': {}}
    model.init_state.side_effect = init_state
    model.add_prompt.side_effect = RuntimeError('inference failed')
    segmenter = ConceptSegmenter(model)
    with pytest.raises(RuntimeError, match='inference failed'):
        segment_file(source, tmp_path / 'out.gz', 'person', segmenter)
    assert not resources[0].exists()
    assert segmenter.session is None
    model.reset_state.assert_called_once()


def test_empty_frame_masks_keep_dimensions_and_evict_cached_outputs():
    model = Mock()
    state = {'cached_frame_outputs': {0: 'large mask'}}
    model.init_state.return_value = state
    model.add_prompt.return_value = (0, {})
    model.propagate_in_video.return_value = [(0, {'out_binary_masks': np.zeros((0, 2, 4), dtype=bool)})]
    segmenter = ConceptSegmenter(model)
    try:
        (index, mask), = list(segmenter.masks([Image.new('RGB', (4, 2))] * 2, 'person'))
        assert index == 0 and mask.shape == (2, 4) and not mask.any()
        assert state['cached_frame_outputs'] == {}
        assert model.propagate_in_video.call_args.kwargs['is_last_batch'] is True
    finally:
        segmenter.release()


def test_point_only_video_seeds_cache_for_frames_without_text_detections(monkeypatch):
    import sys
    from types import SimpleNamespace
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(
        tensor=np.asarray, float32=np.float32, int32=np.int32))
    model = Mock()
    state = {}
    model.init_state.return_value = state
    def prompt(**kwargs):
        assert state['cached_frame_outputs'] == {0: {}, 1: {}, 2: {}}
        return 0, {'out_binary_masks': np.ones((1, 2, 4), dtype=bool)}
    model.add_prompt.side_effect = prompt
    def propagate(session, **kwargs):
        for index in range(3):
            # Mirrors the upstream cache precondition for point-only propagation.
            count = 1 if index in session['cached_frame_outputs'] else 0
            yield index, {'out_binary_masks': np.ones((count, 2, 4), dtype=bool)}
    model.propagate_in_video.side_effect = propagate
    segmenter = TrackerSegmenter(model)
    try:
        outputs = list(segmenter.masks([Image.new('RGB', (4, 2))] * 3, POINTS))
        assert len(outputs) == 3 and all(mask.all() for _, mask in outputs)
    finally:
        segmenter.release()
